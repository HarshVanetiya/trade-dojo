// Small, dependency-free indicator library. Inputs are candles with prices in paise; outputs are
// arrays aligned to the input (null where the indicator is not defined yet).

import type { Candle } from './types';

export type Series = Array<number | null>;

export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

export function bollinger(values: number[], period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const m = mid[i]!;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j] - m) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

/** Wilder's RSI. */
export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line: Series = values.map((_, i) => (f[i] !== null && s[i] !== null ? f[i]! - s[i]! : null));
  const firstIdx = line.findIndex((x) => x !== null);
  const sig: Series = new Array(values.length).fill(null);
  if (firstIdx >= 0) {
    const sub = ema(line.slice(firstIdx) as number[], signal);
    sub.forEach((v, j) => (sig[firstIdx + j] = v));
  }
  const hist: Series = line.map((l, i) => (l !== null && sig[i] !== null ? l - sig[i]! : null));
  return { line, signal: sig, hist };
}

/** Wilder's ATR. */
export function atr(c: Candle[], period = 14): Series {
  const out: Series = new Array(c.length).fill(null);
  if (c.length <= period) return out;
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  let a = tr.slice(1, period + 1).reduce((s, v) => s + v, 0) / period;
  out[period] = a;
  for (let i = period + 1; i < c.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }
  return out;
}

const IST_MS = 330 * 60_000;
const istDay = (t: number) => Math.floor((t + IST_MS) / 86_400_000);

/** Intraday VWAP, reset at each IST trading day. */
export function vwap(c: Candle[]): Series {
  const out: Series = new Array(c.length).fill(null);
  let day = -1;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < c.length; i++) {
    const d = istDay(c[i].openTime);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const typical = (c[i].h + c[i].l + c[i].c) / 3;
    const v = Math.max(c[i].volume, 0);
    pv += typical * v;
    vol += v;
    out[i] = vol > 0 ? pv / vol : typical;
  }
  return out;
}

export function pivots(h: number, l: number, c: number) {
  const p = (h + l + c) / 3;
  return { P: p, R1: 2 * p - l, S1: 2 * p - h, R2: p + (h - l), S2: p - (h - l), R3: h + 2 * (p - l), S3: l - 2 * (h - p) };
}

export interface IndicatorConfig {
  sma: { on: boolean; period: number };
  ema: { on: boolean; period: number };
  vwap: { on: boolean };
  bb: { on: boolean; period: number; mult: number };
  rsi: { on: boolean; period: number };
  macd: { on: boolean; fast: number; slow: number; signal: number };
  atr: { on: boolean; period: number };
  volMa: { on: boolean; period: number };
  oi: { on: boolean };
  levels: { on: boolean }; // previous-day H/L/C + pivots
}

export const DEFAULT_INDICATORS: IndicatorConfig = {
  sma: { on: false, period: 20 },
  ema: { on: true, period: 21 },
  vwap: { on: false },
  bb: { on: false, period: 20, mult: 2 },
  rsi: { on: false, period: 14 },
  macd: { on: false, fast: 12, slow: 26, signal: 9 },
  atr: { on: false, period: 14 },
  volMa: { on: true, period: 20 },
  oi: { on: false },
  levels: { on: false },
};
