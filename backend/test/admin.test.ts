import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ctx } from '../src/context.js';
import { pool, query } from '../src/db/pool.js';
import { seedAdmin, signToken } from '../src/services/auth.js';
import { setSettingsForTest } from '../src/services/settings.js';
import { harness, R } from './engineHarness.js';
import { resetDb } from './helpers.js';

const app = createApp();

async function setup() {
  const h = await harness();
  ctx.md = h.md;
  ctx.engine = h.engine;
  await seedAdmin(() => {});
  const admin = (await query(`SELECT * FROM users WHERE role = 'admin'`))[0];
  const adminAuth = `Bearer ${signToken(admin)}`;
  const userRow = (await query('SELECT * FROM users WHERE id = $1', [h.user.id]))[0];
  const userAuth = `Bearer ${signToken(userRow)}`;
  return { h, adminAuth, userAuth };
}

describe('admin API', () => {
  beforeEach(resetDb);

  it('is admin-only', async () => {
    const { userAuth } = await setup();
    const r = await request(app).get('/api/admin/users').set('Authorization', userAuth);
    expect(r.status).toBe(403);
  });

  it('lists users, grants points with a note into the ledger, and disables accounts', async () => {
    const { h, adminAuth, userAuth } = await setup();
    const list = await request(app).get('/api/admin/users?q=user').set('Authorization', adminAuth);
    expect(list.status).toBe(200);
    expect(list.body.users.some((u: any) => u.id === h.user.id)).toBe(true);

    const noNote = await request(app).post(`/api/admin/users/${h.user.id}/grant`).set('Authorization', adminAuth).send({ points: 500, note: '' });
    expect(noNote.status).toBe(400);
    const g = await request(app).post(`/api/admin/users/${h.user.id}/grant`).set('Authorization', adminAuth).send({ points: 500, note: 'Workshop bonus' });
    expect(g.status).toBe(200);
    const ledger = await query(`SELECT kind, amount, note, created_by FROM points_ledger WHERE user_id = $1 AND kind = 'grant'`, [h.user.id]);
    expect(ledger).toEqual([{ kind: 'grant', amount: R(500), note: 'Workshop bonus', created_by: expect.any(Number) }]);

    const detail = await request(app).get(`/api/admin/users/${h.user.id}`).set('Authorization', adminAuth);
    expect(detail.body.stats.trades).toBe(0);

    const dis = await request(app).patch(`/api/admin/users/${h.user.id}`).set('Authorization', adminAuth).send({ disabled: true });
    expect(dis.body.user.disabled).toBe(true);
    expect((await request(app).get('/api/me').set('Authorization', userAuth)).status).toBe(401);
  });

  it('updates settings and instrument spreads, and reports feed health', async () => {
    const { adminAuth } = await setup();
    const s = await request(app).put('/api/admin/settings').set('Authorization', adminAuth).send({ reset_cooldown_days: 3, leaderboard_enabled: true });
    expect(s.status).toBe(200);
    expect(s.body.settings.reset_cooldown_days).toBe(3);
    const bad = await request(app).put('/api/admin/settings').set('Authorization', adminAuth).send({ reset_cooldown_days: -1 });
    expect(bad.status).toBe(400);
    const inst = (await query(`SELECT id FROM instruments WHERE code = 'GOLD'`))[0];
    const p = await request(app).patch(`/api/admin/instruments/${inst.id}`).set('Authorization', adminAuth).send({ fallback_spread_paise: 500, brokerage_paise: 2000 });
    expect(p.body.instrument).toMatchObject({ fallback_spread_paise: 500, brokerage_paise: 2000 });
    const hol = await request(app).post('/api/admin/holidays').set('Authorization', adminAuth).send({ date: '2026-12-25', description: 'Christmas' });
    expect(hol.status).toBe(201);
    const fh = await request(app).get('/api/admin/feed-health').set('Authorization', adminAuth);
    expect(fh.body.health).toMatchObject({ provider: 'mock' });
    expect(fh.body.health.instruments.map((i: any) => i.code)).toEqual(['GOLD', 'SILVER']);
  });
});

describe('leaderboard', () => {
  beforeEach(resetDb);

  it('is hidden when disabled and ranks by risk-adjusted return with a minimum trade count', async () => {
    const { h, userAuth } = await setup();
    setSettingsForTest({ leaderboard_enabled: false });
    expect((await request(app).get('/api/leaderboard').set('Authorization', userAuth)).status).toBe(404);
    setSettingsForTest({ leaderboard_enabled: true, leaderboard_min_trades: 2 });
    await h.tick('GOLD', { ltp: R(100000), bid: R(100000), ask: R(100000) });
    for (const exit of [R(100100), R(99950), R(100200)]) {
      const { position } = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 10, ...h.plan });
      await h.tick('GOLD', { ltp: exit, bid: exit, ask: exit });
      await h.engine.closePosition(h.user.id, position!.id);
      await h.tick('GOLD', { ltp: R(100000), bid: R(100000), ask: R(100000) });
    }
    const lb = await request(app).get('/api/leaderboard').set('Authorization', userAuth);
    expect(lb.status).toBe(200);
    expect(lb.body.rows).toHaveLength(1);
    expect(lb.body.rows[0]).toMatchObject({ trades: 3, me: true });
    expect(lb.body.rows[0].score).toBeGreaterThan(0);
    void pool;
  });
});
