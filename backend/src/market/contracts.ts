import { type Db, pool, query, queryOne } from '../db/pool.js';
import { addDays, istDate } from '../lib/time.js';
import { pickActiveContract, rolloverDate } from './contractResolver.js';
import type { ContractInfo } from './types.js';

export interface InstrumentRow {
  id: number;
  code: 'GOLD' | 'SILVER';
  display_name: string;
  underlying: 'GOLD' | 'SILVER';
  product_symbol: string;
  price_unit_label: string;
  unit_grams: number;
  qty_unit: string;
  qty_step: number;
  qty_min: number;
  qty_max: number;
  fallback_spread_paise: number;
  brokerage_paise: number;
  tick_size_paise: number;
  enabled: boolean;
  sort_order: number;
}

export interface ContractRow {
  id: number;
  instrument_id: number;
  instrument_key: string;
  product: string;
  trading_symbol: string;
  underlying_key: string | null;
  expiry: string;
  lot_size: number | null;
  tick_size_paise: number | null;
  is_active: boolean;
  is_expired: boolean;
  rollover_date: string;
  activated_at: Date | null;
}

const CONTRACT_COLS = `id, instrument_id, instrument_key, product, trading_symbol, underlying_key,
  to_char(expiry, 'YYYY-MM-DD') AS expiry, lot_size, tick_size_paise, is_active, is_expired,
  to_char(rollover_date, 'YYYY-MM-DD') AS rollover_date, activated_at`;

export async function listInstruments(db: Db = pool): Promise<InstrumentRow[]> {
  return query<InstrumentRow>('SELECT * FROM instruments ORDER BY sort_order, id', [], db);
}

export async function upsertContracts(instrumentId: number, contracts: ContractInfo[], rolloverDays: number, opts: { expired?: boolean } = {}, db: Db = pool) {
  const today = istDate(Date.now());
  for (const c of contracts) {
    await query(
      `INSERT INTO contracts (instrument_id, instrument_key, product, trading_symbol, underlying_key, expiry, lot_size, tick_size_paise, rollover_date, is_expired)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (instrument_key) DO UPDATE SET
         trading_symbol = EXCLUDED.trading_symbol,
         underlying_key = COALESCE(EXCLUDED.underlying_key, contracts.underlying_key),
         expiry = EXCLUDED.expiry, lot_size = EXCLUDED.lot_size,
         tick_size_paise = COALESCE(EXCLUDED.tick_size_paise, contracts.tick_size_paise),
         rollover_date = EXCLUDED.rollover_date,
         is_expired = EXCLUDED.is_expired`,
      [instrumentId, c.instrumentKey, c.product, c.tradingSymbol, c.underlyingKey, c.expiry, c.lotSize, c.tickSizePaise,
        rolloverDate(c.expiry, rolloverDays), opts.expired || c.expiry < today],
      db,
    );
  }
}

export async function recomputeRolloverDates(rolloverDays: number, db: Db = pool) {
  await query(`UPDATE contracts SET rollover_date = expiry - $1::int`, [rolloverDays], db);
}

export async function contractsFor(instrumentId: number, product: string, db: Db = pool): Promise<ContractRow[]> {
  return query<ContractRow>(`SELECT ${CONTRACT_COLS} FROM contracts WHERE instrument_id = $1 AND product = $2 ORDER BY expiry`, [instrumentId, product], db);
}

export async function allContracts(instrumentId: number, db: Db = pool): Promise<ContractRow[]> {
  return query<ContractRow>(`SELECT ${CONTRACT_COLS} FROM contracts WHERE instrument_id = $1 ORDER BY expiry`, [instrumentId], db);
}

export async function activeContract(instrumentId: number, db: Db = pool): Promise<ContractRow | null> {
  return queryOne<ContractRow>(`SELECT ${CONTRACT_COLS} FROM contracts WHERE instrument_id = $1 AND is_active`, [instrumentId], db);
}

export async function contractById(id: number, db: Db = pool): Promise<ContractRow | null> {
  return queryOne<ContractRow>(`SELECT ${CONTRACT_COLS} FROM contracts WHERE id = $1`, [id], db);
}

/** Which contract should be active today for this instrument's configured product. */
export async function targetContract(inst: InstrumentRow, rolloverDays: number, today = istDate(Date.now()), db: Db = pool): Promise<ContractRow | null> {
  const rows = await contractsFor(inst.id, inst.product_symbol, db);
  const pick = pickActiveContract(
    rows.map((r) => ({ instrumentKey: r.instrument_key, product: r.product, tradingSymbol: r.trading_symbol, underlyingKey: r.underlying_key, expiry: r.expiry, lotSize: r.lot_size, tickSizePaise: r.tick_size_paise })),
    today,
    rolloverDays,
  );
  return pick ? rows.find((r) => r.instrument_key === pick.instrumentKey) ?? null : null;
}

export async function setActiveContract(instrumentId: number, contractId: number, db: Db = pool) {
  await query(`UPDATE contracts SET is_active = FALSE, deactivated_at = now() WHERE instrument_id = $1 AND is_active AND id <> $2`, [instrumentId, contractId], db);
  await query(`UPDATE contracts SET is_active = TRUE, activated_at = COALESCE(activated_at, now()), deactivated_at = NULL WHERE id = $1`, [contractId], db);
}

export function daysToExpiry(expiry: string, now = Date.now()): number {
  return Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${istDate(now)}T00:00:00Z`)) / 86_400_000);
}

export function rolloverNoticeDue(c: Pick<ContractRow, 'rollover_date'>, noticeDays: number, today = istDate(Date.now())): boolean {
  return today >= addDays(c.rollover_date, -noticeDays) && today < c.rollover_date;
}
