import { Router } from 'express';
import { z } from 'zod';
import { md } from '../context.js';
import { query, queryOne } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { authed, h, requireAdmin, requireAuth } from '../lib/http.js';
import { body, idParam, parse, queryOf } from '../lib/validate.js';
import { backfillProgress, runBackfill } from '../market/backfill.js';
import { marketHoursSchema, getSettings, settingsSchema, updateSettings } from '../services/settings.js';
import { getActiveAccount, grantPoints } from '../services/accounts.js';
import { computeStats } from '../stats/stats.js';
import { hub } from '../ws/hub.js';
import type { ReviewRow } from '../reviews/review.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get(
  '/users',
  h(async (req, res) => {
    const q = queryOf(req, z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }));
    const like = q.q ? `%${q.q.toLowerCase()}%` : '%';
    const rows = await query(
      `SELECT u.id, u.name, u.email, u.role, u.disabled, u.created_at, u.last_login_at,
              a.season, a.starting_points, a.cash_available, a.cash_reserved,
              (SELECT count(*)::int FROM trades t WHERE t.user_id = u.id AND t.mode = 'live') AS live_trades,
              (SELECT COALESCE(sum(net_pnl), 0)::bigint FROM trades t WHERE t.account_id = a.id) AS season_pnl
       FROM users u LEFT JOIN accounts a ON a.user_id = u.id AND a.mode = 'live' AND a.is_active
       WHERE lower(u.name) LIKE $1 OR lower(u.email) LIKE $1
       ORDER BY u.id DESC LIMIT $2`,
      [like, q.limit],
    );
    res.json({ users: rows });
  }),
);

adminRouter.get(
  '/users/:id',
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const user = await queryOne('SELECT id, name, email, role, disabled, created_at, last_login_at, onboarded FROM users WHERE id = $1', [id]);
    if (!user) throw notFound('User');
    const acc = await getActiveAccount(id, 'live');
    const trades = await query<any>(
      `SELECT t.*, r.flags FROM trades t LEFT JOIN trade_reviews r ON r.trade_id = t.id WHERE t.account_id = $1 ORDER BY t.exit_ts`,
      [acc.id],
    );
    const stats = computeStats(
      trades.map((t) => ({ id: t.id, entryTs: t.entry_ts.getTime(), exitTs: t.exit_ts.getTime(), netPnl: t.net_pnl, rMultiple: t.r_multiple === null ? null : Number(t.r_multiple), holdingSeconds: t.holding_seconds, setupTag: t.setup_tag, direction: t.direction, confidence: t.confidence, flags: (t.flags as ReviewRow['flags']) ?? [] })),
      acc.starting_points,
    );
    const ledger = await query('SELECT kind, amount, balance_after, note, created_at FROM points_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 30', [id]);
    const { equityCurve: _c, calendar: _cal, ...summary } = stats;
    res.json({ user, account: acc, stats: summary, ledger });
  }),
);

adminRouter.post(
  '/users/:id/grant',
  h(async (req, res) => {
    const input = body(req, z.object({ points: z.number().refine((n) => n !== 0, 'Amount cannot be zero').refine((n) => Math.abs(n) <= 100_000_000, 'Amount too large'), note: z.string().trim().min(3, 'Add a short note').max(300) }));
    const acc = await grantPoints(authed(req).id, parse(idParam, req.params.id), Math.round(input.points * 100), input.note);
    hub.sendToUser(acc.user_id, 'account', { mode: 'live', season: acc.season, pointsFree: acc.cash_available, pointsUsed: acc.cash_reserved, startingPoints: acc.starting_points, equity: acc.cash_available + acc.cash_reserved, unrealized: 0, id: acc.id });
    res.json({ account: acc });
  }),
);

adminRouter.patch(
  '/users/:id',
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const input = body(req, z.object({ disabled: z.boolean().optional(), role: z.enum(['user', 'admin']).optional() }));
    if (id === authed(req).id && (input.disabled || input.role === 'user')) throw badRequest('self_lockout', 'You cannot disable or demote yourself.');
    // Disabling bumps token_version so existing sessions end immediately.
    const u = await queryOne(
      `UPDATE users SET disabled = COALESCE($2, disabled), role = COALESCE($3, role),
         token_version = token_version + CASE WHEN $2::boolean IS TRUE THEN 1 ELSE 0 END
       WHERE id = $1 RETURNING id, name, email, role, disabled`,
      [id, input.disabled ?? null, input.role ?? null],
    );
    if (!u) throw notFound('User');
    res.json({ user: u });
  }),
);

adminRouter.get(
  '/settings',
  h(async (_req, res) => {
    const holidays = await query(`SELECT id, to_char(date, 'YYYY-MM-DD') AS date, description, closed, to_char(special_open, 'HH24:MI') AS special_open, to_char(special_close, 'HH24:MI') AS special_close FROM market_holidays ORDER BY date`);
    const instruments = await query('SELECT * FROM instruments ORDER BY sort_order, id');
    res.json({ settings: getSettings(), instruments, holidays });
  }),
);

