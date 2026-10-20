import { Router } from 'express';
import { z } from 'zod';
import { md } from '../context.js';
import { query, queryOne } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { authed, h, requireAuth } from '../lib/http.js';
import { body, idParam, parse, queryOf } from '../lib/validate.js';

const point = z.object({ time: z.number().int(), price: z.number().int().positive() });
const drawingData = z.union([
  z.object({ price: z.number().int().positive(), label: z.string().max(40).optional(), color: z.string().max(20).optional() }),
  z.object({ p1: point, p2: point, color: z.string().max(20).optional() }),
]);

export const drawingsRouter = Router();
drawingsRouter.use(requireAuth);

function instId(code: string) {
  const i = md().instrumentByCode(code);
  if (!i) throw notFound('Instrument');
  return i.id;
}

const view = (r: any) => ({ id: r.id, kind: r.kind, data: r.data, createdAt: r.created_at });

drawingsRouter.get(
  '/drawings',
  h(async (req, res) => {
    const q = queryOf(req, z.object({ instrument: z.string() }));
    const rows = await query('SELECT * FROM drawings WHERE user_id = $1 AND instrument_id = $2 ORDER BY id', [authed(req).id, instId(q.instrument)]);
    res.json({ drawings: rows.map(view) });
  }),
);

drawingsRouter.post(
  '/drawings',
  h(async (req, res) => {
    const input = body(req, z.object({ instrument: z.string(), kind: z.enum(['hline', 'trend']), data: drawingData }));
    if ((input.kind === 'hline') !== ('price' in input.data)) throw badRequest('invalid_drawing', 'Drawing data does not match its kind.');
    const user = authed(req);
    const count = await queryOne<{ n: number }>('SELECT count(*)::int AS n FROM drawings WHERE user_id = $1', [user.id]);
    if (count!.n >= 200) throw badRequest('too_many_drawings', 'You have reached the limit of 200 drawings. Delete some first.');
    const row = await queryOne('INSERT INTO drawings (user_id, instrument_id, kind, data) VALUES ($1, $2, $3, $4) RETURNING *', [user.id, instId(input.instrument), input.kind, JSON.stringify(input.data)]);
    res.status(201).json({ drawing: view(row) });
  }),
);

drawingsRouter.patch(
  '/drawings/:id',
  h(async (req, res) => {
    const input = body(req, z.object({ data: drawingData }));
    const row = await queryOne('UPDATE drawings SET data = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *', [parse(idParam, req.params.id), authed(req).id, JSON.stringify(input.data)]);
    if (!row) throw notFound('Drawing');
    res.json({ drawing: view(row) });
  }),
);

drawingsRouter.delete(
  '/drawings/:id',
  h(async (req, res) => {
    const rows = await query('DELETE FROM drawings WHERE id = $1 AND user_id = $2 RETURNING id', [parse(idParam, req.params.id), authed(req).id]);
    if (!rows.length) throw notFound('Drawing');
    res.json({ ok: true });
  }),
);
