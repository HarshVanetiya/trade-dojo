import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool, query } from '../src/db/pool.js';
import { seedAdmin } from '../src/services/auth.js';
import { resetDb } from './helpers.js';

const app = createApp();

describe('auth', () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it('signs up with starting points, logs in, and reads /me', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ name: 'Asha', email: 'asha@local', password: 'password123', acceptTerms: true });
    expect(res.status).toBe(201);
    const me = await request(app).get('/api/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.account.pointsFree).toBe(10_000_000);
    expect(me.body.account.season).toBe(1);
    const ledger = await query('SELECT kind, amount FROM points_ledger');
    expect(ledger).toEqual([{ kind: 'initial', amount: 10_000_000 }]);

    const login = await request(app).post('/api/auth/login').send({ email: 'ASHA@local', password: 'password123' });
    expect(login.status).toBe(200);
  });

  it('rejects short passwords, duplicates, and bad logins with the error shape', async () => {
    const short = await request(app).post('/api/auth/signup').send({ name: 'A', email: 'a@local', password: 'short', acceptTerms: true });
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe('validation_error');
    await request(app).post('/api/auth/signup').send({ name: 'A', email: 'a@local', password: 'password123', acceptTerms: true });
    const dup = await request(app).post('/api/auth/signup').send({ name: 'A', email: 'A@local', password: 'password123', acceptTerms: true });
    expect(dup.status).toBe(409);
    const bad = await request(app).post('/api/auth/login').send({ email: 'a@local', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toMatchObject({ code: 'unauthorized' });
  });

  it('change password invalidates old tokens', async () => {
    const s = await request(app).post('/api/auth/signup').send({ name: 'B', email: 'b@local', password: 'password123', acceptTerms: true });
    const old = s.body.token;
    const cp = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${old}`).send({ currentPassword: 'password123', newPassword: 'password456' });
    expect(cp.status).toBe(200);
    expect((await request(app).get('/api/me').set('Authorization', `Bearer ${old}`)).status).toBe(401);
    expect((await request(app).get('/api/me').set('Authorization', `Bearer ${cp.body.token}`)).status).toBe(200);
  });

  it('seeds the admin from env exactly once', async () => {
    await seedAdmin(() => {});
    await seedAdmin(() => {});
    const admins = await query(`SELECT email FROM users WHERE role = 'admin'`);
    expect(admins).toEqual([{ email: 'admin@test' }]);
  });

  it('rate-limits repeated failed logins', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await request(app).post('/api/auth/login').send({ email: 'nobody@local', password: 'x' })).status;
    }
    expect(last).toBe(429);
  });
});
