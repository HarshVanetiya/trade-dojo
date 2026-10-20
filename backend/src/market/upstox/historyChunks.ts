import { addDays } from '../../lib/time.js';
import type { StoredInterval } from '../types.js';

/**
 * Upstox Historical Candle Data V3 limits (per the docs):
 *  - minutes, 1-15 minute intervals: data from 2022-01-01, at most one month per request
 *  - days: data from 2000-01-01, at most one decade per request
 */
export const HISTORY_LIMITS: Record<StoredInterval, { earliest: string; maxSpan: (from: string) => string }> = {
  '1m': { earliest: '2022-01-01', maxSpan: (from) => addMonthsMinusOneDay(from, 1) },
  '1d': { earliest: '2000-01-01', maxSpan: (from) => addMonthsMinusOneDay(from, 120) },
};

function addMonthsMinusOneDay(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  const end = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day));
  return addDays(end.toISOString().slice(0, 10), -1);
}

export interface DateChunk {
  from: string; // inclusive YYYY-MM-DD
  to: string; // inclusive YYYY-MM-DD
}

/** Split [from, to] (inclusive IST dates) into request-sized chunks, clamped to the earliest available date. */
export function chunkHistoryRange(interval: StoredInterval, from: string, to: string): DateChunk[] {
  const lim = HISTORY_LIMITS[interval];
  let start = from < lim.earliest ? lim.earliest : from;
  const chunks: DateChunk[] = [];
  while (start <= to) {
    const maxEnd = lim.maxSpan(start);
    const end = maxEnd < to ? maxEnd : to;
    chunks.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  return chunks;
}
