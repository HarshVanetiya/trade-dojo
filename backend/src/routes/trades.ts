import { Router } from 'express';
import { z } from 'zod';
import { md } from '../context.js';
import { query, queryOne } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { authed, h, requireAuth } from '../lib/http.js';
import { body, idParam, parse, queryOf } from '../lib/validate.js';
import { getCandles } from '../market/candles.js';
import type { Interval } from '../market/types.js';
import type { TradeRow } from '../engine/engine.js';
import { aiCoach, aiCoachEnabled, anonymizedPayload } from '../reviews/aiCoach.js';
import { generateReview, planVsOutcome, type ReviewRow } from '../reviews/review.js';
import { getActiveAccount } from '../services/accounts.js';
import { computeStats } from '../stats/stats.js';
import { RateLimiter } from '../lib/rateLimit.js';

const coachLimiter = new RateLimiter(10, 60 * 60_000);

export const tradeFilter = z.object({
  mode: z.enum(['live', 'replay']).default('live'),
  season: z.union([z.literal('current'), z.literal('all'), z.coerce.number().int().positive()]).default('current'),
  instrument: z.string().max(20).optional(),
  setupTag: z.string().max(30).optional(),
  direction: z.enum(['LONG', 'SHORT']).optional(),
  result: z.enum(['win', 'loss']).optional(),
  tag: z.string().max(40).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sessionId: z.coerce.number().int().optional(),
});
export type TradeFilter = z.infer<typeof tradeFilter>;

/** Build the WHERE clause for a user's trades. */
export async function tradeWhere(userId: number, f: TradeFilter) {
  const params: unknown[] = [userId, f.mode];
  const where = ['t.user_id = $1', 't.mode = $2'];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.season === 'current') add('t.season = ?', (await getActiveAccount(userId, f.mode)).season);
  else if (f.season !== 'all') add('t.season = ?', f.season);
  if (f.instrument) {
    const inst = md().instrumentByCode(f.instrument);
    add('t.instrument_id = ?', inst?.id ?? -1);
  }
  if (f.setupTag) add('t.setup_tag = ?', f.setupTag);
  if (f.direction) add('t.direction = ?', f.direction);
  if (f.result === 'win') where.push('t.net_pnl > 0');
  if (f.result === 'loss') where.push('t.net_pnl < 0');
  if (f.tag) add('? = ANY(n.tags)', f.tag);
  if (f.from) add(`t.exit_ts >= (?::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`, f.from);
  if (f.to) add(`t.exit_ts < ((?::date + 1))::timestamp AT TIME ZONE 'Asia/Kolkata'`, f.to);
  if (f.sessionId) add('t.replay_session_id = ?', f.sessionId);
  return { sql: where.join(' AND '), params };
}

type TradeWithReview = TradeRow & { flags: ReviewRow['flags'] | null; reflection: string | null; tags: string[] | null };

export async function loadTrades(userId: number, f: TradeFilter, limit = 1000, offset = 0): Promise<TradeWithReview[]> {
  const w = await tradeWhere(userId, f);
  return query<TradeWithReview>(
    `SELECT t.*, r.flags, n.reflection, n.tags FROM trades t
     LEFT JOIN trade_reviews r ON r.trade_id = t.id
     LEFT JOIN trade_notes n ON n.trade_id = t.id
     WHERE ${w.sql} ORDER BY t.exit_ts DESC, t.id DESC LIMIT ${Math.min(limit, 10000)} OFFSET ${Math.max(offset, 0)}`,
    w.params,
  );
}

export function tradeView(t: TradeWithReview | TradeRow) {
  const inst = md().instrument(t.instrument_id);
  const x = t as TradeWithReview;
  return {
    id: t.id,
    positionId: t.position_id,
    mode: t.mode,
    season: t.season,
    replaySessionId: t.replay_session_id,
    instrument: inst?.code,
    instrumentName: inst?.display_name,
    priceUnitLabel: inst?.price_unit_label,
    unitGrams: inst?.unit_grams,
    contract: t.contract_symbol,
    direction: t.direction,
    qty: t.qty_g,
    entryPrice: t.entry_price,
    exitPrice: t.exit_price,
    entryTs: t.entry_ts,
    exitTs: t.exit_ts,
    holdingSeconds: t.holding_seconds,
    entryNotional: t.entry_notional,
    grossPnl: t.gross_pnl,
    brokerage: t.brokerage,
    netPnl: t.net_pnl,
    pnlPct: t.pnl_pct,
    initialSl: t.initial_sl_price,
    initialTp: t.initial_tp_price,
    initialRisk: t.initial_risk,
    rMultiple: t.r_multiple,
    plannedRr: t.planned_rr,
    riskPct: t.risk_pct,
    exitReason: t.exit_reason,
    setupTag: t.setup_tag,
    planNote: t.plan_note,
    confidence: t.confidence,
    gapExit: t.gap_exit,
    bothTouched: t.both_touched,
    flags: x.flags?.map((f) => ({ code: f.code, title: f.title })) ?? [],
    reflection: x.reflection ?? '',
    tags: x.tags ?? [],
  };
}

