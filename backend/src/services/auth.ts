import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool, query, queryOne, tx } from '../db/pool.js';
import { AppError, badRequest, conflict, unauthorized } from '../lib/errors.js';
import { createAccount } from './accounts.js';

export interface UserRow {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: 'user' | 'admin';
  disabled: boolean;
  email_verified: boolean;
  verify_token: string | null;
  onboarded: boolean;
  token_version: number;
  created_at: Date;
  last_login_at: Date | null;
}

export interface AuthUser {
  id: number;
  role: 'user' | 'admin';
  name: string;
  email: string;
}

interface Claims {
  sub: string;
  role: string;
  tv: number;
}

export function signToken(user: Pick<UserRow, 'id' | 'role' | 'token_version'>): string {
  return jwt.sign({ role: user.role, tv: user.token_version } satisfies Omit<Claims, 'sub'>, config.JWT_SECRET, {
    subject: String(user.id),
    expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export async function verifyToken(token: string): Promise<AuthUser> {
  let claims: Claims;
  try {
    claims = jwt.verify(token, config.JWT_SECRET) as Claims;
  } catch {
    throw unauthorized('Your session has expired. Please log in again.');
  }
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [Number(claims.sub)]);
  if (!user || user.token_version !== claims.tv) throw unauthorized('Your session has ended. Please log in again.');
  if (user.disabled) throw new AppError(403, 'account_disabled', 'This account has been disabled.');
  return { id: user.id, role: user.role, name: user.name, email: user.email };
}

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);

export async function signup(name: string, email: string, password: string) {
  const existing = await queryOne('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email]);
  if (existing) throw conflict('email_taken', 'An account with this email already exists.');
  const hash = await hashPassword(password);
  const verifyToken = config.EMAIL_VERIFICATION ? crypto.randomBytes(24).toString('hex') : null;
  const user = await tx(async (c) => {
    const u = await queryOne<UserRow>(
      `INSERT INTO users (name, email, password_hash, email_verified, verify_token)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name.trim(), email.trim(), hash, !config.EMAIL_VERIFICATION, verifyToken],
      c,
    );
    await createAccount(c, u!.id, 'live');
    return u!;
  });
  if (config.EMAIL_VERIFICATION) {
    // No mail transport is configured for local demos; the link is logged for the operator.
    console.log(`[auth] verification link for ${user.email}: /api/auth/verify?token=${verifyToken}`);
  }
  return user;
}

export async function login(email: string, password: string) {
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [email.trim()]);
  // Compare against a dummy hash for unknown emails so timing does not reveal which emails exist.
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Email or password is incorrect.');
  if (user.disabled) throw new AppError(403, 'account_disabled', 'This account has been disabled.');
  if (config.EMAIL_VERIFICATION && !user.email_verified) {
    throw new AppError(403, 'email_unverified', 'Please verify your email address first.');
  }
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  return user;
}

export async function changePassword(userId: number, current: string, next: string) {
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user || !(await bcrypt.compare(current, user.password_hash))) {
    throw badRequest('wrong_password', 'Your current password is incorrect.');
  }
  // Bumping token_version logs out every other session.
  const updated = await queryOne<UserRow>(
    'UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1 RETURNING *',
    [userId, await hashPassword(next)],
  );
  return updated!;
}

export async function verifyEmail(token: string) {
  const u = await queryOne<UserRow>(
    'UPDATE users SET email_verified = TRUE, verify_token = NULL WHERE verify_token = $1 RETURNING *',
    [token],
  );
  if (!u) throw badRequest('invalid_token', 'This verification link is invalid or already used.');
  return u;
}

export async function seedAdmin(log = console.log) {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
    log('[auth] ADMIN_EMAIL / ADMIN_PASSWORD not set; skipping admin seed');
    return;
  }
  const existing = await queryOne<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [config.ADMIN_EMAIL]);
  if (existing) {
    if (existing.role !== 'admin') await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [existing.id]);
    return;
  }
  const user = await signup(config.ADMIN_NAME, config.ADMIN_EMAIL, config.ADMIN_PASSWORD);
  await pool.query(`UPDATE users SET role = 'admin', email_verified = TRUE, onboarded = TRUE WHERE id = $1`, [user.id]);
  log(`[auth] seeded admin ${config.ADMIN_EMAIL}`);
}

export function userView(u: UserRow) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    onboarded: u.onboarded,
    emailVerified: u.email_verified,
    createdAt: u.created_at,
  };
}
