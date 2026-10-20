import { type Db, pool, query, queryOne, tx } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { DAY } from '../lib/time.js';
import { applyLedger, type AccountRow } from './ledger.js';
import { getSettings } from './settings.js';

export type Mode = 'live' | 'replay';

export async function createAccount(db: Db, userId: number, mode: Mode, season = 1, startingPoints?: number): Promise<AccountRow> {
  const start = startingPoints ?? getSettings().starting_points;
  const acc = await queryOne<AccountRow>(
    `INSERT INTO accounts (user_id, mode, season, starting_points, cash_available, cash_reserved)
     VALUES ($1, $2, $3, $4, 0, 0) RETURNING *`,
    [userId, mode, season, start],
    db,
  );
  return applyLedger(db, acc!.id, { kind: 'initial', available: start, note: `Season ${season} starting points` });
}

export async function getActiveAccount(userId: number, mode: Mode, db: Db = pool): Promise<AccountRow> {
  const acc = await queryOne<AccountRow>(
    'SELECT * FROM accounts WHERE user_id = $1 AND mode = $2 AND is_active',
    [userId, mode],
    db,
  );
  if (acc) return acc;
  return tx(async (c) => {
    // Lazily create (e.g. replay account on first use). The advisory lock serialises concurrent first requests.
    await c.query('SELECT pg_advisory_xact_lock(4242, $1)', [userId]);
    const again = await queryOne<AccountRow>('SELECT * FROM accounts WHERE user_id = $1 AND mode = $2 AND is_active FOR UPDATE', [userId, mode], c);
    if (again) return again;
    const last = await queryOne<{ season: number }>('SELECT max(season) AS season FROM accounts WHERE user_id = $1 AND mode = $2', [userId, mode], c);
    return createAccount(c, userId, mode, (last?.season ?? 0) + 1);
  });
}

export async function lockAccount(db: Db, accountId: number): Promise<AccountRow> {
  const acc = await queryOne<AccountRow>('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [accountId], db);
  if (!acc) throw notFound('Account');
  return acc;
}

export interface ResetEligibility {
  eligible: boolean;
  reason?: string;
  thresholdPaise: number;
  nextEligibleAt?: string;
}

export async function resetEligibility(userId: number, mode: Mode, now = new Date(), db: Db = pool): Promise<ResetEligibility> {
  const s = getSettings();
  const acc = await getActiveAccount(userId, mode, db);
  const threshold = Math.floor((acc.starting_points * s.reset_threshold_pct) / 100);
  if (mode === 'replay') return { eligible: true, thresholdPaise: 0 };
  const open = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM positions WHERE account_id = $1 AND status = 'open'`,
    [acc.id],
    db,
  );
  const equityFloor = acc.cash_available + acc.cash_reserved;
  if (open!.n > 0) return { eligible: false, reason: 'Close your open positions before resetting.', thresholdPaise: threshold };
  if (equityFloor >= threshold) {
    return {
      eligible: false,
      reason: `You can reset only when your balance is below ${s.reset_threshold_pct}% of your starting points.`,
      thresholdPaise: threshold,
    };
  }
  if (acc.season > 1) {
    const nextAt = new Date(acc.created_at.getTime() + s.reset_cooldown_days * DAY);
    if (nextAt > now) {
      return { eligible: false, reason: `You can reset once every ${s.reset_cooldown_days} days.`, thresholdPaise: threshold, nextEligibleAt: nextAt.toISOString() };
    }
  }
  return { eligible: true, thresholdPaise: threshold };
}

/** Start a new season: the old account is closed (history kept) and a fresh one opened. */
export async function resetAccount(userId: number, mode: Mode, now = new Date()): Promise<AccountRow> {
  const elig = await resetEligibility(userId, mode, now);
  if (!elig.eligible) throw conflict('reset_not_allowed', elig.reason ?? 'Reset not allowed.');
  return tx(async (c) => {
    const acc = await queryOne<AccountRow>('SELECT * FROM accounts WHERE user_id = $1 AND mode = $2 AND is_active FOR UPDATE', [userId, mode], c);
    if (!acc) throw notFound('Account');
    if (mode === 'replay') {
      const live = await queryOne(`SELECT 1 FROM replay_sessions WHERE user_id = $1 AND status <> 'ended'`, [userId], c);
      if (live) throw conflict('reset_not_allowed', 'End your replay session before resetting the replay balance.');
    }
    await applyLedger(c, acc.id, { kind: 'season_close', available: 0, note: `Season ${acc.season} closed` });
    await query('UPDATE accounts SET is_active = FALSE, closed_at = $2 WHERE id = $1', [acc.id, now], c);
    return createAccount(c, userId, mode, acc.season + 1);
  });
}

export async function grantPoints(adminId: number, userId: number, amountPaise: number, note: string): Promise<AccountRow> {
  if (!note.trim()) throw badRequest('note_required', 'A note is required when granting points.');
  const acc = await getActiveAccount(userId, 'live');
  return tx(async (c) => {
    await lockAccount(c, acc.id);
    return applyLedger(c, acc.id, { kind: 'grant', available: amountPaise, note, createdBy: adminId });
  });
}

export function accountView(acc: AccountRow, unrealizedPaise = 0) {
  return {
    id: acc.id,
    mode: acc.mode,
    season: acc.season,
    startingPoints: acc.starting_points,
    pointsFree: acc.cash_available,
    pointsUsed: acc.cash_reserved,
    unrealized: unrealizedPaise,
    equity: acc.cash_available + acc.cash_reserved + unrealizedPaise,
    createdAt: acc.created_at,
  };
}
