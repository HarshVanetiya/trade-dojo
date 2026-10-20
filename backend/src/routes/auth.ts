import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { authed, h, requireAuth } from '../lib/http.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { body } from '../lib/validate.js';
import { getActiveAccount, accountView } from '../services/accounts.js';
import { changePassword, login, signToken, signup, userView, verifyEmail, type UserRow } from '../services/auth.js';

const loginLimiter = new RateLimiter(10, 15 * 60_000);
const signupLimiter = new RateLimiter(20, 60 * 60_000);

// Deliberately permissive: local demo accounts use addresses like demo1@local.
const email = z.string().trim().toLowerCase().regex(/^[^\s@]+@[^\s@]+$/, 'Enter a valid email address').max(200);
const password = z.string().min(8, 'Password must be at least 8 characters').max(200);

export const authRouter = Router();

authRouter.post(
  '/signup',
  h(async (req, res) => {
    signupLimiter.check(req.ip ?? 'unknown');
    const input = body(req, z.object({ name: z.string().trim().min(1, 'Name is required').max(80), email, password, acceptTerms: z.literal(true, 'Please accept the terms') }));
    const user = await signup(input.name, input.email, input.password);
    if (config.EMAIL_VERIFICATION) {
      res.status(201).json({ needsVerification: true, user: userView(user) });
      return;
    }
    res.status(201).json({ token: signToken(user), user: userView(user) });
  }),
);

authRouter.post(
  '/login',
  h(async (req, res) => {
    const input = body(req, z.object({ email, password: z.string().min(1).max(200) }));
    const key = `${req.ip}:${input.email}`;
    loginLimiter.check(key);
    const user = await login(input.email, input.password);
    loginLimiter.reset(key);
    res.json({ token: signToken(user), user: userView(user) });
  }),
);

authRouter.get(
  '/verify',
  h(async (req, res) => {
    const token = z.string().min(10).parse(req.query.token);
    await verifyEmail(token);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/logout',
  requireAuth,
  h(async (_req, res) => {
    // Tokens are stateless and stored in sessionStorage; the client drops it. Nothing to revoke per-tab.
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/change-password',
  requireAuth,
  h(async (req, res) => {
    const input = body(req, z.object({ currentPassword: z.string().min(1), newPassword: password }));
    const user = await changePassword(authed(req).id, input.currentPassword, input.newPassword);
    res.json({ token: signToken(user), user: userView(user) });
  }),
);

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get(
  '/',
  h(async (req, res) => {
    const u = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [authed(req).id]);
    const live = await getActiveAccount(u!.id, 'live');
    res.json({ user: userView(u!), account: accountView(live) });
  }),
);

meRouter.patch(
  '/',
  h(async (req, res) => {
    const input = body(req, z.object({ name: z.string().trim().min(1).max(80).optional(), onboarded: z.boolean().optional() }));
    const u = await queryOne<UserRow>(
      `UPDATE users SET name = COALESCE($2, name), onboarded = COALESCE($3, onboarded) WHERE id = $1 RETURNING *`,
      [authed(req).id, input.name ?? null, input.onboarded ?? null],
    );
    res.json({ user: userView(u!) });
  }),
);

meRouter.get(
  '/ledger',
  h(async (req, res) => {
    const mode = z.enum(['live', 'replay']).default('live').parse(req.query.mode);
    const acc = await getActiveAccount(authed(req).id, mode);
    const rows = await query(
      `SELECT id, kind, amount, balance_after, reserved_after, ref_type, ref_id, note, created_at
       FROM points_ledger WHERE account_id = $1 ORDER BY id DESC LIMIT 200`,
      [acc.id],
    );
    res.json({ entries: rows });
  }),
);
