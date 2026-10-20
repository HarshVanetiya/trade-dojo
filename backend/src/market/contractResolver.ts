import { addDays, istDate } from '../lib/time.js';
import type { ContractInfo } from './types.js';

/** One record of the Upstox instruments master file (only the fields we use). */
export interface UpstoxInstrumentRecord {
  segment?: string;
  exchange?: string;
  instrument_type?: string;
  instrument_key?: string;
  trading_symbol?: string;
  name?: string;
  underlying_symbol?: string;
  asset_symbol?: string;
  underlying_key?: string;
  asset_key?: string;
  expiry?: number | string;
  lot_size?: number;
  tick_size?: number;
}

function expiryDate(v: number | string | undefined): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return istDate(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const n = Number(v);
  return Number.isFinite(n) ? istDate(n) : null;
}

function productOf(r: UpstoxInstrumentRecord): string | null {
  return (r.underlying_symbol || r.asset_symbol || r.trading_symbol?.split(' ')[0] || r.name || null)?.toUpperCase() ?? null;
}

/** Futures contracts for the requested MCX products, sorted by expiry. */
export function extractFutures(records: UpstoxInstrumentRecord[], products: string[]): ContractInfo[] {
  const want = new Set(products.map((p) => p.toUpperCase()));
  const out: ContractInfo[] = [];
  for (const r of records) {
    if (r.instrument_type !== 'FUT') continue;
    if (r.segment && r.segment !== 'MCX_FO') continue;
    if (r.exchange && r.exchange !== 'MCX') continue;
    const product = productOf(r);
    if (!product || !want.has(product) || !r.instrument_key) continue;
    const expiry = expiryDate(r.expiry);
    if (!expiry) continue;
    out.push({
      instrumentKey: r.instrument_key,
      product,
      tradingSymbol: r.trading_symbol ?? `${product} FUT ${expiry}`,
      underlyingKey: r.underlying_key ?? r.asset_key ?? null,
      expiry,
      lotSize: r.lot_size ?? null,
      // Upstox reports tick_size in paise.
      tickSizePaise: r.tick_size ? Math.round(r.tick_size) : null,
    });
  }
  return out.sort((a, b) => a.expiry.localeCompare(b.expiry) || a.instrumentKey.localeCompare(b.instrumentKey));
}

/** The date on which we stop tracking a contract and switch to the next one. */
export function rolloverDate(expiry: string, rolloverDays: number): string {
  return addDays(expiry, -rolloverDays);
}

/**
 * Near-month contract to track on `today` (IST date): the earliest-expiring contract whose
 * rollover date is still in the future. On the rollover date itself we already use the next one.
 */
export function pickActiveContract(contracts: ContractInfo[], today: string, rolloverDays: number): ContractInfo | null {
  const sorted = [...contracts].sort((a, b) => a.expiry.localeCompare(b.expiry));
  return sorted.find((c) => rolloverDate(c.expiry, rolloverDays) > today) ?? null;
}