/** Pick a chart interval that shows the whole trade with some context. */
function snapshotInterval(holdingSeconds: number): Interval {
  if (holdingSeconds < 2 * 3600) return '1m';
  if (holdingSeconds < 12 * 3600) return '5m';
  if (holdingSeconds < 3 * 86400) return '1h';
  return '1d';
}

export const tradesRouter = Router();
tradesRouter.use(requireAuth);

tradesRouter.get(
  '/trades',
  h(async (req, res) => {
    const q = queryOf(req, tradeFilter.extend({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }));
    const rows = await loadTrades(authed(req).id, q, q.limit, q.offset);
    res.json({ trades: rows.map(tradeView) });
  }),
);

tradesRouter.get(
  '/trades/:id',
  h(async (req, res) => {
    const user = authed(req);
    const id = parse(idParam, req.params.id);
    const trade = await queryOne<TradeWithReview>(
      `SELECT t.*, n.reflection, n.tags FROM trades t LEFT JOIN trade_notes n ON n.trade_id = t.id WHERE t.id = $1 AND t.user_id = $2`,
      [id, user.id],
    );
    if (!trade) throw notFound('Trade');
    let review = await queryOne<ReviewRow>('SELECT * FROM trade_reviews WHERE trade_id = $1', [id]);
    if (!review) review = await generateReview(md(), id);
    const fills = await query('SELECT side, qty_g AS qty, price, brokerage, realized_pnl AS "realizedPnl", reason, gap, ts FROM fills WHERE position_id = $1 ORDER BY ts, id', [trade.position_id]);
    const events = await query('SELECT kind, old_value AS "oldValue", new_value AS "newValue", ts FROM position_events WHERE position_id = $1 ORDER BY ts, id', [trade.position_id]);
    const interval = snapshotInterval(trade.holding_seconds);
    const dur = { '1m': 60_000, '5m': 300_000, '1h': 3_600_000, '1d': 86_400_000 }[interval as '1m'] ?? 60_000;
    let asOf: number | undefined;
    if (trade.mode === 'replay' && trade.replay_session_id) {
      const s = await queryOne<{ current_ts: Date }>('SELECT current_ts FROM replay_sessions WHERE id = $1', [trade.replay_session_id]);
      asOf = s?.current_ts.getTime();
    }
    const candles = await getCandles({
      instrumentId: trade.instrument_id,
      interval,
      from: trade.entry_ts.getTime() - 60 * dur,
      to: trade.exit_ts.getTime() + 30 * dur,
      limit: 400,
      asOf,
    });
    res.json({
      trade: tradeView(trade),
      review: {
        flags: review.flags,
        mfePrice: review.mfe_price,
        maePrice: review.mae_price,
        mfe: review.mfe_paise,
        mae: review.mae_paise,
        whatIfs: review.whatifs,
        whatIfComplete: review.whatif_complete,
        aiCoach: review.ai_coach,
        planVsOutcome: planVsOutcome(trade),
      },
      fills,
      events,
      chart: { interval, candles },
      aiCoachEnabled: aiCoachEnabled(),
    });
  }),
);

tradesRouter.put(
  '/trades/:id/notes',
  h(async (req, res) => {
    const user = authed(req);
    const id = parse(idParam, req.params.id);
    const input = body(req, z.object({ reflection: z.string().max(4000).default(''), tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]) }));
    const t = await queryOne('SELECT 1 FROM trades WHERE id = $1 AND user_id = $2', [id, user.id]);
    if (!t) throw notFound('Trade');
    await query(
      `INSERT INTO trade_notes (trade_id, user_id, reflection, tags, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (trade_id) DO UPDATE SET reflection = EXCLUDED.reflection, tags = EXCLUDED.tags, updated_at = now()`,
      [id, user.id, input.reflection, input.tags],
    );
    res.json({ ok: true });
  }),
);

