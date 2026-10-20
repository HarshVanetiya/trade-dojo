import { query, queryOne } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { pnl } from '../lib/money.js';
import { DAY, IST_OFFSET_MS, MINUTE, istDate } from '../lib/time.js';
import type { PositionRow, TradeRow } from '../engine/engine.js';
import { getCandles, stitchedRows } from '../market/candles.js';
import type { MarketData } from '../market/marketData.js';
import type { Candle } from '../market/types.js';
import { getSettings } from '../services/settings.js';
import { computeFlags, ema, type Flag } from './flags.js';
import { computeWhatIfs, type WhatIfs } from './whatif.js';

export interface ReviewRow {
  trade_id: number;
  flags: Flag[];
  mfe_price: number | null;
  mae_price: number | null;
  mfe_paise: number | null;
  mae_paise: number | null;
  whatifs: WhatIfs;
  whatif_complete: boolean;
  ai_coach: string | null;
  generated_at: Date;
  updated_at: Date;
}

const istDayStart = (t: number) => Math.floor((t + IST_OFFSET_MS) / DAY) * DAY - IST_OFFSET_MS;

async function tradeCandles(trade: TradeRow, from: number, to: number): Promise<Candle[]> {
  if (to <= from) return [];
  if (trade.contract_id) {
    const rows = await query<{ open_time: Date; o: number; h: number; l: number; c: number; volume: number; oi: number | null }>(
      `SELECT open_time, o, h, l, c, volume, oi FROM candles WHERE contract_id = $1 AND interval = '1m' AND open_time >= $2 AND open_time < $3 ORDER BY open_time`,
      [trade.contract_id, new Date(from), new Date(to)],
    );
    if (rows.length) return rows.map((r) => ({ openTime: r.open_time.getTime(), o: r.o, h: r.h, l: r.l, c: r.c, volume: r.volume, oi: r.oi }));
  }
  const rows = await stitchedRows(trade.instrument_id, '1m', from, to);
  return rows.map((r) => ({ openTime: r.open_time.getTime(), o: r.o, h: r.h, l: r.l, c: r.c, volume: r.volume, oi: r.oi }));
}

/** The instant up to which price data may be used for this trade (replay: the session's current time). */
async function reviewAsOf(md: MarketData, trade: TradeRow): Promise<number> {
  if (trade.mode === 'replay' && trade.replay_session_id) {
    const s = await queryOne<{ current_ts: Date; to_ts: Date; status: string }>('SELECT current_ts, to_ts, status FROM replay_sessions WHERE id = $1', [trade.replay_session_id]);
    // While the replay runs, never look past its clock; once it has ended the whole range may be used.
    if (s) return s.status === 'ended' ? s.to_ts.getTime() : s.current_ts.getTime();
  }
  return md.clock();
}

