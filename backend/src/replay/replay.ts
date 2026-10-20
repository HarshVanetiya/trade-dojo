import { query, queryOne } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { DAY, istDate, MINUTE } from '../lib/time.js';
import type { TradingEngine, OrderRow, PositionRow, ReplayBridge } from '../engine/engine.js';
import { barFromCandle, marketPrice, exitSide, type Bar } from '../engine/rules.js';
import { ensureHistory } from '../market/backfill.js';
import { aggregate, getCandles, stitchedRows, type ChartCandle } from '../market/candles.js';
import type { InstrumentRow } from '../market/contracts.js';
import type { MarketData } from '../market/marketData.js';
import { INTERVAL_MS, type Interval } from '../market/types.js';
import { marketStats } from '../market/views.js';
import { getActiveAccount } from '../services/accounts.js';
import { refreshSessionReviews } from '../reviews/review.js';

export type StepInterval = '1m' | '5m' | '15m' | '1h' | '1d';
export const SPEEDS = [1, 5, 20, 100] as const;

export interface SessionRow {
  id: number;
  user_id: number;
  account_id: number;
  instrument_id: number;
  from_ts: Date;
  to_ts: Date;
  current_ts: Date;
  step_interval: StepInterval;
  speed: number;
  status: 'paused' | 'playing' | 'ended';
  created_at: Date;
  ended_at: Date | null;
}

/** Longest allowed range per step size (keeps sessions a sensible size). */
const MAX_RANGE_DAYS: Record<StepInterval, number> = { '1m': 31, '5m': 62, '15m': 92, '1h': 183, '1d': 3650 };

interface Runtime {
  bars: ChartCandle[]; // all step bars of the session, ascending (never sent ahead of the clock)
  index: number; // bars revealed so far
  timer: NodeJS.Timeout | null;
  carry: number;
  busy: boolean;
  lastPersist: number;
}

const stepMs = (s: StepInterval) => INTERVAL_MS[s as Interval];

/**
 * Replays stored candles one step at a time. The session clock (`current_ts`) only moves forward,
 * and everything the user can see (candles, prices, stats, reviews) is cut off at that clock.
 */
export class ReplayService implements ReplayBridge {
  private runtimes = new Map<number, Runtime>();
  /** Notifies the owning user only. */
  send: (userId: number, type: string, data: unknown) => void = () => {};

  constructor(private md: MarketData, private engine: TradingEngine) {
    engine.replay = this;
  }

  private inst(id: number): InstrumentRow {
    const i = this.md.instrument(id);
    if (!i) throw notFound('Instrument');
    return i;
  }

