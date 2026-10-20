import { getCandles } from './candles.js';
import { type ContractRow, daysToExpiry, type InstrumentRow } from './contracts.js';
import type { MarketData, Quote } from './marketData.js';

export function quoteView(inst: InstrumentRow, q: Quote | null, contract: ContractRow | null) {
  if (!q) return null;
  const change = q.prevClose ? q.ltp - q.prevClose : null;
  return {
    instrument: inst.code,
    contract: contract?.trading_symbol ?? null,
    ltp: q.ltp,
    bid: q.bid,
    ask: q.ask,
    spread: q.bid && q.ask ? q.ask - q.bid : null,
    prevClose: q.prevClose,
    change,
    changePct: change !== null && q.prevClose ? (change / q.prevClose) * 100 : null,
    dayOpen: q.dayOpen,
    dayHigh: q.dayHigh,
    dayLow: q.dayLow,
    volume: q.volume,
    oi: q.oi,
    ts: q.ts,
  };
}

export function depthView(inst: InstrumentRow, q: Quote | null) {
  if (!q) return null;
  return {
    instrument: inst.code,
    bids: q.depth?.bids ?? (q.bid ? [{ price: q.bid, qty: 0 }] : []),
    asks: q.depth?.asks ?? (q.ask ? [{ price: q.ask, qty: 0 }] : []),
    spread: q.bid && q.ask ? q.ask - q.bid : null,
    ts: q.ts,
  };
}

export function instrumentView(m: MarketData, inst: InstrumentRow) {
  const c = m.activeContract(inst.id);
  return {
    id: inst.id,
    code: inst.code,
    name: inst.display_name,
    underlying: inst.underlying,
    product: inst.product_symbol,
    priceUnitLabel: inst.price_unit_label,
    unitGrams: inst.unit_grams,
    qtyUnit: inst.qty_unit,
    qtyStep: inst.qty_step,
    qtyMin: inst.qty_min,
    qtyMax: inst.qty_max,
    spreadPaise: inst.fallback_spread_paise,
    brokeragePaise: inst.brokerage_paise,
    tickSizePaise: inst.tick_size_paise,
    contract: c
      ? { id: c.id, symbol: c.trading_symbol, key: c.instrument_key, expiry: c.expiry, rolloverDate: c.rollover_date, daysToExpiry: daysToExpiry(c.expiry, m.clock()) }
      : null,
    market: m.marketStatus(inst.id),
    quote: quoteView(inst, m.getQuote(inst.id), c),
  };
}

function atr(candles: Array<{ h: number; l: number; c: number }>, period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const p = candles[i - 1].c;
    const x = candles[i];
    trs.push(Math.max(x.h - x.l, Math.abs(x.h - p), Math.abs(x.l - p)));
  }
  let a = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return Math.round(a);
}

/** Market stats panel: day range, 52-week range, ATR-based typical daily move, prior-day levels and pivots. */
export async function marketStats(m: MarketData, inst: InstrumentRow, asOf?: number) {
  const now = asOf ?? m.clock();
  const daily = await getCandles({ instrumentId: inst.id, interval: '1d', limit: 260, to: now + 1, asOf });
  const today = daily[daily.length - 1] ?? null;
  const q = asOf === undefined ? m.getQuote(inst.id) : null;
  // Previous completed session = last daily bar strictly before the current IST day.
  const dayStart = Math.floor((now + 330 * 60_000) / 86_400_000) * 86_400_000 - 330 * 60_000;
  const completed = daily.filter((d) => d.openTime < dayStart);
  const prev = completed[completed.length - 1] ?? null;
  const yearBars = daily.filter((d) => d.openTime >= now - 365 * 86_400_000);
  const pivots = prev ? pivotPoints(prev.h, prev.l, prev.c) : null;
  const c = m.activeContract(inst.id);
  const ltp = q?.ltp ?? today?.c ?? null;
  const prevClose = q?.prevClose ?? prev?.c ?? null;
  const oiPrev = prev?.oi ?? null;
  const oi = q?.oi ?? today?.oi ?? null;
  return {
    instrument: inst.code,
    ltp,
    prevClose,
    change: ltp !== null && prevClose ? ltp - prevClose : null,
    changePct: ltp !== null && prevClose ? ((ltp - prevClose) / prevClose) * 100 : null,
    dayOpen: q?.dayOpen ?? (today && today.openTime >= dayStart ? today.o : null),
    dayHigh: q?.dayHigh ?? (today && today.openTime >= dayStart ? today.h : null),
    dayLow: q?.dayLow ?? (today && today.openTime >= dayStart ? today.l : null),
    volume: q?.volume ?? (today && today.openTime >= dayStart ? today.volume : null),
    oi,
    oiChange: oi !== null && oiPrev !== null ? oi - oiPrev : null,
    week52High: yearBars.length ? Math.max(...yearBars.map((d) => d.h)) : null,
    week52Low: yearBars.length ? Math.min(...yearBars.map((d) => d.l)) : null,
    atr14: atr(completed.slice(-60)),
    prevDay: prev ? { high: prev.h, low: prev.l, close: prev.c } : null,
    pivots,
    contract: c ? { symbol: c.trading_symbol, expiry: c.expiry, daysToExpiry: daysToExpiry(c.expiry, now) } : null,
    asOf: now,
  };
}

export function pivotPoints(h: number, l: number, c: number) {
  const p = (h + l + c) / 3;
  const r = (x: number) => Math.round(x);
  return {
    p: r(p),
    r1: r(2 * p - l),
    s1: r(2 * p - h),
    r2: r(p + (h - l)),
    s2: r(p - (h - l)),
    r3: r(h + 2 * (p - l)),
    s3: r(l - 2 * (h - p)),
  };
}