export async function generateReview(md: MarketData, tradeId: number): Promise<ReviewRow> {
  const trade = await queryOne<TradeRow>('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (!trade) throw notFound('Trade');
  const pos = (await queryOne<PositionRow>('SELECT * FROM positions WHERE id = $1', [trade.position_id]))!;
  const inst = md.instrument(trade.instrument_id)!;
  const settings = getSettings();
  const asOf = await reviewAsOf(md, trade);
  const entryTs = trade.entry_ts.getTime();
  const exitTs = trade.exit_ts.getTime();

  // Data never extends past asOf (replay must not reveal the future).
  const candles = (await tradeCandles(trade, entryTs - MINUTE, Math.min(exitTs + DAY + MINUTE, asOf))).filter((c) => c.openTime + MINUTE <= asOf);
  const { whatifs, complete } = computeWhatIfs({
    direction: trade.direction,
    qtyG: trade.qty_g,
    unitGrams: inst.unit_grams,
    entryPrice: trade.entry_price,
    entryTs,
    exitTs,
    exitReason: trade.exit_reason,
    initialSl: trade.initial_sl_price,
    initialTp: trade.initial_tp_price,
    candles,
    asOf,
  });

  const slChanges = await query<{ old_value: number | null; new_value: number | null }>(
    `SELECT old_value, new_value FROM position_events WHERE position_id = $1 AND kind = 'sl_changed' ORDER BY ts, id`,
    [trade.position_id],
  );
  const prior = await query<{ exit_ts: Date; net_pnl: number }>(
    `SELECT exit_ts, net_pnl FROM trades WHERE account_id = $1 AND id <> $2 AND exit_ts <= $3`,
    [trade.account_id, trade.id, trade.entry_ts],
  );
  const dayStart = istDayStart(entryTs);
  const sameDay = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM positions WHERE account_id = $1 AND opened_at >= $2 AND (opened_at < $3 OR (opened_at = $3 AND id <= $4))`,
    [trade.account_id, new Date(dayStart), trade.entry_ts, trade.position_id],
  );
  const daily = await getCandles({ instrumentId: trade.instrument_id, interval: '1d', to: dayStart, limit: 120, asOf: Math.min(dayStart, asOf) });
  const ema50 = ema(daily.map((d) => d.c), 50);
  const session = md.hours.session(istDate(entryTs));

  const flags = computeFlags({
    direction: trade.direction,
    entryPrice: trade.entry_price,
    entryTs,
    exitTs,
    exitReason: trade.exit_reason,
    netPnl: trade.net_pnl,
    grossPnl: trade.gross_pnl,
    initialSl: trade.initial_sl_price,
    initialTp: trade.initial_tp_price,
    initialRisk: trade.initial_risk,
    rMultiple: trade.r_multiple,
    plannedRr: trade.planned_rr,
    riskPct: trade.risk_pct,
    gapExit: trade.gap_exit,
    bothTouched: trade.both_touched,
    slChanges: slChanges.map((c) => ({ old: c.old_value, new: c.new_value })),
    priorClosed: prior.map((p) => ({ exitTs: p.exit_ts.getTime(), netPnl: p.net_pnl })),
    openedSameDay: sameDay?.n ?? 1,
    dailyEma50: ema50,
    session,
    targetReachedAfterExit: trade.exit_reason === 'manual' && whatifs.heldToTarget.outcome === 'target' ? true : null,
    riskWarnPct: settings.risk_warn_pct,
    overtradingLimit: settings.overtrading_limit,
  });

  const mfe = Math.max(0, pnl(trade.direction, trade.qty_g, trade.entry_price, pos.best_price, inst.unit_grams));
  const mae = Math.min(0, pnl(trade.direction, trade.qty_g, trade.entry_price, pos.worst_price, inst.unit_grams));
  const row = await queryOne<ReviewRow>(
    `INSERT INTO trade_reviews (trade_id, flags, mfe_price, mae_price, mfe_paise, mae_paise, whatifs, whatif_complete)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (trade_id) DO UPDATE SET flags = EXCLUDED.flags, mfe_price = EXCLUDED.mfe_price, mae_price = EXCLUDED.mae_price,
       mfe_paise = EXCLUDED.mfe_paise, mae_paise = EXCLUDED.mae_paise, whatifs = EXCLUDED.whatifs,
       whatif_complete = EXCLUDED.whatif_complete, updated_at = now()
     RETURNING *`,
    [trade.id, JSON.stringify(flags), pos.best_price, pos.worst_price, mfe, mae, JSON.stringify(whatifs), complete],
  );
  return row!;
}

/** Re-run reviews whose what-ifs were waiting for later data (live trades). */
export async function refreshPendingReviews(md: MarketData, limit = 50): Promise<number> {
  const rows = await query<{ trade_id: number }>(
    `SELECT r.trade_id FROM trade_reviews r JOIN trades t ON t.id = r.trade_id
     WHERE NOT r.whatif_complete AND t.mode = 'live' AND r.updated_at < now() - interval '10 minutes'
     ORDER BY r.updated_at LIMIT $1`,
    [limit],
  );
  for (const r of rows) await generateReview(md, r.trade_id);
  return rows.length;
}

export async function refreshSessionReviews(md: MarketData, sessionId: number) {
  const rows = await query<{ id: number }>(`SELECT id FROM trades WHERE replay_session_id = $1`, [sessionId]);
  for (const r of rows) await generateReview(md, r.id);
}

/** One-line outcome vs plan for the review screen. */
export function planVsOutcome(t: Pick<TradeRow, 'confidence' | 'net_pnl' | 'r_multiple' | 'exit_reason'>): string {
  const conf = t.confidence ?? 3;
  const won = t.net_pnl > 0;
  const r = t.r_multiple !== null ? `${t.r_multiple >= 0 ? '+' : ''}${Number(t.r_multiple).toFixed(2)}R` : 'no R (no stop)';
  if (won && conf >= 4) return `High confidence (${conf}/5) and a win (${r}). Note what made this setup clear so you can spot it again.`;
  if (won && conf <= 2) return `Low confidence (${conf}/5) but a win (${r}). Was it the setup or luck? Check whether your plan was followed.`;
  if (!won && conf >= 4) return `High confidence (${conf}/5) but a loss (${r}). Losses happen to good setups; check whether the plan was followed.`;
  if (!won && conf <= 2) return `Low confidence (${conf}/5) and a loss (${r}). Consider skipping trades you do not believe in.`;
  return `Medium confidence (${conf}/5), outcome ${won ? 'a win' : 'a loss'} (${r}).`;
}