  async session(id: number, userId: number): Promise<SessionRow> {
    const s = await queryOne<SessionRow>('SELECT * FROM replay_sessions WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!s) throw notFound('Replay session');
    return s;
  }

  private async loadBars(s: SessionRow): Promise<ChartCandle[]> {
    const from = s.from_ts.getTime();
    const to = s.to_ts.getTime();
    if (s.step_interval === '1d') {
      return (await getCandles({ instrumentId: s.instrument_id, interval: '1d', from, to, limit: 5000 })).filter((c) => c.openTime >= from && c.openTime < to);
    }
    const rows = await stitchedRows(s.instrument_id, '1m', from, to);
    const mins: ChartCandle[] = rows.map((r) => ({ openTime: r.open_time.getTime(), o: r.o, h: r.h, l: r.l, c: r.c, volume: Number(r.volume), oi: r.oi, contract: r.trading_symbol, contractId: r.contract_id }));
    return s.step_interval === '1m' ? mins : aggregate(mins, s.step_interval);
  }

  private async runtime(s: SessionRow): Promise<Runtime> {
    let rt = this.runtimes.get(s.id);
    if (rt) return rt;
    const bars = await this.loadBars(s);
    const cur = s.current_ts.getTime();
    const ms = stepMs(s.step_interval);
    const index = bars.filter((b) => b.openTime + ms <= cur).length;
    rt = { bars, index, timer: null, carry: 0, busy: false, lastPersist: Date.now() };
    this.runtimes.set(s.id, rt);
    return rt;
  }

  async create(userId: number, input: { instrument: string; from: string; to: string; step: StepInterval; speed: number }) {
    const inst = this.md.instrumentByCode(input.instrument);
    if (!inst || !inst.enabled) throw notFound('Instrument');
    const active = await queryOne<SessionRow>(`SELECT * FROM replay_sessions WHERE user_id = $1 AND status <> 'ended'`, [userId]);
    if (active) throw conflict('replay_active', 'You already have a replay running. End it before starting a new one.');
    const from = Date.parse(`${input.from}T00:00:00+05:30`);
    const to = Date.parse(`${input.to}T00:00:00+05:30`) + DAY;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw badRequest('invalid_range', 'Pick a valid date range.');
    const today = Date.parse(`${istDate(this.md.clock())}T00:00:00+05:30`);
    if (to > today + DAY) throw badRequest('invalid_range', 'Replay works on past dates only.');
    if ((to - from) / DAY > MAX_RANGE_DAYS[input.step]) throw badRequest('range_too_long', `With ${input.step} steps you can replay up to ${MAX_RANGE_DAYS[input.step]} days.`);
    if (input.step !== '1d' && input.from < '2022-01-01') throw badRequest('range_too_old', 'Intraday history starts in January 2022. Use daily steps for older dates.');
    // Shared cache: fetched once (also some context before the start), then reused by everyone.
    const contextFrom = input.step === '1d' ? from - 400 * DAY : from - 10 * DAY;
    try {
      await ensureHistory(this.md, inst, contextFrom, to, input.step === '1d' ? '1d' : '1m');
      if (input.step === '1d') await ensureHistory(this.md, inst, from, to, '1m').catch(() => {});
    } catch (err) {
      this.md.recordError(`Replay history fetch failed: ${(err as Error).message}`);
    }
    const account = await getActiveAccount(userId, 'replay');
    const s = (await queryOne<SessionRow>(
      `INSERT INTO replay_sessions (user_id, account_id, instrument_id, from_ts, to_ts, current_ts, step_interval, speed, status)
       VALUES ($1, $2, $3, $4, $5, $4, $6, $7, 'paused') RETURNING *`,
      [userId, account.id, inst.id, new Date(from), new Date(to), input.step, input.speed],
    ))!;
    const rt = await this.runtime(s);
    if (!rt.bars.length) {
      await query(`UPDATE replay_sessions SET status = 'ended', ended_at = now() WHERE id = $1`, [s.id]);
      this.runtimes.delete(s.id);
      throw badRequest('no_data', 'No price history is available for those dates. Try a more recent range.');
    }
    return this.view(s);
  }

  async active(userId: number) {
    const s = await queryOne<SessionRow>(`SELECT * FROM replay_sessions WHERE user_id = $1 AND status <> 'ended' ORDER BY id DESC LIMIT 1`, [userId]);
    return s ? this.view(s) : null;
  }

  async list(userId: number) {
    const rows = await query<SessionRow>('SELECT * FROM replay_sessions WHERE user_id = $1 ORDER BY id DESC LIMIT 30', [userId]);
    return rows.map((s) => ({ id: s.id, instrument: this.md.instrument(s.instrument_id)?.code, from: s.from_ts, to: s.to_ts, currentTs: s.current_ts, step: s.step_interval, status: s.status, createdAt: s.created_at }));
  }

  /** Last fully revealed step bar (or the last candle before the start, for context). */
  private async lastBar(s: SessionRow, rt: Runtime): Promise<ChartCandle | null> {
    if (rt.index > 0) return rt.bars[rt.index - 1];
    const before = await getCandles({ instrumentId: s.instrument_id, interval: s.step_interval as Interval, to: s.from_ts.getTime(), limit: 1, asOf: s.from_ts.getTime() });
    return before[before.length - 1] ?? null;
  }

  async view(s: SessionRow) {
    const rt = await this.runtime(s);
    const inst = this.inst(s.instrument_id);
    const last = await this.lastBar(s, rt);
    const half = Math.floor(inst.fallback_spread_paise / 2);
    const prevDay = await this.prevClose(s, last);
    return {
      id: s.id,
      instrument: inst.code,
      from: s.from_ts,
      to: s.to_ts,
      currentTs: s.current_ts.getTime(),
      step: s.step_interval,
      speed: s.speed,
      status: s.status,
      index: rt.index,
      total: rt.bars.length,
      atEnd: rt.index >= rt.bars.length,
      quote: last
        ? {
            instrument: inst.code,
            contract: last.contract,
            ltp: last.c,
            bid: last.c - half,
            ask: last.c + (inst.fallback_spread_paise - half),
            spread: inst.fallback_spread_paise,
            prevClose: prevDay,
            change: prevDay ? last.c - prevDay : null,
            changePct: prevDay ? ((last.c - prevDay) / prevDay) * 100 : null,
            dayOpen: null,
            dayHigh: null,
            dayLow: null,
            volume: null,
            oi: last.oi,
            ts: s.current_ts.getTime(),
          }
        : null,
    };
  }

  private async prevClose(s: SessionRow, last: ChartCandle | null): Promise<number | null> {
    if (!last) return null;
    const dayStart = Date.parse(`${istDate(last.openTime)}T00:00:00+05:30`);
    const d = await getCandles({ instrumentId: s.instrument_id, interval: '1d', to: dayStart, limit: 1, asOf: Math.min(dayStart, s.current_ts.getTime()) });
    return d[d.length - 1]?.c ?? null;
  }

  // ---- ReplayBridge (used by the trading engine) ---------------------------

  async current(sessionId: number, userId: number) {
    const s = await this.session(sessionId, userId);
    if (s.status === 'ended') throw conflict('replay_ended', 'This replay session has ended.');
    const rt = await this.runtime(s);
    const last = await this.lastBar(s, rt);
    if (!last) throw conflict('no_price', 'No price yet. Step the replay forward first.');
    const inst = this.inst(s.instrument_id);
    const bar: Bar = { ...barFromCandle({ ...last, ts: s.current_ts.getTime() }, inst.fallback_spread_paise, false) };
    // Orders placed now fill at the latest close, not anywhere inside the candle.
    const flat = (x: number) => ({ o: x, h: x, l: x, c: x });
    return { bar: { ...bar, bid: flat(bar.bid.c), ask: flat(bar.ask.c) }, instrumentId: s.instrument_id, accountId: s.account_id, contractId: last.contractId ?? null };
  }

  // ---- playback ------------------------------------------------------------

  /** Reveal up to `n` more step bars, running the trigger engine on each. */
  async advance(s: SessionRow, n: number): Promise<number> {
    const rt = await this.runtime(s);
    if (rt.busy) return 0;
    rt.busy = true;
    const ms = stepMs(s.step_interval);
    const revealed: ChartCandle[] = [];
    try {
      const inst = this.inst(s.instrument_id);
      for (let k = 0; k < n && rt.index < rt.bars.length; k++) {
        const bar = rt.bars[rt.index];
        const prev = rt.index > 0 ? rt.bars[rt.index - 1] : null;
        // A new trading day (or a gap of more than an hour) is a session open: stops beyond it fill at the open.
        const gapOpen = !!prev && (istDate(prev.openTime) !== istDate(bar.openTime) || bar.openTime - (prev.openTime + ms) > 60 * MINUTE);
        rt.index += 1;
        const ts = Math.min(bar.openTime + ms, s.to_ts.getTime());
        s.current_ts = new Date(ts);
        await query('UPDATE replay_sessions SET current_ts = $2 WHERE id = $1', [s.id, s.current_ts]);
        await this.engine.processBar({ mode: 'replay', sessionId: s.id }, barFromCandle({ ...bar, ts }, inst.fallback_spread_paise, gapOpen));
        revealed.push(bar);
      }
    } finally {
      rt.busy = false;
    }
    if (revealed.length) {
      const v = await this.view(s);
      this.send(s.user_id, 'replay', { ...v, bars: revealed });
    }
    if (rt.index >= rt.bars.length && s.status === 'playing') await this.pause(s.id, s.user_id);
    return revealed.length;
  }

  async play(id: number, userId: number) {
    const s = await this.session(id, userId);
    if (s.status === 'ended') throw conflict('replay_ended', 'This replay session has ended.');
    const rt = await this.runtime(s);
    if (rt.index >= rt.bars.length) throw conflict('replay_finished', 'You reached the end of this replay. End it to see your results.');
    await query(`UPDATE replay_sessions SET status = 'playing' WHERE id = $1`, [id]);
    s.status = 'playing';
    this.startTimer(s, rt);
    return this.view(s);
  }

  private startTimer(s: SessionRow, rt: Runtime) {
    if (rt.timer) clearInterval(rt.timer);
    rt.carry = 0;
    rt.timer = setInterval(() => {
      // speed = candles per second; the timer ticks 10x a second.
      rt.carry += s.speed / 10;
      const n = Math.floor(rt.carry);
      if (n < 1 || rt.busy) return;
      rt.carry -= n;
      this.advance(s, n).catch((err) => this.md.recordError(`Replay ${s.id}: ${err.message}`));
    }, 100);
    rt.timer.unref();
  }

  async pause(id: number, userId: number) {
    const s = await this.session(id, userId);
    const rt = this.runtimes.get(id);
    if (rt?.timer) clearInterval(rt.timer);
    if (rt) rt.timer = null;
    if (s.status !== 'ended') {
      await query(`UPDATE replay_sessions SET status = 'paused' WHERE id = $1`, [id]);
      s.status = 'paused';
    }
    const v = await this.view(s);
    this.send(userId, 'replay', { ...v, bars: [] });
    return v;
  }

  async step(id: number, userId: number, count = 1) {
    const s = await this.session(id, userId);
    if (s.status === 'ended') throw conflict('replay_ended', 'This replay session has ended.');
    if (s.status === 'playing') await this.pause(id, userId);
    s.status = 'paused';
    await this.advance(s, Math.max(1, Math.min(count, 500)));
    return this.view(s);
  }

  async setSpeed(id: number, userId: number, speed: number) {
    if (!SPEEDS.includes(speed as (typeof SPEEDS)[number])) throw badRequest('invalid_speed', 'Speed must be 1x, 5x, 20x or 100x.');
    const s = await this.session(id, userId);
    await query('UPDATE replay_sessions SET speed = $2 WHERE id = $1', [id, speed]);
    s.speed = speed;
    const rt = this.runtimes.get(id);
    if (rt?.timer && s.status === 'playing') this.startTimer(s, rt);
    return this.view(s);
  }

  /** End the session: open replay positions close at the current price, pending orders are cancelled. */
  async end(id: number, userId: number) {
    const s = await this.session(id, userId);
    const rt = this.runtimes.get(id);
    if (rt?.timer) clearInterval(rt.timer);
    if (s.status !== 'ended') {
      const cur = await this.current(id, userId).catch(() => null);
      const positions = await query<PositionRow>(`SELECT * FROM positions WHERE replay_session_id = $1 AND status = 'open'`, [id]);
      for (const p of positions) {
        if (!cur) break;
        await this.engine.closeAt(p.id, null, marketPrice(cur.bar, exitSide(p.direction)), s.current_ts, 'session_end', false, false);
      }
      const orders = await query<OrderRow>(`SELECT * FROM orders WHERE replay_session_id = $1 AND status = 'pending'`, [id]);
      for (const o of orders) await this.engine.cancelOrder(userId, o.id, 'Replay session ended').catch(() => {});
      await query(`UPDATE replay_sessions SET status = 'ended', ended_at = now() WHERE id = $1`, [id]);
      s.status = 'ended';
      // Reviews of replay trades could only use data up to the clock; now the session is over, fill them in.
      await refreshSessionReviews(this.md, id).catch((err) => this.md.recordError(`Replay reviews: ${err.message}`));
    }
    this.runtimes.delete(id);
    const trades = await query<{ n: number; pnl: number }>(`SELECT count(*)::int AS n, COALESCE(sum(net_pnl), 0)::bigint AS pnl FROM trades WHERE replay_session_id = $1`, [id]);
    return { id, status: 'ended', trades: trades[0].n, netPnl: Number(trades[0].pnl) };
  }

  /** Chart data for the session, never past the replay clock. */
  async candles(id: number, userId: number, interval: Interval, limit: number) {
    const s = await this.session(id, userId);
    const asOf = s.current_ts.getTime();
    return getCandles({ instrumentId: s.instrument_id, interval, to: asOf, limit, asOf });
  }

  /** Timers do not survive a restart: sessions that were playing resume paused. */
  async init() {
    await query(`UPDATE replay_sessions SET status = 'paused' WHERE status = 'playing'`);
  }

  async marketStats(id: number, userId: number) {
    const s = await this.session(id, userId);
    return marketStats(this.md, this.inst(s.instrument_id), s.current_ts.getTime());
  }

  stopAll() {
    for (const rt of this.runtimes.values()) if (rt.timer) clearInterval(rt.timer);
  }
}
