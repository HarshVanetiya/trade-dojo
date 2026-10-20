import { describe, expect, it } from 'vitest';
import { atr, bollinger, ema, macd, pivots, rsi, sma, vwap } from './indicators';
import type { Candle } from './types';

const c = (openTime: number, o: number, h: number, l: number, cl: number, volume = 1): Candle => ({ openTime, o, h, l, c: cl, volume, oi: null });

describe('indicators', () => {
  it('SMA and EMA', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([2, 4, 6, 8], 3)).toEqual([null, null, 4, 6]);
  });

  it('Bollinger bands of a flat series collapse to the mean', () => {
    const b = bollinger([5, 5, 5, 5], 3, 2);
    expect(b.mid[3]).toBe(5);
    expect(b.upper[3]).toBe(5);
    expect(b.lower[3]).toBe(5);
  });

  it('RSI is 100 for only gains, 0 for only losses, ~50 for alternating', () => {
    expect(rsi([1, 2, 3, 4, 5, 6], 3)[5]).toBe(100);
    expect(rsi([6, 5, 4, 3, 2, 1], 3)[5]).toBe(0);
    const alt = rsi([10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11], 14)[15]!;
    expect(alt).toBeGreaterThan(45);
    expect(alt).toBeLessThan(60);
  });

  it('MACD line is zero for a flat series', () => {
    const m = macd(new Array(40).fill(100), 3, 6, 3);
    expect(m.line[39]).toBe(0);
    expect(m.hist[39]).toBe(0);
  });

  it('ATR of constant-range bars equals the range', () => {
    const bars = Array.from({ length: 10 }, (_, i) => c(i * 60_000, 100, 110, 100, 105));
    expect(atr(bars, 3)[9]).toBe(10);
  });

  it('VWAP weights by volume and resets each IST day', () => {
    const day1 = Date.parse('2026-10-20T03:30:00Z');
    const day2 = Date.parse('2026-10-21T03:30:00Z');
    const out = vwap([c(day1, 0, 30, 30, 30, 1), c(day1 + 60_000, 0, 60, 60, 60, 3), c(day2, 0, 90, 90, 90, 1)]);
    expect(out[1]).toBe((30 * 1 + 60 * 3) / 4);
    expect(out[2]).toBe(90);
  });

  it('pivot points', () => {
    const p = pivots(110, 90, 100);
    expect(p.P).toBe(100);
    expect(p.R1).toBe(110);
    expect(p.S1).toBe(90);
    expect(p.R2).toBe(120);
    expect(p.S2).toBe(80);
  });
});
