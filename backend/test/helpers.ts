import { pool, query } from '../src/db/pool.js';
import { signup } from '../src/services/auth.js';
import { setSettingsForTest } from '../src/services/settings.js';

let counter = 0;

/** Wipe all mutable data, keeping instruments and migrations. */
export async function resetDb() {
  await pool.query(`TRUNCATE users, settings, contracts, market_holidays, price_ticks, candles, accounts, replay_sessions,
    positions, position_events, orders, fills, trades, trade_reviews, trade_notes, drawings, points_ledger, backfill_jobs
    RESTART IDENTITY CASCADE`);
  await pool.query(`UPDATE instruments SET fallback_spread_paise = CASE code WHEN 'GOLD' THEN 300 ELSE 2000 END, brokerage_paise = 0,
    product_symbol = CASE code WHEN 'GOLD' THEN 'GOLDM' ELSE 'SILVERM' END`);
  setSettingsForTest({ starting_points: 10_000_000, rollover_days: 3, reset_cooldown_days: 7, reset_threshold_pct: 10, overtrading_limit: 5 });
}

export async function makeUser(name = 'Trader') {
  counter += 1;
  return signup(name, `user${counter}-${Date.now()}@test`, 'password123');
}

export async function instrumentId(code: 'GOLD' | 'SILVER'): Promise<number> {
  const rows = await query<{ id: number }>('SELECT id FROM instruments WHERE code = $1', [code]);
  return rows[0].id;
}
