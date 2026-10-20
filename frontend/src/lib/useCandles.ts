import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Candle, Quote } from './types';

export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export const INTERVALS: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
const MS: Record<Interval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const ORIGIN = Date.parse('2000-01-01T03:30:00Z'); // 09:00 IST, same anchor as the backend
const IST = 330 * 60_000;

export function bucketStart(t: number, interval: Interval): number {
  if (interval === '1d') return Math.floor((t + IST) / MS['1d']) * MS['1d'] - IST;
  return ORIGIN + Math.floor((t - ORIGIN) / MS[interval]) * MS[interval];
}

/** Historical candles from the API plus an in-progress bar built from live quotes. */
export function useLiveCandles(instrument: string, interval: Interval, quote: Quote | null, enabled = true) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [liveBar, setLiveBar] = useState<Candle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<Candle | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    setError(null);
    live.current = null;
    setLiveBar(null);
    const load = (first: boolean) =>
      api<{ candles: Candle[] }>('/candles', { query: { instrument, interval, limit: 500 } })
        .then((r) => {
          if (!alive) return;
          setCandles(r.candles);
          if (first) setLoading(false);
        })
        .catch((e) => {
          if (!alive) return;
          setError(e.message);
          setLoading(false);
        });
    void load(true);
    // Resync with the server (it has the real per-minute volume) once a minute.
    const t = setInterval(() => load(false), 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [instrument, interval, enabled]);

  useEffect(() => {
    if (!enabled || !quote || !candles.length) return;
    const start = bucketStart(quote.ts, interval);
    const last = candles[candles.length - 1];
    if (start < last.openTime) return;
    let bar = live.current && live.current.openTime === start ? live.current : null;
    if (!bar) {
      const base = last.openTime === start ? last : null;
      bar = base ? { ...base } : { openTime: start, o: quote.ltp, h: quote.ltp, l: quote.ltp, c: quote.ltp, volume: 0, oi: quote.oi };
    }
    bar = { ...bar, h: Math.max(bar.h, quote.ltp), l: Math.min(bar.l, quote.ltp), c: quote.ltp, oi: quote.oi ?? bar.oi };
    if (live.current && live.current.openTime < start) {
      // The previous bar is complete: keep it in history.
      const done = live.current;
      setCandles((cs) => (cs[cs.length - 1]?.openTime === done.openTime ? [...cs.slice(0, -1), done] : [...cs, done]));
    }
    live.current = bar;
    setLiveBar(bar);
  }, [quote, interval, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return { candles, liveBar, loading, error, setCandles };
}
