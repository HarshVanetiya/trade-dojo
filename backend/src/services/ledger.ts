import type { Db } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';

export type LedgerKind =
  | 'initial'
  | 'reserve'
  | 'release'
  | 'realized_pnl'
  | 'brokerage'
  | 'grant'
  | 'season_close';

export interface AccountRow {
  id: number;
  user_id: number;
  mode: 'live' | 'replay';
  season: number;
  starting_points: number;
  cash_available: number;
  cash_reserved: number;
  is_active: boolean;
  created_at: Date;
}

export interface LedgerEntry {
  kind: LedgerKind;
  /** Change to cash_available (paise). */
  available: number;
  /** Change to cash_reserved (paise). */
  reserved?: number;
  refType?: string;
  refId?: number;
  note?: string;
  createdBy?: number | null;
}

/**
 * The only way balances change. Updates the account row and appends a ledger row in the
 * caller's transaction. CHECK constraints reject any change that would make a balance negative.
 */
export async function applyLedger(db: Db, accountId: number, e: LedgerEntry): Promise<AccountRow> {
  const reserved = e.reserved ?? 0;
  if (e.available === 0 && reserved === 0) {
    const cur = await db.query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [accountId]);
    return cur.rows[0];
  }
  let acc: AccountRow;
  try {
    const res = await db.query<AccountRow>(
      `UPDATE accounts SET cash_available = cash_available + $2, cash_reserved = cash_reserved + $3
       WHERE id = $1 RETURNING *`,
      [accountId, e.available, reserved],
    );
    acc = res.rows[0];
  } catch (err: any) {
    if (err?.code === '23514') throw badRequest('insufficient_points', 'Not enough free points for this.');
    throw err;
  }
  if (!acc) throw new Error(`account ${accountId} not found`);
  await db.query(
    `INSERT INTO points_ledger (account_id, user_id, kind, amount, balance_after, reserved_after, ref_type, ref_id, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [acc.id, acc.user_id, e.kind, e.available, acc.cash_available, acc.cash_reserved, e.refType ?? null, e.refId ?? null, e.note ?? null, e.createdBy ?? null],
  );
  return acc;
}
