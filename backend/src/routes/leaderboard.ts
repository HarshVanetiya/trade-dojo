import { Router } from 'express';
import { query } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { authed, h, requireAuth } from '../lib/http.js';
import { getSettings } from '../services/settings.js';
import { computeStats, riskAdjustedScore } from '../stats/stats.js';

export const leaderboardRouter = Router();

/** Optional leaderboard ranked by risk-adjusted return (return % / max drawdown %), not raw P&L. */
leaderboardRouter.get(
  '/leaderboard',
  requireAuth,
  h(async (req, res) => {
    const s = getSettings();
    if (!s.leaderboard_enabled) throw new AppError(404, 'leaderboard_disabled', 'The leaderboard is turned off.');
    const me = authed(req).id;
    const rows = await query<{ user_id: number; name: string; starting_points: number; id: number; exit_ts: Date; net_pnl: number }>(
      `SELECT a.user_id, u.name, a.starting_points, t.id, t.exit_ts, t.net_pnl
       FROM accounts a JOIN users u ON u.id = a.user_id AND NOT u.disabled
       JOIN trades t ON t.account_id = a.id
       WHERE a.mode = 'live' AND a.is_active
       ORDER BY t.exit_ts`,
    );
    const byUser = new Map<number, { name: string; start: number; trades: typeof rows }>();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, { name: r.name, start: r.starting_points, trades: [] });
      byUser.get(r.user_id)!.trades.push(r);
    }
    const out = [];
    for (const [userId, u] of byUser) {
      const st = computeStats(
        u.trades.map((t) => ({ id: t.id, entryTs: t.exit_ts.getTime(), exitTs: t.exit_ts.getTime(), netPnl: t.net_pnl, rMultiple: null, holdingSeconds: 0, setupTag: null, direction: 'LONG' as const, confidence: null, flags: [] })),
        u.start,
      );
      const score = riskAdjustedScore(st, s.leaderboard_min_trades);
      if (score === null) continue;
      // Show first name + initial only.
      const [first, last] = u.name.split(/\s+/);
      out.push({ name: last ? `${first} ${last[0]}.` : first, score, returnPct: st.returnPct, maxDrawdownPct: st.maxDrawdownPct, trades: st.trades, me: userId === me });
    }
    out.sort((a, b) => b.score - a.score);
    res.json({ rows: out.slice(0, 50), minTrades: s.leaderboard_min_trades });
  }),
);
