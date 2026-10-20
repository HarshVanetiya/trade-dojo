import { type Db, pool, query } from '../db/pool.js';
import { DAY, IST_OFFSET_MS, MINUTE } from '../lib/time.js';
import type { Candle, Interval, StoredInterval } from './types.js';
import { INTERVAL_MS } from './types.js';

export interface ChartCandle extends Candle {
  contract: string; // trading symbol
  contractId: number;
  /** True when this bar's contract differs from the previous bar's (a rollover stitch point). */
  stitch?: boolean;
}

/** Intraday buckets are anchored to the 09:00 IST open, so 1h/4h bars align with the MCX session. */
const SESSION_ORIGIN = Date.parse('2000-01-01T03:30:00Z');

export function bucketStart(t: number, interval: Interval): number {
  if (interval === '1d') return Math.floor((t + IST_OFFSET_MS) / DAY) * DAY - IST_OFFSET_MS;
  const size = INTERVAL_MS[interval];
  return SESSION_ORIGIN + Math.floor((t - SESSION_ORIGIN) / size) * size;
}

export async function upsertCandles(
  instrumentId: number,
  contractId: number,
  interval: StoredInterval,
  candles: Candle[],
  source: 'live' | 'history' | 'mock',
  db: Db = pool,
): Promise<number> {
  let saved = 0;
  for (let i = 0; i < candles.length; i += 500) {
    const part = candles.slice(i, i + 500);
    const values: unknown[] = [];
    const rows = part.map((c, j) => {
      const b = j * 11;
      values.push(instrumentId, contractId, interval, new Date(c.openTime), c.o, c.h, c.l, c.c, c.volume, c.oi, source);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`;
    });
    await db.query(
      `INSERT INTO candles (instrument_id, contract_id, interval, open_time, o, h, l, c, volume, oi, source)
       VALUES ${rows.join(',')}
       ON CONFLICT (contract_id, interval, open_time) DO UPDATE SET
         h = GREATEST(candles.h, EXCLUDED.h), l = LEAST(candles.l, EXCLUDED.l), c = EXCLUDED.c,
         o = CASE WHEN candles.source = 'live' AND EXCLUDED.source = 'live' THEN candles.o ELSE EXCLUDED.o END,
         volume = GREATEST(candles.volume, EXCLUDED.volume), oi = COALESCE(EXCLUDED.oi, candles.oi)`,
      values,
    );
    saved += part.length;
  }
  return saved;
}

interface StoredRow {
  open_time: Date;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
  oi: number | null;
  contract_id: number;
  trading_symbol: string;
}

/**
 * Stored candles for an instrument as one continuous series. Where several contracts have a
 * candle at the same time, the near-month contract of that moment wins (the earliest expiry whose
 * rollover date is still ahead), which stitches contracts together at their rollover dates.
 */
export async function stitchedRows(instrumentId: number, interval: StoredInterval, from: number, to: number, db: Db = pool): Promise<StoredRow[]> {
  return query<StoredRow>(
    `SELECT DISTINCT ON (c.open_time) c.open_time, c.o, c.h, c.l, c.c, c.volume, c.oi, c.contract_id, ct.trading_symbol
     FROM candles c JOIN contracts ct ON ct.id = c.contract_id
     WHERE c.instrument_id = $1 AND c.interval = $2 AND c.open_time >= $3 AND c.open_time < $4
     ORDER BY c.open_time,
       (ct.rollover_date <= (c.open_time AT TIME ZONE 'Asia/Kolkata')::date),
       CASE WHEN ct.rollover_date > (c.open_time AT TIME ZONE 'Asia/Kolkata')::date THEN ct.expiry END ASC,
       ct.expiry DESC`,
    [instrumentId, interval, new Date(from), new Date(to)],
    db,
  );
}

function toChart(r: StoredRow): ChartCandle {
  return { openTime: r.open_time.getTime(), o: r.o, h: r.h, l: r.l, c: r.c, volume: Number(r.volume), oi: r.oi, contract: r.trading_symbol, contractId: r.contract_id };
}

/** Aggregate base candles (ascending) into `interval` buckets. */
export function aggregate(base: ChartCandle[], interval: Interval): ChartCandle[] {
  const out: ChartCandle[] = [];
  let cur: ChartCandle | null = null;
  for (const b of base) {
    const start = bucketStart(b.openTime, interval);
    if (!cur || cur.openTime !== start) {
      if (cur) out.push(cur);
      cur = { ...b, openTime: start };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.volume += b.volume;
      cur.oi = b.oi ?? cur.oi;
      cur.contract = b.contract;
      cur.contractId = b.contractId;
    }
  }
  if (cur) out.push(cur);
  return markStitches(out);
}

function markStitches(rows: ChartCandle[]): ChartCandle[] {
  for (let i = 1; i < rows.length; i++) if (rows[i].contractId !== rows[i - 1].contractId) rows[i].stitch = true;
  return rows;
}

export interface CandleQuery {
  instrumentId: number;
  interval: Interval;
  /** Return bars with openTime < to (default now). */
  to?: number;
  from?: number;
  limit?: number;
  /**
   * Replay cutoff: only data fully known at this instant is used. Base candles count only when
   * openTime + baseDuration <= asOf, so a partially formed higher-timeframe bar never reveals the future.
   */
  asOf?: number;
}

/** Calendar span to scan so that `limit` bars are likely found (MCX trades ~14.5 h a day, 5 days a week). */
function lookbackMs(interval: Interval, limit: number): number {
  if (interval === '1d') return Math.ceil(limit * 1.5) * DAY + 10 * DAY;
  return Math.ceil(limit * INTERVAL_MS[interval] * (24 / 14) * (7 / 5)) + 4 * DAY;
}

export async function getCandles(q: CandleQuery, db: Db = pool): Promise<ChartCandle[]> {
  const limit = Math.min(Math.max(q.limit ?? 500, 1), 5000);
  let to = q.to ?? Date.now();
  if (q.asOf !== undefined) to = Math.min(to, q.asOf);
  const from = q.from ?? to - lookbackMs(q.interval, limit);
  const known = (start: number, dur: number) => q.asOf === undefined || start + dur <= q.asOf;

  let bars: ChartCandle[];
  if (q.interval === '1d') {
    // Stored daily candles, completed by days that only exist as 1m data (today, live-built days, replay cutoff).
    const daily = (await stitchedRows(q.instrumentId, '1d', from, to, db)).map(toChart).filter((c) => known(c.openTime, DAY));
    const minuteFrom = Math.max(from, (daily.length ? daily[daily.length - 1].openTime + DAY : from));
    const mins = (await stitchedRows(q.instrumentId, '1m', minuteFrom, to, db)).map(toChart).filter((c) => known(c.openTime, MINUTE));
    const fromMinutes = aggregate(mins, '1d');
    const byDay = new Map<number, ChartCandle>();
    for (const d of daily) byDay.set(d.openTime, d);
    for (const d of fromMinutes) if (!byDay.has(d.openTime)) byDay.set(d.openTime, d);
    bars = markStitches([...byDay.values()].sort((a, b) => a.openTime - b.openTime).map((c) => ({ ...c, stitch: undefined })));
  } else {
    const mins = (await stitchedRows(q.instrumentId, '1m', from, to, db)).map(toChart).filter((c) => known(c.openTime, MINUTE));
    bars = q.interval === '1m' ? markStitches(mins) : aggregate(mins, q.interval);
  }
  return bars.filter((b) => b.openTime < to).slice(-limit);
}

/** Has this contract got candles stored for the IST date range? Used to avoid refetching history. */
export async function hasCandles(contractId: number, interval: StoredInterval, from: number, to: number, db: Db = pool): Promise<boolean> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (SELECT 1 FROM candles WHERE contract_id = $1 AND interval = $2 AND open_time >= $3 AND open_time < $4 LIMIT 1) x`,
    [contractId, interval, new Date(from), new Date(to)],
    db,
  );
  return rows[0].n > 0;
}
