import { Router } from 'express';
import { z } from 'zod';
import { engine } from '../context.js';
import { authed, h, requireAuth } from '../lib/http.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { body, idParam, parse, queryOf } from '../lib/validate.js';
import { getActiveAccount, resetAccount, resetEligibility } from '../services/accounts.js';
import { SETUP_TAGS } from '../engine/engine.js';

const orderLimiter = new RateLimiter(30, 60_000);
const paise = z.number().int().positive();
const mode = z.enum(['live', 'replay']).default('live');

export const tradingRouter = Router();
tradingRouter.use(requireAuth);

tradingRouter.post(
  '/orders',
  h(async (req, res) => {
    const user = authed(req);
    orderLimiter.check(`order:${user.id}`);
    const input = body(
      req,
      z.object({
        mode,
        replaySessionId: z.number().int().positive().nullish(),
        instrument: z.string().min(1).max(20),
        direction: z.enum(['LONG', 'SHORT']),
        orderType: z.enum(['MARKET', 'LIMIT', 'STOP']).default('MARKET'),
        qty: z.number().int().positive(),
        triggerPrice: paise.nullish(),
        slPrice: paise.nullish(),
        tpPrice: paise.nullish(),
        trailPaise: paise.nullish(),
        setupTag: z.enum(SETUP_TAGS, 'Pick a setup tag for your trade plan'),
        planNote: z.string().trim().min(3, 'Write a short trade plan').max(1000),
        confidence: z.number().int().min(1).max(5),
      }),
    );
    const out = await engine().placeOrder(user.id, { ...input, qtyG: input.qty });
    res.status(201).json(out);
  }),
);

tradingRouter.get(
  '/orders',
  h(async (req, res) => {
    const q = queryOf(req, z.object({ mode, status: z.enum(['pending', 'filled', 'cancelled', 'rejected']).optional(), sessionId: z.coerce.number().int().optional() }));
    res.json({ orders: await engine().listOrders(authed(req).id, q.mode, { status: q.status, sessionId: q.sessionId }) });
  }),
);

const cancel = h(async (req, res) => {
  res.json({ order: await engine().cancelOrder(authed(req).id, parse(idParam, req.params.id)) });
});
tradingRouter.delete('/orders/:id', cancel);
tradingRouter.post('/orders/:id/cancel', cancel);

tradingRouter.get(
  '/positions',
  h(async (req, res) => {
    const q = queryOf(req, z.object({ mode, status: z.enum(['open', 'closed']).default('open'), sessionId: z.coerce.number().int().optional() }));
    res.json({ positions: await engine().listPositions(authed(req).id, q.mode, { status: q.status, sessionId: q.sessionId }) });
  }),
);

tradingRouter.patch(
  '/positions/:id',
  h(async (req, res) => {
    const input = body(req, z.object({ slPrice: paise.nullable().optional(), tpPrice: paise.nullable().optional(), trailPaise: paise.nullable().optional() }));
    res.json({ position: await engine().modifyPosition(authed(req).id, parse(idParam, req.params.id), input) });
  }),
);

tradingRouter.post(
  '/positions/:id/close',
  h(async (req, res) => {
    const user = authed(req);
    orderLimiter.check(`order:${user.id}`);
    const input = body(req, z.object({ qty: z.number().int().positive().optional() }));
    const out = await engine().closePosition(user.id, parse(idParam, req.params.id), input.qty);
    res.json({ position: out?.position ?? null, tradeId: out?.trade?.id ?? null });
  }),
);

tradingRouter.get(
  '/account',
  h(async (req, res) => {
    const q = queryOf(req, z.object({ mode }));
    const user = authed(req);
    res.json({ account: await engine().accountSnapshot(user.id, q.mode), reset: await resetEligibility(user.id, q.mode) });
  }),
);

tradingRouter.post(
  '/account/reset',
  h(async (req, res) => {
    const input = body(req, z.object({ mode }));
    const user = authed(req);
    await resetAccount(user.id, input.mode);
    const acc = await getActiveAccount(user.id, input.mode);
    res.json({ account: await engine().accountSnapshot(user.id, input.mode), season: acc.season });
  }),
);
