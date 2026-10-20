import type pg from 'pg';
import { type Db, pool, query, queryOne, tx } from '../db/pool.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { notional, pnl, proRata } from '../lib/money.js';
import { istDate } from '../lib/time.js';
import { contractById, type ContractRow, type InstrumentRow, rolloverNoticeDue } from '../market/contracts.js';
import type { MarketData, Quote, QuoteMeta } from '../market/marketData.js';
import { accountView, getActiveAccount, lockAccount, type Mode } from '../services/accounts.js';
import { applyLedger, type AccountRow } from '../services/ledger.js';
import { getSettings } from '../services/settings.js';
import { riskSummary } from './risk.js';
import {
  type Bar,
  barExtremes,
  barFromQuote,
  better,
  type Direction,
  entrySide,
  evaluateEntry,
  evaluateExit,
  exitSide,
  marketPrice,
  mergeBars,
  type OrderType,
  trailedStop,
  worse,
} from './rules.js';

export const SETUP_TAGS = ['Breakout', 'Pullback', 'Trend-follow', 'Reversal', 'News', 'Other'] as const;
export type SetupTag = (typeof SETUP_TAGS)[number];

export interface PositionRow {
  id: number;
  account_id: number;
  user_id: number;
  mode: Mode;
  replay_session_id: number | null;
  instrument_id: number;
  contract_id: number | null;
  direction: Direction;
  status: 'open' | 'closed';
  qty_initial_g: number;
  qty_open_g: number;
  avg_entry_price: number;
  reserved_paise: number;
  sl_price: number | null;
  tp_price: number | null;
  initial_sl_price: number | null;
  initial_tp_price: number | null;
  trail_paise: number | null;
  best_price: number;
  worst_price: number;
  realized_pnl: number;
  brokerage_total: number;
  exit_qty_g: number;
  exit_value: number;
  setup_tag: string | null;
  plan_note: string | null;
  confidence: number | null;
  order_id: number | null;
  opened_at: Date;
  closed_at: Date | null;
  exit_reason: string | null;
  had_gap_exit: boolean;
  rollover_notified: boolean;
  equity_at_entry: number | null;
  both_touched: boolean;
  entry_gap: boolean;
}

export interface OrderRow {
  id: number;
  account_id: number;
  user_id: number;
  mode: Mode;
  replay_session_id: number | null;
  instrument_id: number;
  contract_id: number | null;
  direction: Direction;
  order_type: OrderType;
  qty_g: number;
  trigger_price: number | null;
  sl_price: number | null;
  tp_price: number | null;
  trail_paise: number | null;
  reserved_paise: number;
  status: 'pending' | 'filled' | 'cancelled' | 'rejected';
  setup_tag: string | null;
  plan_note: string | null;
  confidence: number | null;
  position_id: number | null;
  cancel_reason: string | null;
  created_at: Date;
  market_ts: Date;
  filled_at: Date | null;
}

export interface TradeRow {
  id: number;
  position_id: number;
  account_id: number;
  user_id: number;
  mode: Mode;
  season: number;
  replay_session_id: number | null;
  instrument_id: number;
  contract_id: number | null;
  direction: Direction;
  qty_g: number;
  entry_price: number;
  exit_price: number;
  entry_ts: Date;
  exit_ts: Date;
  holding_seconds: number;
  entry_notional: number;
  gross_pnl: number;
  brokerage: number;
  net_pnl: number;
  pnl_pct: number;
  initial_sl_price: number | null;
  initial_tp_price: number | null;
  initial_risk: number | null;
  r_multiple: number | null;
  planned_rr: number | null;
  risk_pct: number | null;
  exit_reason: string;
  setup_tag: string | null;
  plan_note: string | null;
  confidence: number | null;
  both_touched: boolean;
  gap_exit: boolean;
  equity_at_entry: number | null;
  contract_symbol: string | null;
}

export interface PlaceOrderInput {
  mode: Mode;
  replaySessionId?: number | null;
  instrument: string;
  direction: Direction;
  orderType: OrderType;
  qtyG: number;
  triggerPrice?: number | null;
  slPrice?: number | null;
  tpPrice?: number | null;
  trailPaise?: number | null;
  setupTag: string;
  planNote: string;
  confidence: number;
}

/** Where the engine gets the current price for a replay session (provided by the replay service). */
export interface ReplayBridge {
  current(sessionId: number, userId: number): Promise<{ bar: Bar; instrumentId: number; accountId: number; contractId: number | null }>;
}

export interface Notifier {
  send(userId: number, type: string, data: unknown): void;
}

type Scope = { mode: 'live'; instrumentId: number; contractId: number } | { mode: 'replay'; sessionId: number };

export interface EngineEvents {
  onTradeClosed?: (tradeId: number) => Promise<void> | void;
}

const FILL_REASON_TEXT: Record<string, string> = {
  stop_loss: 'Stop-loss hit',
  trailing_stop: 'Trailing stop hit',
  target: 'Target hit',
  manual: 'Closed',
  rollover: 'Closed at contract expiry (rollover)',
  session_end: 'Closed when the replay session ended',
  entry: 'Order filled',
};

export class TradingEngine {
  private queues = new Map<number, { running: boolean; pending: { bar: Bar; contractId: number } | null }>();
  replay: ReplayBridge | null = null;
  events: EngineEvents = {};

  constructor(
    private md: MarketData,
    private notifier: Notifier = { send: () => {} },
  ) {}