adminRouter.put(
  '/settings',
  h(async (req, res) => {
    const patch = body(req, settingsSchema.partial().extend({ market_hours: marketHoursSchema.optional() }));
    const before = getSettings();
    const s = await updateSettings(patch, authed(req).id);
    const m = md();
    if (patch.rollover_days !== undefined && patch.rollover_days !== before.rollover_days) await m.onRolloverSettingChanged();
    res.json({ settings: s });
  }),
);

adminRouter.patch(
  '/instruments/:id',
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const input = body(
      req,
      z.object({
        product_symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,20}$/).optional(),
        display_name: z.string().trim().min(1).max(40).optional(),
        fallback_spread_paise: z.number().int().min(0).max(10_000_000).optional(),
        brokerage_paise: z.number().int().min(0).max(10_000_000).optional(),
        qty_step: z.number().int().positive().optional(),
        qty_min: z.number().int().positive().optional(),
        qty_max: z.number().int().positive().optional(),
        enabled: z.boolean().optional(),
      }),
    );
    const cur = await queryOne('SELECT * FROM instruments WHERE id = $1', [id]);
    if (!cur) throw notFound('Instrument');
    const next = { ...cur, ...input };
    if (next.qty_min % next.qty_step !== 0) throw badRequest('invalid_qty', 'Minimum quantity must be a multiple of the step.');
    const row = await queryOne(
      `UPDATE instruments SET product_symbol = $2, display_name = $3, fallback_spread_paise = $4, brokerage_paise = $5, qty_step = $6, qty_min = $7, qty_max = $8, enabled = $9 WHERE id = $1 RETURNING *`,
      [id, next.product_symbol, next.display_name, next.fallback_spread_paise, next.brokerage_paise, next.qty_step, next.qty_min, next.qty_max, next.enabled],
    );
    const m = md();
    await m.reloadInstruments();
    if (input.product_symbol && input.product_symbol !== cur.product_symbol) {
      // Track the new product: contracts are fetched and the switch is handled like a rollover.
      await m.syncContracts();
      await m.ensureActiveContracts();
    }
    res.json({ instrument: row });
  }),
);

adminRouter.post(
  '/holidays',
  h(async (req, res) => {
    const time = z.string().regex(/^\d{2}:\d{2}$/).nullish();
    const input = body(req, z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), description: z.string().max(100).default(''), closed: z.boolean().default(true), special_open: time, special_close: time }));
    if (!!input.special_open !== !!input.special_close) throw badRequest('invalid_session', 'Give both a special open and close time, or neither.');
    const row = await queryOne(
      `INSERT INTO market_holidays (date, description, closed, special_open, special_close) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (date) DO UPDATE SET description = EXCLUDED.description, closed = EXCLUDED.closed, special_open = EXCLUDED.special_open, special_close = EXCLUDED.special_close
       RETURNING id`,
      [input.date, input.description, input.closed, input.special_open ?? null, input.special_close ?? null],
    );
    await md().hours.loadHolidays();
    res.status(201).json({ id: row!.id });
  }),
);

adminRouter.delete(
  '/holidays/:id',
  h(async (req, res) => {
    await query('DELETE FROM market_holidays WHERE id = $1', [parse(idParam, req.params.id)]);
    await md().hours.loadHolidays();
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/feed-health',
  h(async (_req, res) => {
    const m = md();
    const jobs = await query(
      `SELECT j.interval, j.status, count(*)::int AS chunks, COALESCE(sum(j.candles_saved), 0)::int AS candles, max(j.updated_at) AS updated_at
       FROM backfill_jobs j GROUP BY j.interval, j.status ORDER BY j.interval, j.status`,
    );
    const candleCounts = await query(`SELECT i.code, c.interval, count(*)::int AS n, min(c.open_time) AS first, max(c.open_time) AS last FROM candles c JOIN instruments i ON i.id = c.instrument_id GROUP BY i.code, c.interval ORDER BY i.code, c.interval`);
    const ticks = await queryOne(`SELECT count(*)::int AS n, max(ts) AS last FROM price_ticks`);
    res.json({
      health: m.health(),
      backfill: { ...backfillProgress, jobs },
      storage: { candles: candleCounts, ticks },
      connectedUsers: hub.connectedUsers(),
      serverTime: new Date().toISOString(),
    });
  }),
);

adminRouter.post(
  '/backfill',
  h(async (_req, res) => {
    if (backfillProgress.running) throw badRequest('backfill_running', 'A backfill is already running.');
    runBackfill(md()).catch((err) => md().recordError(`Backfill failed: ${err.message}`));
    res.status(202).json({ started: true });
  }),
);

adminRouter.post(
  '/contracts/refresh',
  h(async (_req, res) => {
    const m = md();
    await m.syncContracts();
    await m.ensureActiveContracts();
    res.json({ health: m.health() });
  }),
);
