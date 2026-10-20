// Pure fill/trigger rules shared by live ticks and replay candles. All prices are paise.

export type Direction = 'LONG' | 'SHORT';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP';

export interface Ohlc {
  o: number;
  h: number;
  l: number;
  c: number;
}

/**
 * One price update as the engine sees it. `bid` is where you can SELL, `ask` where you can BUY.
 * A live tick is a bar whose o = h = l = c; a replay candle has a real range.
 */
export interface Bar {
  ts: number;
  bid: Ohlc;
  ask: Ohlc;
  ltp: number;
  /** First price of a new session: anything beyond a stop here is a gap. */
  gapOpen: boolean;
  /** True for replay candles (range known, intra-bar order unknown). */
  isCandle: boolean;
}

const flat = (x: number): Ohlc => ({ o: x, h: x, l: x, c: x });

/** Half spreads on each side of a mid price. Bid gets the floor, ask the ceiling, so the total equals the spread. */
export function splitSpread(spread: number): [number, number] {
  const lo = Math.floor(spread / 2);
  return [lo, spread - lo];
}

/** Live tick: best bid/ask from the feed, or LTP -/+ half of the fallback spread when depth is missing. */
export function barFromQuote(q: { ltp: number; bid: number | null; ask: number | null; ts: number }, fallbackSpread: number, gapOpen: boolean): Bar {
  const [lo, hi] = splitSpread(fallbackSpread);
  const bid = q.bid && q.bid > 0 ? q.bid : q.ltp - lo;
  const ask = q.ask && q.ask > 0 ? q.ask : q.ltp + hi;
  return { ts: q.ts, bid: flat(bid), ask: flat(ask), ltp: q.ltp, gapOpen, isCandle: false };
}

/** Replay candle: fills at candle prices -/+ half the configured spread. */
export function barFromCandle(c: Ohlc & { ts: number }, spread: number, gapOpen: boolean): Bar {
  const [lo, hi] = splitSpread(spread);
  const shift = (d: number): Ohlc => ({ o: c.o + d, h: c.h + d, l: c.l + d, c: c.c + d });
  return { ts: c.ts, bid: shift(-lo), ask: shift(hi), ltp: c.c, gapOpen, isCandle: true };
}

/** Market order price: BUY at the ask, SELL at the bid (latest = close of the bar). */
export function marketPrice(bar: Bar, side: 'BUY' | 'SELL'): number {
  return side === 'BUY' ? bar.ask.c : bar.bid.c;
}

export const entrySide = (d: Direction): 'BUY' | 'SELL' => (d === 'LONG' ? 'BUY' : 'SELL');
export const exitSide = (d: Direction): 'BUY' | 'SELL' => (d === 'LONG' ? 'SELL' : 'BUY');

export interface EntryFill {
  price: number;
  gap: boolean;
}

/**
 * LIMIT/STOP entries rest until price crosses the level, then fill at that level.
 * A STOP entry that the market opened beyond (a gap) fills at the first available price instead.
 */
export function evaluateEntry(order: { direction: Direction; orderType: OrderType; trigger: number }, bar: Bar): EntryFill | null {
  const { direction, orderType, trigger } = order;
  if (direction === 'LONG') {
    const p = bar.ask;
    if (orderType === 'LIMIT' && p.l <= trigger) return { price: trigger, gap: false };
    if (orderType === 'STOP' && p.h >= trigger) return bar.gapOpen && p.o > trigger ? { price: p.o, gap: true } : { price: trigger, gap: false };
  } else {
    const p = bar.bid;
    if (orderType === 'LIMIT' && p.h >= trigger) return { price: trigger, gap: false };
    if (orderType === 'STOP' && p.l <= trigger) return bar.gapOpen && p.o < trigger ? { price: p.o, gap: true } : { price: trigger, gap: false };
  }
  return null;
}

export type ExitReason = 'stop_loss' | 'trailing_stop' | 'target';

export interface ExitFill {
  reason: ExitReason;
  price: number;
  gap: boolean;
  /** Both stop-loss and target were inside this candle; we assume the stop hit first. */
  bothTouched: boolean;
}

/**
 * Stop-loss before target. A stop fills at its level, or at the first available price when the
 * session opened beyond it (gap risk). If one candle touched both, the stop is assumed to have hit first.
 */
export function evaluateExit(pos: { direction: Direction; sl: number | null; tp: number | null; trailing: boolean }, bar: Bar): ExitFill | null {
  const long = pos.direction === 'LONG';
  const p = long ? bar.bid : bar.ask;
  const slHit = pos.sl !== null && (long ? p.l <= pos.sl : p.h >= pos.sl);
  const tpHit = pos.tp !== null && (long ? p.h >= pos.tp : p.l <= pos.tp);
  if (slHit) {
    const sl = pos.sl!;
    const gapped = bar.gapOpen && (long ? p.o < sl : p.o > sl);
    return { reason: pos.trailing ? 'trailing_stop' : 'stop_loss', price: gapped ? p.o : sl, gap: gapped, bothTouched: tpHit };
  }
  // Targets are limit exits: they fill at their level.
  if (tpHit) return { reason: 'target', price: pos.tp!, gap: false, bothTouched: false };
  return null;
}

/** Favourable / adverse extremes reachable at the exit side during a bar. */
export function barExtremes(direction: Direction, bar: Bar): { best: number; worst: number } {
  const p = direction === 'LONG' ? bar.bid : bar.ask;
  return direction === 'LONG' ? { best: p.h, worst: p.l } : { best: p.l, worst: p.h };
}

export function better(direction: Direction, a: number, b: number): number {
  return direction === 'LONG' ? Math.max(a, b) : Math.min(a, b);
}

export function worse(direction: Direction, a: number, b: number): number {
  return direction === 'LONG' ? Math.min(a, b) : Math.max(a, b);
}

/** Trailing stop follows the best price at a fixed distance and never moves back. */
export function trailedStop(direction: Direction, currentSl: number | null, best: number, trail: number): number {
  const candidate = direction === 'LONG' ? best - trail : best + trail;
  if (currentSl === null) return candidate;
  return direction === 'LONG' ? Math.max(currentSl, candidate) : Math.min(currentSl, candidate);
}

/** Merge two bars that arrived while the engine was busy, keeping the full range so no trigger is missed. */
export function mergeBars(a: Bar, b: Bar): Bar {
  const m = (x: Ohlc, y: Ohlc): Ohlc => ({ o: x.o, h: Math.max(x.h, y.h), l: Math.min(x.l, y.l), c: y.c });
  return { ts: b.ts, bid: m(a.bid, b.bid), ask: m(a.ask, b.ask), ltp: b.ltp, gapOpen: a.gapOpen || b.gapOpen, isCandle: a.isCandle || b.isCandle };
}