  // ---- prices ---------------------------------------------------------------

  private inst(code: string): InstrumentRow {
    const i = this.md.instrumentByCode(code);
    if (!i || !i.enabled) throw notFound('Instrument');
    return i;
  }

  /** Current executable bar for a live instrument (requires an open market and fresh prices). */
  liveBar(inst: InstrumentRow): { bar: Bar; contractId: number } {
    const t = this.md.liveTradable(inst.id);
    if (!t.ok) throw new AppError(409, t.code!, t.message!);
    const q = this.md.getQuote(inst.id)!;
    return { bar: barFromQuote(q, inst.fallback_spread_paise, false), contractId: q.contractId };
  }

  private async currentBar(mode: Mode, inst: InstrumentRow, userId: number, sessionId?: number | null) {
    if (mode === 'live') return this.liveBar(inst);
    if (!sessionId || !this.replay) throw badRequest('replay_session_required', 'Start a replay session first.');
    const cur = await this.replay.current(sessionId, userId);
    if (cur.instrumentId !== inst.id) throw badRequest('wrong_instrument', 'This replay session is for a different instrument.');
    return { bar: cur.bar, contractId: cur.contractId, accountId: cur.accountId };
  }

  /** Mark price for unrealized P&L: where the position could be closed now. */
  markPrice(pos: Pick<PositionRow, 'direction' | 'instrument_id'>, quote: Quote | null, inst: InstrumentRow): number | null {
    if (!quote) return null;
    const bar = barFromQuote(quote, inst.fallback_spread_paise, false);
    return marketPrice(bar, exitSide(pos.direction));
  }

  // ---- orders ---------------------------------------------------------------

  async placeOrder(userId: number, input: PlaceOrderInput) {
    const inst = this.inst(input.instrument);
    validateQty(inst, input.qtyG);
    if (!SETUP_TAGS.includes(input.setupTag as SetupTag)) throw badRequest('setup_tag_required', 'Pick a setup tag for your trade plan.');
    if (!input.planNote || input.planNote.trim().length < 3) throw badRequest('plan_required', 'Write a short trade plan (why you are taking this trade).');
    if (!(input.confidence >= 1 && input.confidence <= 5)) throw badRequest('confidence_required', 'Set your confidence from 1 to 5.');

    const cur = await this.currentBar(input.mode, inst, userId, input.replaySessionId);
    const { bar, contractId } = cur;
    const side = entrySide(input.direction);
    const trigger = input.triggerPrice ?? null;
    if (input.orderType !== 'MARKET') {
      if (!trigger || trigger <= 0) throw badRequest('trigger_required', 'Enter the price for your limit/stop order.');
      validateTrigger(input.direction, input.orderType, trigger, bar);
    }
    const ref = input.orderType === 'MARKET' ? marketPrice(bar, side) : trigger!;
    const sl = input.slPrice ?? null;
    const tp = input.tpPrice ?? null;
    validateBrackets(input.direction, ref, sl, tp);
    const trail = input.trailPaise ?? null;
    if (trail !== null && trail <= 0) throw badRequest('invalid_trail', 'Trailing distance must be positive.');

    let account = await getActiveAccount(userId, input.mode);
    if (input.mode === 'replay' && 'accountId' in cur && cur.accountId !== account.id) account = (await queryOne<AccountRow>('SELECT * FROM accounts WHERE id = $1', [cur.accountId]))!;
    const settings = getSettings();
    const risk = riskSummary({ direction: input.direction, qtyG: input.qtyG, entry: ref, sl, tp, unitGrams: inst.unit_grams, equity: account.cash_available + account.cash_reserved, riskWarnPct: settings.risk_warn_pct });
    const ts = new Date(bar.ts);

    const result = await tx(async (c) => {
      const acc = await lockAccount(c, account.id);
      const need = notional(input.qtyG, ref, inst.unit_grams) + inst.brokerage_paise;
      if (acc.cash_available < need) {
        throw badRequest('insufficient_points', `Not enough free points: this needs ${fmt(need)} but you have ${fmt(acc.cash_available)} free.`);
      }
      const order = (await queryOne<OrderRow>(
        `INSERT INTO orders (account_id, user_id, mode, replay_session_id, instrument_id, contract_id, direction, order_type, qty_g,
           trigger_price, sl_price, tp_price, trail_paise, setup_tag, plan_note, confidence, market_ts, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending') RETURNING *`,
        [acc.id, userId, input.mode, input.replaySessionId ?? null, inst.id, contractId, input.direction, input.orderType, input.qtyG,
          trigger, sl, tp, trail, input.setupTag, input.planNote.trim(), input.confidence, ts],
        c,
      ))!;
      if (input.orderType === 'MARKET') {
        const position = await this.openPosition(c, acc, inst, order, ref, ts, false);
        return { order: { ...order, status: 'filled' as const, position_id: position.id, filled_at: ts }, position };
      }
      // Pending entries reserve their notional (plus brokerage) now, so free points can't be double-spent.
      await applyLedger(c, acc.id, { kind: 'reserve', available: -need, reserved: need, refType: 'order', refId: order.id, note: `Reserved for pending ${input.orderType} order` });
      const o = await queryOne<OrderRow>('UPDATE orders SET reserved_paise = $2 WHERE id = $1 RETURNING *', [order.id, need], c);
      return { order: o!, position: null };
    });

    if (result.position) this.notifyFill(userId, result.position, 'entry', ref);
    else this.notifier.send(userId, 'order', orderView(result.order));
    await this.pushAccount(userId, input.mode);
    return { order: orderView(result.order), position: result.position ? await this.positionView(result.position) : null, risk };
  }

