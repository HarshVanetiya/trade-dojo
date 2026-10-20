import { Router } from 'express';
import { z } from 'zod';
import { md } from '../context.js';
import { notFound } from '../lib/errors.js';
import { h, requireAuth } from '../lib/http.js';
import { queryOf } from '../lib/validate.js';
import { getCandles } from '../market/candles.js';
import { INTERVALS } from '../market/types.js';
import { depthView, instrumentView, marketStats, quoteView } from '../market/views.js';

export const marketRouter = Router();

const instQ = z.object({ instrument: z.string().min(1).max(20) });

function inst(code: string) {
  const i = md().instrumentByCode(code);
  if (!i || !i.enabled) throw notFound('Instrument');
  return i;
}

marketRouter.get(
  '/instruments',
  requireAuth,
  h(async (_req, res) => {
    const m = md();
    res.json({ instruments: m.instruments.filter((i) => i.enabled).map((i) => instrumentView(m, i)), source: 'MCX via Upstox', provider: m.provider.name });
  }),
);

marketRouter.get(
  '/prices/latest',
  requireAuth,
  h(async (req, res) => {
    const i = inst(queryOf(req, instQ).instrument);
    res.json({ quote: quoteView(i, md().getQuote(i.id), md().activeContract(i.id)), market: md().marketStatus(i.id) });
  }),
);

marketRouter.get(
  '/depth',
  requireAuth,
  h(async (req, res) => {
    const i = inst(queryOf(req, instQ).instrument);
    res.json({ depth: depthView(i, md().getQuote(i.id)) });
  }),
);

marketRouter.get(
  '/candles',
  requireAuth,
  h(async (req, res) => {
    const q = queryOf(
      req,
      instQ.extend({
        interval: z.enum(INTERVALS as [string, ...string[]]).default('5m'),
        from: z.coerce.number().int().optional(),
        to: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(5000).default(500),
      }),
    );
    const i = inst(q.instrument);
    const candles = await getCandles({ instrumentId: i.id, interval: q.interval as any, from: q.from, to: q.to, limit: q.limit });
    res.json({ instrument: i.code, interval: q.interval, candles });
  }),
);

marketRouter.get(
  '/market/stats',
  requireAuth,
  h(async (req, res) => {
    const i = inst(queryOf(req, instQ).instrument);
    res.json({ stats: await marketStats(md(), i) });
  }),
);
