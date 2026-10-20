import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { ReplayService } from '../src/replay/replay.js';
import { getActiveAccount } from '../src/services/accounts.js';
import { harness, IST } from './engineHarness.js';
import { resetDb } from './helpers.js';

async function setup() {
  const h = await harness('2026-10-20T10:00:00');
  const replay = new ReplayService(h.md, h.engine);
  const sent: any[] = [];
  replay.send = (userId, type, data) => sent.push({ userId, type, data });
  const session = await replay.create(h.user.id, { instrument: 'GOLD', from: '2026-10-12', to: '2026-10-13', step: '5m', speed: 5 });
  return { h, replay, sent, session };
}

describe('replay', () => {
  beforeEach(resetDb);

  it('starts at the beginning and never returns candles beyond the replay clock', async () => {
    const { h, replay, session } = await setup();
    expect(session.index).toBe(0);
    expect(session.currentTs).toBe(IST('2026-10-12T00:00:00'));
    expect(session.total).toBeGreaterThan(300);

    // Context before the start is visible; nothing from the replay range yet.
    let bars = await replay.candles(session.id, h.user.id, '5m', 500);
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every((b) => b.openTime < session.currentTs)).toBe(true);

    const after = await replay.step(session.id, h.user.id, 7);
    expect(after.index).toBe(7);
    const clock = after.currentTs;
    expect(clock).toBe(IST('2026-10-12T09:35:00')); // 7 five-minute bars from 09:00
    for (const interval of ['1m', '5m', '15m', '1h', '4h', '1d'] as const) {
      bars = await replay.candles(session.id, h.user.id, interval, 500);
      const last = bars[bars.length - 1];
      expect(last.openTime).toBeLessThan(clock);
      // The partial higher-timeframe bar is built only from completed minutes.
      expect(last.c).toBe(after.quote!.ltp);
    }
    const stats = await replay.marketStats(session.id, h.user.id);
    expect(stats.asOf).toBe(clock);
  });

  it('streams only newly revealed bars to the owner', async () => {
    const { h, replay, sent, session } = await setup();
    await replay.step(session.id, h.user.id, 3);
    const events = sent.filter((e) => e.type === 'replay');
    expect(events.every((e) => e.userId === h.user.id)).toBe(true);
    const bars = events.flatMap((e) => e.data.bars);
    expect(bars).toHaveLength(3);
    expect(Math.max(...bars.map((b: any) => b.openTime))).toBeLessThan(events[events.length - 1].data.currentTs);
  });

  it('trades with a separate replay balance and triggers stops on candles', async () => {
    const { h, replay, session } = await setup();
    await replay.step(session.id, h.user.id, 2);
    const live = await getActiveAccount(h.user.id, 'live');
    const cur = await replay.current(session.id, h.user.id);
    const entry = cur.bar.ask.c;
    const placed = await h.engine.placeOrder(h.user.id, {
      mode: 'replay',
      replaySessionId: session.id,
      instrument: 'GOLD',
      direction: 'LONG',
      orderType: 'MARKET',
      qtyG: 5,
      slPrice: entry - 5_000, // ₹50 below: will be hit within the day
      tpPrice: entry + 5_000_000,
      ...h.plan,
    });
    expect(placed.position!.avgEntry).toBe(entry);
    expect((await getActiveAccount(h.user.id, 'live')).cash_available).toBe(live.cash_available); // live untouched
    const rep = await getActiveAccount(h.user.id, 'replay');
    expect(rep.cash_reserved).toBeGreaterThan(0);

    // Step until the stop triggers.
    for (let i = 0; i < 200; i++) {
      const open = await query(`SELECT 1 FROM positions WHERE replay_session_id = $1 AND status = 'open'`, [session.id]);
      if (!open.length) break;
      await replay.step(session.id, h.user.id, 1);
    }
    const t = (await query(`SELECT * FROM trades WHERE replay_session_id = $1`, [session.id]))[0];
    expect(t.exit_reason).toBe('stop_loss');
    expect(t.mode).toBe('replay');
    expect(t.exit_price).toBeLessThanOrEqual(entry - 5_000);
  });

  it('ending a session closes open positions and cancels pending orders', async () => {
    const { h, replay, session } = await setup();
    await replay.step(session.id, h.user.id, 5);
    const cur = await replay.current(session.id, h.user.id);
    await h.engine.placeOrder(h.user.id, { mode: 'replay', replaySessionId: session.id, instrument: 'GOLD', direction: 'SHORT', orderType: 'MARKET', qtyG: 2, ...h.plan });
    await h.engine.placeOrder(h.user.id, { mode: 'replay', replaySessionId: session.id, instrument: 'GOLD', direction: 'LONG', orderType: 'LIMIT', triggerPrice: cur.bar.ask.c - 10_000_00, qtyG: 2, ...h.plan });
    const out = await replay.end(session.id, h.user.id);
    expect(out.trades).toBe(1);
    expect((await query(`SELECT exit_reason FROM trades WHERE replay_session_id = $1`, [session.id]))[0].exit_reason).toBe('session_end');
    expect((await query(`SELECT status FROM orders WHERE replay_session_id = $1 AND order_type = 'LIMIT'`, [session.id]))[0].status).toBe('cancelled');
    const acc = await getActiveAccount(h.user.id, 'replay');
    expect(acc.cash_reserved).toBe(0);
    await expect(replay.step(session.id, h.user.id, 1)).rejects.toMatchObject({ code: 'replay_ended' });
  });

  it('allows only one running session and validates ranges', async () => {
    const { h, replay } = await setup();
    await expect(replay.create(h.user.id, { instrument: 'GOLD', from: '2026-10-01', to: '2026-10-02', step: '5m', speed: 1 })).rejects.toMatchObject({ code: 'replay_active' });
    const r2 = new ReplayService(h.md, h.engine);
    const other = await (await import('./helpers.js')).makeUser('Other');
    await expect(r2.create(other.id, { instrument: 'GOLD', from: '2026-08-01', to: '2026-10-01', step: '1m', speed: 1 })).rejects.toMatchObject({ code: 'range_too_long' });
    await expect(r2.create(other.id, { instrument: 'GOLD', from: '2027-01-01', to: '2027-01-02', step: '5m', speed: 1 })).rejects.toMatchObject({ code: 'invalid_range' });
  });
});