tradesRouter.post(
  '/trades/:id/ai-coach',
  h(async (req, res) => {
    const user = authed(req);
    const id = parse(idParam, req.params.id);
    const trade = await queryOne<TradeRow>('SELECT * FROM trades WHERE id = $1 AND user_id = $2', [id, user.id]);
    if (!trade) throw notFound('Trade');
    coachLimiter.check(`coach:${user.id}`);
    const review = (await queryOne<ReviewRow>('SELECT * FROM trade_reviews WHERE trade_id = $1', [id])) ?? (await generateReview(md(), id));
    const text = await aiCoach(anonymizedPayload(trade, review, md().instrument(trade.instrument_id)?.display_name ?? 'Commodity'));
    await query('UPDATE trade_reviews SET ai_coach = $2 WHERE trade_id = $1', [id, text]);
    res.json({ aiCoach: text });
  }),
);

tradesRouter.get(
  '/stats',
  h(async (req, res) => {
    const user = authed(req);
    const f = queryOf(req, tradeFilter);
    const trades = await loadTrades(user.id, f, 10000);
    const acc = await getActiveAccount(user.id, f.mode);
    let starting = acc.starting_points;
    if (typeof f.season === 'number' && f.season !== acc.season) {
      const s = await queryOne<{ starting_points: number }>('SELECT starting_points FROM accounts WHERE user_id = $1 AND mode = $2 AND season = $3', [user.id, f.mode, f.season]);
      starting = s?.starting_points ?? starting;
    }
    const stats = computeStats(
      trades.map((t) => ({
        id: t.id,
        entryTs: t.entry_ts.getTime(),
        exitTs: t.exit_ts.getTime(),
        netPnl: t.net_pnl,
        rMultiple: t.r_multiple === null ? null : Number(t.r_multiple),
        holdingSeconds: t.holding_seconds,
        setupTag: t.setup_tag,
        direction: t.direction,
        confidence: t.confidence,
        flags: t.flags ?? [],
      })),
      starting,
      f.season === 'current' ? acc.created_at.getTime() : undefined,
    );
    const seasons = await query('SELECT season, is_active, created_at, closed_at, starting_points FROM accounts WHERE user_id = $1 AND mode = $2 ORDER BY season', [user.id, f.mode]);
    res.json({ stats, seasons });
  }),
);

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formula injection from user-written notes.
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rupees = (p: number | null) => (p === null ? '' : (p / 100).toFixed(2));

tradesRouter.get(
  '/journal/export.csv',
  h(async (req, res) => {
    const f = queryOf(req, tradeFilter);
    const trades = await loadTrades(authed(req).id, f, 10000);
    const header = ['trade_id', 'mode', 'season', 'instrument', 'contract', 'direction', 'qty_g', 'entry_time', 'exit_time', 'entry_price', 'exit_price', 'stop_loss', 'target', 'gross_pnl_points', 'brokerage_points', 'net_pnl_points', 'pnl_pct', 'r_multiple', 'risk_pct', 'holding_minutes', 'exit_reason', 'setup_tag', 'confidence', 'plan_note', 'flags', 'tags', 'reflection'];
    const lines = [header.join(',')];
    for (const t of trades) {
      const v = tradeView(t);
      lines.push([
        v.id, v.mode, v.season, v.instrument, v.contract, v.direction, v.qty, v.entryTs, v.exitTs,
        rupees(v.entryPrice), rupees(v.exitPrice), rupees(v.initialSl), rupees(v.initialTp), rupees(v.grossPnl), rupees(v.brokerage), rupees(v.netPnl),
        Number(v.pnlPct).toFixed(2), v.rMultiple === null ? '' : Number(v.rMultiple).toFixed(2), v.riskPct === null ? '' : Number(v.riskPct).toFixed(2),
        Math.round(v.holdingSeconds / 60), v.exitReason, v.setupTag, v.confidence, v.planNote, v.flags.map((x) => x.title).join('; '), v.tags.join('; '), v.reflection,
      ].map(csvCell).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tradedojo-journal-${f.mode}.csv"`);
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  }),
);
