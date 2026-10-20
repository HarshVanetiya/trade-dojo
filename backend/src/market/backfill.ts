import { query } from '../db/pool.js';
import { addDays, DAY, istDate, istInstant } from '../lib/time.js';
import { getSettings } from '../services/settings.js';
import { hasCandles, upsertCandles } from './candles.js';
import { allContracts, type ContractRow, type InstrumentRow, upsertContracts } from './contracts.js';
import type { MarketData } from './marketData.js';
import type { ContractInfo, StoredInterval } from './types.js';
import { chunkHistoryRange } from './upstox/historyChunks.js';

export interface BackfillProgress {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  chunksTotal: number;
  chunksDone: number;
  candlesSaved: number;
  current: string | null;
  errors: string[];
}

export const backfillProgress: BackfillProgress = {
  running: false,
  startedAt: null,
  finishedAt: null,
  chunksTotal: 0,
  chunksDone: 0,
  candlesSaved: 0,
  current: null,
  errors: [],
};

const toInfo = (c: ContractRow): ContractInfo => ({
  instrumentKey: c.instrument_key,
  product: c.product,
  tradingSymbol: c.trading_symbol,
  underlyingKey: c.underlying_key,
  expiry: c.expiry,
  lotSize: c.lot_size,
  tickSizePaise: c.tick_size_paise,
});

/** Near-month window of each contract: from the previous contract's rollover date to its own. */
export function nearMonthWindows(contracts: ContractRow[], today: string): Array<{ contract: ContractRow; from: string; to: string }> {
  const sorted = [...contracts].sort((a, b) => a.expiry.localeCompare(b.expiry));
  const out: Array<{ contract: ContractRow; from: string; to: string }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const from = i === 0 ? addDays(c.rollover_date, -45) : sorted[i - 1].rollover_date;
    const to = addDays(c.rollover_date, -1);
    if (from > today) break; // future contracts are not needed for history
    out.push({ contract: c, from, to: c.is_active ? today : to });
  }
  return out;
}

async function loadExpiredContracts(md: MarketData, inst: InstrumentRow) {
  const provider = md.provider;
  if (!provider.listExpiredContracts) return;
  const rows = await allContracts(inst.id);
  const sample = rows.find((r) => r.product === inst.product_symbol && r.underlying_key);
  if (!sample) return;
  const expired = await provider.listExpiredContracts(inst.product_symbol, toInfo(sample));
  if (expired.length) await upsertContracts(inst.id, expired, getSettings().rollover_days, { expired: true });
}

async function jobDone(contractId: number, interval: string, from: string, to: string): Promise<boolean> {
  const rows = await query(`SELECT 1 FROM backfill_jobs WHERE contract_id = $1 AND interval = $2 AND from_date = $3 AND to_date = $4 AND status = 'done'`, [contractId, interval, from, to]);
  return rows.length > 0;
}

/**
 * Fetch and store history for [fromDate, toDate] as a continuous near-month series.
 * Chunks already stored (and fully in the past) are skipped, so this is cheap to call repeatedly.
 */