  /** Opens a position from an order at `price` (inside the caller's transaction, account locked). */
  private async openPosition(c: pg.PoolClient, acc: AccountRow, inst: InstrumentRow, order: OrderRow, price: number, ts: Date, gap: boolean): Promise<PositionRow> {
    const value = notional(order.qty_g, price, inst.unit_grams);
    const brokerage = inst.brokerage_paise;
    if (acc.cash_available < value + brokerage) throw badRequest('insufficient_points', 'Not enough free points for this trade.');
    const equity = acc.cash_available + acc.cash_reserved;
    const pos = (await queryOne<PositionRow>(
      `INSERT INTO positions (account_id, user_id, mode, replay_session_id, instrument_id, contract_id, direction, qty_initial_g, qty_open_g,
         avg_entry_price, reserved_paise, sl_price, tp_price, initial_sl_price, initial_tp_price, trail_paise, best_price, worst_price,
         setup_tag, plan_note, confidence, order_id, opened_at, equity_at_entry, entry_gap, brokerage_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$11,$12,$13,$9,$9,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [acc.id, acc.user_id, order.mode, order.replay_session_id, inst.id, order.contract_id, order.direction, order.qty_g, price, value,
        order.sl_price, order.tp_price, order.trail_paise, order.setup_tag, order.plan_note, order.confidence, order.id, ts, equity, gap, brokerage],
      c,
    ))!;
    await applyLedger(c, acc.id, { kind: 'reserve', available: -value, reserved: value, refType: 'position', refId: pos.id, note: `Opened ${order.direction} ${order.qty_g} g ${inst.display_name}` });
    if (brokerage) await applyLedger(c, acc.id, { kind: 'brokerage', available: -brokerage, refType: 'position', refId: pos.id, note: 'Simulated brokerage (entry)' });
    await query(
      `INSERT INTO fills (account_id, user_id, position_id, order_id, mode, instrument_id, contract_id, side, qty_g, price, notional, brokerage, reason, gap, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'entry',$13,$14)`,
      [acc.id, acc.user_id, pos.id, order.id, order.mode, inst.id, order.contract_id, entrySide(order.direction), order.qty_g, price, value, brokerage, gap, ts],
      c,
    );
    await query(`UPDATE orders SET status = 'filled', filled_at = $2, position_id = $3 WHERE id = $1`, [order.id, ts, pos.id], c);
    return pos;
  }

  async cancelOrder(userId: number, orderId: number, reason = 'Cancelled by you') {
    const order = await tx(async (c) => {
      const o = await queryOne<OrderRow>('SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE', [orderId, userId], c);
      if (!o) throw notFound('Order');
      if (o.status !== 'pending') throw conflict('order_not_pending', 'This order is no longer pending.');
      return this.cancelOrderTx(c, o, reason);
    });
    this.notifier.send(userId, 'order', orderView(order));
    await this.pushAccount(userId, order.mode);
    return orderView(order);
  }

  private async cancelOrderTx(c: pg.PoolClient, o: OrderRow, reason: string, status: 'cancelled' | 'rejected' = 'cancelled'): Promise<OrderRow> {
    await lockAccount(c, o.account_id);
    if (o.reserved_paise) {
      await applyLedger(c, o.account_id, { kind: 'release', available: o.reserved_paise, reserved: -o.reserved_paise, refType: 'order', refId: o.id, note: `Order ${status}` });
    }
    return (await queryOne<OrderRow>(
      `UPDATE orders SET status = $2, cancel_reason = $3, cancelled_at = now(), reserved_paise = 0 WHERE id = $1 RETURNING *`,
      [o.id, status, reason],
      c,
    ))!;
  }

  // ---- positions ------------------------------------------------------------

  async modifyPosition(userId: number, positionId: number, patch: { slPrice?: number | null; tpPrice?: number | null; trailPaise?: number | null }) {
    const pos = await queryOne<PositionRow>('SELECT * FROM positions WHERE id = $1 AND user_id = $2', [positionId, userId]);
    if (!pos) throw notFound('Position');
    if (pos.status !== 'open') throw conflict('position_closed', 'This position is already closed.');
    const inst = this.md.instrument(pos.instrument_id)!;
    // Validate against the current exit price when we have one (stops must be on the losing side of price).
    let mark: number | null = null;
    if (pos.mode === 'live') mark = this.markPrice(pos, this.md.getQuote(pos.instrument_id), inst);
    else if (pos.replay_session_id && this.replay) {
      const cur = await this.replay.current(pos.replay_session_id, userId);
      mark = marketPrice(cur.bar, exitSide(pos.direction));
    }
    const sl = patch.slPrice === undefined ? pos.sl_price : patch.slPrice;
    const tp = patch.tpPrice === undefined ? pos.tp_price : patch.tpPrice;
    validateBrackets(pos.direction, mark ?? pos.avg_entry_price, sl, tp, mark !== null ? 'current price' : 'entry price');
    const trail = patch.trailPaise === undefined ? pos.trail_paise : patch.trailPaise;
    if (trail !== null && trail <= 0) throw badRequest('invalid_trail', 'Trailing distance must be positive.');
    const ts = new Date(pos.mode === 'live' ? this.md.clock() : Date.now());
    const updated = await tx(async (c) => {
      const p = await queryOne<PositionRow>('SELECT * FROM positions WHERE id = $1 FOR UPDATE', [positionId], c);
      if (!p || p.status !== 'open') throw conflict('position_closed', 'This position is already closed.');
      const events: Array<[string, number | null, number | null]> = [];
      if (sl !== p.sl_price) events.push(['sl_changed', p.sl_price, sl]);
      if (tp !== p.tp_price) events.push(['tp_changed', p.tp_price, tp]);
      if (trail !== p.trail_paise) events.push(['trail_changed', p.trail_paise, trail]);
      for (const [kind, oldV, newV] of events) {
        await query('INSERT INTO position_events (position_id, kind, old_value, new_value, ts) VALUES ($1,$2,$3,$4,$5)', [p.id, kind, oldV, newV, ts], c);
      }
      return (await queryOne<PositionRow>('UPDATE positions SET sl_price = $2, tp_price = $3, trail_paise = $4 WHERE id = $1 RETURNING *', [p.id, sl, tp, trail], c))!;
    });
    const view = await this.positionView(updated);
    this.notifier.send(userId, 'position', view);
    return view;
  }

  /** Manual full or partial close at the current market price. */
  async closePosition(userId: number, positionId: number, qtyG?: number) {
    const pos = await queryOne<PositionRow>('SELECT * FROM positions WHERE id = $1 AND user_id = $2', [positionId, userId]);
    if (!pos) throw notFound('Position');
    if (pos.status !== 'open') throw conflict('position_closed', 'This position is already closed.');
    const inst = this.md.instrument(pos.instrument_id)!;
    const qty = qtyG ?? pos.qty_open_g;
    if (qty <= 0 || qty > pos.qty_open_g) throw badRequest('invalid_qty', `You can close between ${inst.qty_step} g and ${pos.qty_open_g} g.`);
    if (qty % inst.qty_step !== 0) throw badRequest('invalid_qty', `Quantity must be a multiple of ${inst.qty_step} g.`);
    const remaining = pos.qty_open_g - qty;
    if (remaining > 0 && remaining < inst.qty_min) throw badRequest('invalid_qty', `A partial close must leave at least ${inst.qty_min} g open.`);
    let bar: Bar;
    if (pos.mode === 'live') {
      const live = this.liveBar(inst);
      if (pos.contract_id && live.contractId !== pos.contract_id) throw conflict('contract_rolled', 'This contract has rolled over.');
      bar = live.bar;
    } else {
      if (!pos.replay_session_id || !this.replay) throw badRequest('replay_session_required', 'Replay session not found.');
      bar = (await this.replay.current(pos.replay_session_id, userId)).bar;
    }
    const price = marketPrice(bar, exitSide(pos.direction));
    const out = await this.closeAt(pos.id, qty, price, new Date(bar.ts), 'manual', false, false);
    return out;
  }

  /** Close (part of) a position at a given price in its own transaction; returns the trade when fully closed. */
  async closeAt(positionId: number, qty: number | null, price: number, ts: Date, reason: string, gap: boolean, bothTouched: boolean) {
    const res = await tx(async (c) => {
      const pos = await queryOne<PositionRow>('SELECT * FROM positions WHERE id = $1 FOR UPDATE', [positionId], c);
      if (!pos || pos.status !== 'open') return null;
      const acc = await lockAccount(c, pos.account_id);
      return this.closeTx(c, acc, pos, qty ?? pos.qty_open_g, price, ts, reason, gap, bothTouched);
    });
    if (!res) return null;
    this.notifyFill(res.position.user_id, res.position, reason, price, res.fillPnl);
    await this.pushAccount(res.position.user_id, res.position.mode);
    if (res.trade) await this.tradeClosed(res.trade);
    return { position: await this.positionView(res.position), trade: res.trade };
  }

  private async closeTx(c: pg.PoolClient, acc: AccountRow, pos: PositionRow, qty: number, price: number, ts: Date, reason: string, gap: boolean, bothTouched: boolean) {
    const inst = this.md.instrument(pos.instrument_id)!;
    const release = proRata(pos.reserved_paise, qty, pos.qty_open_g);
    let realized = pnl(pos.direction, qty, pos.avg_entry_price, price, inst.unit_grams);
    let brokerage = inst.brokerage_paise;
    // Balances can never go negative: an (extreme) loss larger than everything left is capped.
    const floor = acc.cash_available + release;
    if (floor + realized - brokerage < 0) {
      brokerage = Math.min(brokerage, Math.max(0, floor + realized));
      if (floor + realized - brokerage < 0) realized = -(floor - brokerage);
    }
    const ref = { refType: 'position', refId: pos.id };
    await applyLedger(c, acc.id, { kind: 'release', available: release, reserved: -release, ...ref, note: `Released ${qty} g` });
    if (realized) await applyLedger(c, acc.id, { kind: 'realized_pnl', available: realized, ...ref, note: FILL_REASON_TEXT[reason] ?? reason });
    if (brokerage) await applyLedger(c, acc.id, { kind: 'brokerage', available: -brokerage, ...ref, note: 'Simulated brokerage (exit)' });
    await query(
      `INSERT INTO fills (account_id, user_id, position_id, order_id, mode, instrument_id, contract_id, side, qty_g, price, notional, brokerage, realized_pnl, reason, gap, ts)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [acc.id, pos.user_id, pos.id, pos.mode, pos.instrument_id, pos.contract_id, exitSide(pos.direction), qty, price, notional(qty, price, inst.unit_grams), brokerage, realized, reason, gap, ts],
      c,
    );
    const left = pos.qty_open_g - qty;
    const updated = (await queryOne<PositionRow>(
      `UPDATE positions SET qty_open_g = $2::bigint, reserved_paise = reserved_paise - $3, realized_pnl = realized_pnl + $4,
         brokerage_total = brokerage_total + $5, exit_qty_g = exit_qty_g + $6, exit_value = exit_value + $7,
         best_price = $8, worst_price = $9,
         had_gap_exit = had_gap_exit OR $10, both_touched = both_touched OR $11,
         status = CASE WHEN $2::bigint = 0 THEN 'closed' ELSE status END,
         closed_at = CASE WHEN $2::bigint = 0 THEN $12::timestamptz ELSE closed_at END,
         exit_reason = CASE WHEN $2::bigint = 0 THEN $13::text ELSE exit_reason END
       WHERE id = $1 RETURNING *`,
      [pos.id, left, release, realized, brokerage, qty, price * qty, better(pos.direction, pos.best_price, price), worse(pos.direction, pos.worst_price, price), gap, bothTouched, ts, reason],
      c,
    ))!;
    let trade: TradeRow | null = null;
    if (left === 0) trade = await this.createTrade(c, acc, updated, inst);
    return { position: updated, trade, fillPnl: realized };
  }

  private async createTrade(c: pg.PoolClient, acc: AccountRow, p: PositionRow, inst: InstrumentRow): Promise<TradeRow> {
    const exitPrice = Math.round(p.exit_value / p.exit_qty_g);
    const entryNotional = notional(p.qty_initial_g, p.avg_entry_price, inst.unit_grams);
    const net = p.realized_pnl - p.brokerage_total;
    const risk = p.initial_sl_price !== null ? Math.abs(pnl(p.direction, p.qty_initial_g, p.avg_entry_price, p.initial_sl_price, inst.unit_grams)) : null;
    const reward = p.initial_tp_price !== null ? Math.abs(pnl(p.direction, p.qty_initial_g, p.avg_entry_price, p.initial_tp_price, inst.unit_grams)) : null;
    const contract = p.contract_id ? await contractById(p.contract_id, c) : null;
    const holding = Math.max(0, Math.round((p.closed_at!.getTime() - p.opened_at.getTime()) / 1000));
    return (await queryOne<TradeRow>(
      `INSERT INTO trades (position_id, account_id, user_id, mode, season, replay_session_id, instrument_id, contract_id, direction, qty_g,
         entry_price, exit_price, entry_ts, exit_ts, holding_seconds, entry_notional, gross_pnl, brokerage, net_pnl, pnl_pct,
         initial_sl_price, initial_tp_price, initial_risk, r_multiple, planned_rr, risk_pct, exit_reason, setup_tag, plan_note, confidence,
         both_touched, gap_exit, equity_at_entry, contract_symbol)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)
       RETURNING *`,
      [p.id, acc.id, p.user_id, p.mode, acc.season, p.replay_session_id, p.instrument_id, p.contract_id, p.direction, p.qty_initial_g,
        p.avg_entry_price, exitPrice, p.opened_at, p.closed_at, holding, entryNotional, p.realized_pnl, p.brokerage_total, net,
        entryNotional ? (net / entryNotional) * 100 : 0,
        p.initial_sl_price, p.initial_tp_price, risk, risk ? net / risk : null, risk && reward !== null ? reward / risk : null,
        risk !== null && p.equity_at_entry ? (risk / p.equity_at_entry) * 100 : null,
        p.exit_reason, p.setup_tag, p.plan_note, p.confidence, p.both_touched, p.had_gap_exit, p.equity_at_entry, contract?.trading_symbol ?? null],
      c,
    ))!;
  }

  private async tradeClosed(trade: TradeRow) {
    try {
      await this.events.onTradeClosed?.(trade.id);
    } catch (err) {
      console.error('[engine] review generation failed', err);
    }
  }

  // ---- trigger engine -------------------------------------------------------

  /** Live quotes are processed one at a time per instrument; bars that arrive meanwhile are merged. */
  onLiveQuote(q: Quote, meta: QuoteMeta) {
    const inst = this.md.instrument(q.instrumentId);
    if (!inst) return;
    const bar = barFromQuote(q, inst.fallback_spread_paise, meta.sessionFirst);
    let st = this.queues.get(inst.id);
    if (!st) {
      st = { running: false, pending: null };
      this.queues.set(inst.id, st);
    }
    st.pending = st.pending && st.pending.contractId === q.contractId ? { bar: mergeBars(st.pending.bar, bar), contractId: q.contractId } : { bar, contractId: q.contractId };
    if (!st.running) void this.drain(inst.id);
  }

  private async drain(instrumentId: number) {
    const st = this.queues.get(instrumentId)!;
    st.running = true;
    try {
      while (st.pending) {
        const job = st.pending;
        st.pending = null;
        try {
          await this.processBar({ mode: 'live', instrumentId, contractId: job.contractId }, job.bar);
        } catch (err) {
          this.md.recordError(`Trigger engine error: ${(err as Error).message}`);
        }
      }
    } finally {
      st.running = false;
    }
  }

  /** Waits until queued live quotes have been processed (tests, shutdown). */
  async idle() {
    for (;;) {
      const busy = [...this.queues.values()].some((q) => q.running || q.pending);
      if (!busy) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /**
   * Run triggers for one bar: pending entries, then stop-losses, then targets, then trailing stops
   * and MFE/MAE tracking. Only orders/positions that existed before this bar are considered.
   */
  async processBar(scope: Scope, bar: Bar): Promise<{ fills: number }> {
    const ts = new Date(bar.ts);
    const where = scope.mode === 'live'
      ? { sql: `mode = 'live' AND instrument_id = $1 AND contract_id = $2`, params: [scope.instrumentId, scope.contractId] }
      : { sql: `replay_session_id = $1`, params: [scope.sessionId] };
    let fills = 0;
    const n = where.params.length;

    const orders = await query<OrderRow>(`SELECT * FROM orders WHERE status = 'pending' AND ${where.sql} AND market_ts < $${n + 1} ORDER BY id`, [...where.params, ts]);
    for (const o of orders) {
      const hit = evaluateEntry({ direction: o.direction, orderType: o.order_type, trigger: o.trigger_price! }, bar);
      if (hit && (await this.fillPendingOrder(o, hit.price, ts, hit.gap))) fills++;
    }

    const positions = await query<PositionRow>(`SELECT * FROM positions WHERE status = 'open' AND ${where.sql} AND opened_at < $${n + 1} ORDER BY id`, [...where.params, ts]);
    for (const p of positions) {
      const trailing = p.trail_paise !== null && p.sl_price !== null && p.sl_price !== p.initial_sl_price;
      const exit = evaluateExit({ direction: p.direction, sl: p.sl_price, tp: p.tp_price, trailing }, bar);
      if (exit) {
        await this.closeAt(p.id, null, exit.price, ts, exit.reason, exit.gap, exit.bothTouched);
        fills++;
        continue;
      }
      // Still open: track excursions and trail the stop (after the exit check, so a bar can't both move and hit it).
      const ext = barExtremes(p.direction, bar);
      const best = better(p.direction, p.best_price, ext.best);
      const worst = worse(p.direction, p.worst_price, ext.worst);
      const sl = p.trail_paise ? trailedStop(p.direction, p.sl_price, best, p.trail_paise) : p.sl_price;
      if (best !== p.best_price || worst !== p.worst_price || sl !== p.sl_price) {
        await query(`UPDATE positions SET best_price = $2, worst_price = $3, sl_price = $4 WHERE id = $1 AND status = 'open'`, [p.id, best, worst, sl]);
        if (sl !== p.sl_price) this.notifier.send(p.user_id, 'position', { id: p.id, slPrice: sl, trailed: true });
      }
    }
    return { fills };
  }

  private async fillPendingOrder(o: OrderRow, price: number, ts: Date, gap: boolean): Promise<boolean> {
    const inst = this.md.instrument(o.instrument_id)!;
    let rejected: OrderRow | null = null;
    const pos = await tx(async (c) => {
      const cur = await queryOne<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [o.id], c);
      if (!cur || cur.status !== 'pending') return null;
      await lockAccount(c, cur.account_id);
      // Swap the order's reservation for the position's actual notional.
      await applyLedger(c, cur.account_id, { kind: 'release', available: cur.reserved_paise, reserved: -cur.reserved_paise, refType: 'order', refId: cur.id, note: 'Order triggered' });
      await query('UPDATE orders SET reserved_paise = 0 WHERE id = $1', [cur.id], c);
      const acc = await lockAccount(c, cur.account_id);
      if (acc.cash_available < notional(cur.qty_g, price, inst.unit_grams) + inst.brokerage_paise) {
        rejected = (await queryOne<OrderRow>(`UPDATE orders SET status = 'rejected', cancel_reason = 'Not enough free points when the order triggered', cancelled_at = now() WHERE id = $1 RETURNING *`, [cur.id], c))!;
        return null;
      }
      return this.openPosition(c, acc, inst, cur, price, ts, gap);
    });
    if (rejected) {
      this.notifier.send(o.user_id, 'order', orderView(rejected));
      await this.pushAccount(o.user_id, o.mode);
      return false;
    }
    if (!pos) return false;
    this.notifyFill(o.user_id, pos, 'entry', price);
    await this.pushAccount(o.user_id, o.mode);
    return true;
  }

  // ---- rollover ------------------------------------------------------------

  /**
   * Simulated contract expiry: close live positions on the old contract at its last price and cancel
   * pending orders on it. Users can re-enter on the new contract.
   */
  async handleRollover(inst: InstrumentRow, from: ContractRow, to: ContractRow) {
    const price = await this.lastPrice(inst, from);
    const positions = await query<PositionRow>(`SELECT * FROM positions WHERE status = 'open' AND mode = 'live' AND contract_id = $1`, [from.id]);
    if (positions.length && !price) throw new Error(`No last price known for ${from.trading_symbol}; cannot close positions for rollover`);
    const ts = new Date(this.md.clock());
    for (const p of positions) {
      await this.closeAt(p.id, null, price!, ts, 'rollover', false, false);
      this.notifier.send(p.user_id, 'rollover', {
        instrument: inst.code,
        from: from.trading_symbol,
        to: to.trading_symbol,
        positionId: p.id,
        message: `${from.trading_symbol} expired for practice purposes. Your ${inst.display_name} position was closed at the last price. You can re-enter on ${to.trading_symbol}.`,
      });
    }
    const orders = await query<OrderRow>(`SELECT * FROM orders WHERE status = 'pending' AND mode = 'live' AND contract_id = $1`, [from.id]);
    for (const o of orders) {
      const cancelled = await tx((c) => this.cancelOrderTx(c, o, `Contract ${from.trading_symbol} rolled over to ${to.trading_symbol}`));
      this.notifier.send(o.user_id, 'order', orderView(cancelled));
      await this.pushAccount(o.user_id, 'live');
    }
  }

  private async lastPrice(inst: InstrumentRow, contract: ContractRow): Promise<number | null> {
    const q = this.md.getQuote(inst.id);
    if (q && q.contractId === contract.id) return q.ltp;
    const tick = await queryOne<{ ltp: number }>('SELECT ltp FROM price_ticks WHERE contract_id = $1 ORDER BY ts DESC LIMIT 1', [contract.id]);
    if (tick) return tick.ltp;
    const candle = await queryOne<{ c: number }>(`SELECT c FROM candles WHERE contract_id = $1 ORDER BY open_time DESC LIMIT 1`, [contract.id]);
    return candle?.c ?? null;
  }

  /** Warn users holding positions on a contract that will roll over soon (once per position). */
  async sendRolloverNotices(today = istDate(this.md.clock())) {
    const noticeDays = getSettings().rollover_notice_days;
    const rows = await query<PositionRow & { c_rollover: string; c_symbol: string }>(
      `SELECT p.*, to_char(c.rollover_date, 'YYYY-MM-DD') AS c_rollover, c.trading_symbol AS c_symbol
       FROM positions p JOIN contracts c ON c.id = p.contract_id
       WHERE p.status = 'open' AND p.mode = 'live' AND NOT p.rollover_notified`,
    );
    for (const p of rows) {
      if (!rolloverNoticeDue({ rollover_date: p.c_rollover }, noticeDays, today)) continue;
      await query('UPDATE positions SET rollover_notified = TRUE WHERE id = $1', [p.id]);
      this.notifier.send(p.user_id, 'rollover', {
        positionId: p.id,
        notice: true,
        message: `Heads up: ${p.c_symbol} rolls over on ${p.c_rollover}. Open positions on it will be closed at the last price that day.`,
      });
    }
  }

  // ---- views ----------------------------------------------------------------

  async positionView(p: PositionRow, mark?: number | null) {
    const inst = this.md.instrument(p.instrument_id)!;
    let m = mark;
    if (m === undefined && p.status === 'open' && p.mode === 'live') {
      const q = this.md.getQuote(p.instrument_id);
      m = q && q.contractId === p.contract_id ? this.markPrice(p, q, inst) : null;
    }
    const unrealized = p.status === 'open' && m ? pnl(p.direction, p.qty_open_g, p.avg_entry_price, m, inst.unit_grams) : 0;
    const contract = p.contract_id ? await contractById(p.contract_id) : null;
    const noticeDue = contract && p.status === 'open' && p.mode === 'live' ? rolloverNoticeDue(contract, getSettings().rollover_notice_days, istDate(this.md.clock())) : false;
    return {
      id: p.id,
      mode: p.mode,
      replaySessionId: p.replay_session_id,
      instrument: inst.code,
      instrumentName: inst.display_name,
      priceUnitLabel: inst.price_unit_label,
      unitGrams: inst.unit_grams,
      contract: contract ? { symbol: contract.trading_symbol, expiry: contract.expiry, rolloverDate: contract.rollover_date } : null,
      direction: p.direction,
      status: p.status,
      qtyInitial: p.qty_initial_g,
      qtyOpen: p.qty_open_g,
      avgEntry: p.avg_entry_price,
      slPrice: p.sl_price,
      tpPrice: p.tp_price,
      trailPaise: p.trail_paise,
      pointsUsed: p.reserved_paise,
      realizedPnl: p.realized_pnl,
      brokerage: p.brokerage_total,
      markPrice: m ?? null,
      unrealizedPnl: unrealized,
      setupTag: p.setup_tag,
      planNote: p.plan_note,
      confidence: p.confidence,
      openedAt: p.opened_at,
      closedAt: p.closed_at,
      exitReason: p.exit_reason,
      rolloverNotice: noticeDue && contract ? `This contract rolls over on ${contract.rollover_date}. The position will be closed at the last price that day.` : null,
    };
  }

  async listPositions(userId: number, mode: Mode, opts: { sessionId?: number; status?: 'open' | 'closed' } = {}) {
    const params: unknown[] = [userId, mode, opts.status ?? 'open'];
    let sql = `SELECT * FROM positions WHERE user_id = $1 AND mode = $2 AND status = $3`;
    if (opts.sessionId) {
      params.push(opts.sessionId);
      sql += ` AND replay_session_id = $4`;
    }
    const rows = await query<PositionRow>(`${sql} ORDER BY opened_at DESC LIMIT 200`, params);
    let mark: Map<number, number> | null = null;
    if (mode === 'replay' && opts.sessionId && this.replay) {
      const cur = await this.replay.current(opts.sessionId, userId).catch(() => null);
      if (cur) {
        mark = new Map();
        for (const r of rows) mark.set(r.id, marketPrice(cur.bar, exitSide(r.direction)));
      }
    }
    return Promise.all(rows.map((r) => this.positionView(r, mark ? (mark.get(r.id) ?? null) : undefined)));
  }

  async listOrders(userId: number, mode: Mode, opts: { sessionId?: number; status?: string } = {}) {
    const params: unknown[] = [userId, mode];
    let sql = `SELECT * FROM orders WHERE user_id = $1 AND mode = $2`;
    if (opts.status) {
      params.push(opts.status);
      sql += ` AND status = $${params.length}`;
    }
    if (opts.sessionId) {
      params.push(opts.sessionId);
      sql += ` AND replay_session_id = $${params.length}`;
    }
    const rows = await query<OrderRow>(`${sql} ORDER BY created_at DESC LIMIT 200`, params);
    return rows.map((o) => ({ ...orderView(o), instrument: this.md.instrument(o.instrument_id)?.code }));
  }

  async accountSnapshot(userId: number, mode: Mode, db: Db = pool) {
    const acc = await getActiveAccount(userId, mode, db);
    let unrealized = 0;
    if (mode === 'live') {
      const open = await query<PositionRow>(`SELECT * FROM positions WHERE account_id = $1 AND status = 'open'`, [acc.id], db);
      for (const p of open) {
        const inst = this.md.instrument(p.instrument_id)!;
        const q = this.md.getQuote(p.instrument_id);
        const m = q && q.contractId === p.contract_id ? this.markPrice(p, q, inst) : null;
        if (m) unrealized += pnl(p.direction, p.qty_open_g, p.avg_entry_price, m, inst.unit_grams);
      }
    }
    return accountView(acc, unrealized);
  }

  private async pushAccount(userId: number, mode: Mode) {
    try {
      this.notifier.send(userId, 'account', await this.accountSnapshot(userId, mode));
    } catch {
      /* best effort */
    }
  }

  private notifyFill(userId: number, pos: PositionRow, reason: string, price: number, realized?: number) {
    const inst = this.md.instrument(pos.instrument_id);
    this.notifier.send(userId, 'fill', {
      positionId: pos.id,
      mode: pos.mode,
      instrument: inst?.code,
      direction: pos.direction,
      reason,
      title: FILL_REASON_TEXT[reason] ?? reason,
      price,
      realizedPnl: realized ?? null,
      closed: pos.status === 'closed',
    });
  }
}

// ---- validation helpers -----------------------------------------------------

function fmt(paise: number) {
  return `${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })} points`;
}

export function validateQty(inst: InstrumentRow, qty: number) {
  if (!Number.isInteger(qty) || qty < inst.qty_min) throw badRequest('invalid_qty', `Minimum quantity is ${inst.qty_min} g.`);
  if (qty > inst.qty_max) throw badRequest('invalid_qty', `Maximum quantity is ${inst.qty_max} g.`);
  if (qty % inst.qty_step !== 0) throw badRequest('invalid_qty', `Quantity must be in steps of ${inst.qty_step} g.`);
}

function validateTrigger(direction: Direction, type: OrderType, trigger: number, bar: Bar) {
  const ask = bar.ask.c;
  const bid = bar.bid.c;
  if (direction === 'LONG' && type === 'LIMIT' && trigger >= ask) throw badRequest('invalid_trigger', 'A buy limit must be below the current ask. Use a market order to buy now.');
  if (direction === 'LONG' && type === 'STOP' && trigger <= ask) throw badRequest('invalid_trigger', 'A buy stop must be above the current ask.');
  if (direction === 'SHORT' && type === 'LIMIT' && trigger <= bid) throw badRequest('invalid_trigger', 'A sell limit must be above the current bid. Use a market order to sell now.');
  if (direction === 'SHORT' && type === 'STOP' && trigger >= bid) throw badRequest('invalid_trigger', 'A sell stop must be below the current bid.');
}

export function validateBrackets(direction: Direction, ref: number, sl: number | null, tp: number | null, refName = 'entry price') {
  if (sl !== null && sl <= 0) throw badRequest('invalid_sl', 'Stop-loss must be a positive price.');
  if (tp !== null && tp <= 0) throw badRequest('invalid_tp', 'Target must be a positive price.');
  if (direction === 'LONG') {
    if (sl !== null && sl >= ref) throw badRequest('invalid_sl', `For a long (buy) trade the stop-loss must be below the ${refName}.`);
    if (tp !== null && tp <= ref) throw badRequest('invalid_tp', `For a long (buy) trade the target must be above the ${refName}.`);
  } else {
    if (sl !== null && sl <= ref) throw badRequest('invalid_sl', `For a short (sell) trade the stop-loss must be above the ${refName}.`);
    if (tp !== null && tp >= ref) throw badRequest('invalid_tp', `For a short (sell) trade the target must be below the ${refName}.`);
  }
}

export function orderView(o: OrderRow) {
  return {
    id: o.id,
    mode: o.mode,
    replaySessionId: o.replay_session_id,
    instrumentId: o.instrument_id,
    direction: o.direction,
    orderType: o.order_type,
    qty: o.qty_g,
    triggerPrice: o.trigger_price,
    slPrice: o.sl_price,
    tpPrice: o.tp_price,
    trailPaise: o.trail_paise,
    pointsReserved: o.reserved_paise,
    status: o.status,
    setupTag: o.setup_tag,
    planNote: o.plan_note,
    confidence: o.confidence,
    positionId: o.position_id,
    cancelReason: o.cancel_reason,
    createdAt: o.created_at,
    filledAt: o.filled_at,
  };
}
