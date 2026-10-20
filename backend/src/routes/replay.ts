import { Router } from 'express';
import { z } from 'zod';
import { replay } from '../context.js';
import { authed, h, requireAuth } from '../lib/http.js';
import { body, idParam, parse, queryOf } from '../lib/validate.js';
import { INTERVALS } from '../market/types.js';

export const replayRouter = Router();
replayRouter.use(requireAuth);

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

replayRouter.post(
  '/replay',
  h(async (req, res) => {
    const input = body(req, z.object({ instrument: z.string(), from: date, to: date, step: z.enum(['1m', '5m', '15m', '1h', '1d']).default('5m'), speed: z.number().int().default(5) }));
    res.status(201).json({ session: await replay().create(authed(req).id, input) });
  }),
);

replayRouter.get(
  '/replay/current',
  h(async (req, res) => {
    res.json({ session: await replay().active(authed(req).id) });
  }),
);

replayRouter.get(
  '/replay/sessions',
  h(async (req, res) => {
    res.json({ sessions: await replay().list(authed(req).id) });
  }),
);

replayRouter.get(
  '/replay/:id',
  h(async (req, res) => {
    const r = replay();
    res.json({ session: await r.view(await r.session(parse(idParam, req.params.id), authed(req).id)) });
  }),
);

replayRouter.get(
  '/replay/:id/candles',
  h(async (req, res) => {
    const q = queryOf(req, z.object({ interval: z.enum(INTERVALS as [string, ...string[]]).default('5m'), limit: z.coerce.number().int().min(1).max(5000).default(500) }));
    res.json({ candles: await replay().candles(parse(idParam, req.params.id), authed(req).id, q.interval as any, q.limit) });
  }),
);

replayRouter.get(
  '/replay/:id/market-stats',
  h(async (req, res) => {
    res.json({ stats: await replay().marketStats(parse(idParam, req.params.id), authed(req).id) });
  }),
);

const action = (fn: (id: number, userId: number, b: any) => Promise<unknown>) =>
  h(async (req, res) => {
    res.json({ session: await fn(parse(idParam, req.params.id), authed(req).id, req.body ?? {}) });
  });

replayRouter.post('/replay/:id/play', action((id, u) => replay().play(id, u)));
replayRouter.post('/replay/:id/pause', action((id, u) => replay().pause(id, u)));
replayRouter.post('/replay/:id/step', action((id, u, b) => replay().step(id, u, parse(z.number().int().min(1).max(500).default(1), b.count))));
replayRouter.post('/replay/:id/speed', action((id, u, b) => replay().setSpeed(id, u, parse(z.number().int(), b.speed))));
replayRouter.post('/replay/:id/end', action((id, u) => replay().end(id, u)));