export async function backfillRange(md: MarketData, inst: InstrumentRow, interval: StoredInterval, fromDate: string, toDate: string): Promise<number> {
  const today = istDate(md.clock());
  const contracts = (await allContracts(inst.id)).filter((c) => c.product === inst.product_symbol);
  const windows = nearMonthWindows(contracts, today);
  let saved = 0;
  const jobs: Array<{ contract: ContractRow; from: string; to: string }> = [];
  for (const w of windows) {
    // The active contract is fetched for the whole range: it is the fallback where older contracts are unavailable.
    const from = w.contract.is_active ? fromDate : (w.from > fromDate ? w.from : fromDate);
    const to = w.to < toDate ? w.to : toDate;
    if (from > to) continue;
    for (const ch of chunkHistoryRange(interval, from, to)) jobs.push({ contract: w.contract, from: ch.from, to: ch.to });
  }
  backfillProgress.chunksTotal += jobs.length;
  for (const j of jobs) {
    const fromMs = istInstant(j.from, '00:00').getTime();
    const toMs = istInstant(j.to, '00:00').getTime() + DAY - 1;
    backfillProgress.current = `${j.contract.trading_symbol} ${interval} ${j.from}..${j.to}`;
    try {
      const complete = j.to < today && ((await jobDone(j.contract.id, interval, j.from, j.to)) || (await hasCandles(j.contract.id, interval, fromMs, toMs)));
      if (!complete) {
        const candles = await md.provider.getHistory(toInfo(j.contract), new Date(fromMs), new Date(toMs), interval, { expired: j.contract.is_expired });
        const source = md.provider.name === 'mock' ? 'mock' : 'history';
        const n = await upsertCandles(inst.id, j.contract.id, interval, candles, source);
        saved += n;
        backfillProgress.candlesSaved += n;
        await query(
          `INSERT INTO backfill_jobs (contract_id, interval, from_date, to_date, status, chunks_total, chunks_done, candles_saved, updated_at)
           VALUES ($1, $2, $3, $4, 'done', 1, 1, $5, now())
           ON CONFLICT (contract_id, interval, from_date, to_date) DO UPDATE SET status = 'done', candles_saved = EXCLUDED.candles_saved, error = NULL, updated_at = now()`,
          [j.contract.id, interval, j.from, j.to, n],
        );
      }
    } catch (err) {
      const msg = `${backfillProgress.current}: ${(err as Error).message}`;
      backfillProgress.errors.unshift(msg);
      backfillProgress.errors.length = Math.min(backfillProgress.errors.length, 20);
      md.recordError(`Backfill ${msg}`);
      await query(
        `INSERT INTO backfill_jobs (contract_id, interval, from_date, to_date, status, error, updated_at)
         VALUES ($1, $2, $3, $4, 'failed', $5, now())
         ON CONFLICT (contract_id, interval, from_date, to_date) DO UPDATE SET status = 'failed', error = EXCLUDED.error, updated_at = now()`,
        [j.contract.id, interval, j.from, j.to, (err as Error).message],
      ).catch(() => {});
    }
    backfillProgress.chunksDone += 1;
  }
  return saved;
}

/** First-run backfill: 2 years of daily and 3 months of 1-minute candles per instrument. */
export async function runBackfill(md: MarketData, opts: { dailyDays?: number; minuteDays?: number; log?: (m: string) => void } = {}) {
  if (backfillProgress.running) return backfillProgress;
  const log = opts.log ?? ((m: string) => console.log(`[backfill] ${m}`));
  Object.assign(backfillProgress, { running: true, startedAt: new Date().toISOString(), finishedAt: null, chunksTotal: 0, chunksDone: 0, candlesSaved: 0, errors: [] });
  try {
    const today = istDate(md.clock());
    for (const inst of md.instruments.filter((i) => i.enabled)) {
      await loadExpiredContracts(md, inst).catch((err) => md.recordError(`Expired contracts for ${inst.code}: ${err.message}`));
      const d = await backfillRange(md, inst, '1d', addDays(today, -(opts.dailyDays ?? 730)), today);
      const m = await backfillRange(md, inst, '1m', addDays(today, -(opts.minuteDays ?? 90)), today);
      log(`${inst.code}: saved ${d} daily and ${m} 1-minute candles`);
    }
  } finally {
    backfillProgress.running = false;
    backfillProgress.current = null;
    backfillProgress.finishedAt = new Date().toISOString();
  }
  return backfillProgress;
}

/** Make sure a replay range is stored (shared cache; never refetched once stored). */
export async function ensureHistory(md: MarketData, inst: InstrumentRow, from: number, to: number, interval: StoredInterval) {
  await backfillRange(md, inst, interval, istDate(from), istDate(to));
}
