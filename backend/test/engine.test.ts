import { beforeEach, describe, expect, it } from 'vitest';
import { pool, query, queryOne, tx } from '../src/db/pool.js';
import { barFromCandle, evaluateExit } from '../src/engine/rules.js';
import { notional, pnl } from '../src/lib/money.js';
import { resetAccount, resetEligibility } from '../src/services/accounts.js';
import { applyLedger } from '../src/services/ledger.js';
import { harness, IST, R } from './engineHarness.js';
import { resetDb } from './helpers.js';

const START = 100_000_000; // 10,00,000 points in paise (harness default)

describe('money math in MCX units', () => {
  it('gold is quoted per 10 g, silver per kg; quantities are grams', () => {
    expect(notional(10, R(120000), 10)).toBe(R(120000)); // 10 g at 1,20,000/10 g
    expect(notional(1, R(120000), 10)).toBe(R(12000));
    expect(notional(100, R(145000), 1000)).toBe(R(14500)); // 100 g at 1,45,000/kg
    expect(pnl('LONG', 5, R(120000), R(120500), 10)).toBe(R(250));
    expect(pnl('SHORT', 5, R(120000), R(120500), 10)).toBe(R(-250));
    expect(pnl('SHORT', 300, R(145000), R(144000), 1000)).toBe(R(300));
    // Rounds half away from zero on odd paise.
    expect(pnl('LONG', 1, 100, 105, 10)).toBe(1);
    expect(pnl('LONG', 1, 100, 95, 10)).toBe(-1);
  });
});

describe('trading engine (live)', () => {
  beforeEach(resetDb);

  it('long gold: buys at the ask, sells at the bid, P&L in points', async () => {
    const h = await harness();
    await h.tick('GOLD', { ltp: R(120000), bid: R(119998), ask: R(120002) });
    const { position } = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 10, ...h.plan });
    expect(position!.avgEntry).toBe(R(120002));
    let acc = await h.account();
    expect(acc.cash_reserved).toBe(R(120002)); // full notional reserved, no leverage
    expect(acc.cash_available).toBe(START - R(120002));

    await h.tick('GOLD', { ltp: R(121000), bid: R(120998), ask: R(121002) });
    const out = await h.engine.closePosition(h.user.id, position!.id);
    const trade = out!.trade!;
    expect(trade.exit_price).toBe(R(120998));
    expect(trade.gross_pnl).toBe(R(996)); // 10 g x (1,20,998 - 1,20,002) / 10
    acc = await h.account();
    expect(acc.cash_reserved).toBe(0);
    expect(acc.cash_available).toBe(START + R(996));
    const fills = await query('SELECT side, price, reason FROM fills ORDER BY id');
    expect(fills).toEqual([
      { side: 'BUY', price: R(120002), reason: 'entry' },
      { side: 'SELL', price: R(120998), reason: 'manual' },
    ]);
  });

  it('short silver in grams vs a per-kg price', async () => {
    const h = await harness();
    await h.tick('SILVER', { ltp: R(145000), bid: R(144990), ask: R(145010) });
    const { position } = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'SILVER', direction: 'SHORT', orderType: 'MARKET', qtyG: 500, ...h.plan });
    expect(position!.avgEntry).toBe(R(144990)); // sells at the bid
    await h.tick('SILVER', { ltp: R(144000), bid: R(143990), ask: R(144010) });
    const out = await h.engine.closePosition(h.user.id, position!.id);
    expect(out!.trade!.gross_pnl).toBe(R(490)); // 500 g x (1,44,990 - 1,44,010) / 1000
    expect((await h.account()).cash_available).toBe(START + R(490));
  });

  it('rejects silver quantities off the 100 g step', async () => {
    const h = await harness();
    await h.tick('SILVER', { ltp: R(145000), bid: R(144990), ask: R(145010) });
    await expect(h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'SILVER', direction: 'LONG', orderType: 'MARKET', qtyG: 150, ...h.plan })).rejects.toMatchObject({ code: 'invalid_qty' });
  });

  it('partial close releases points pro rata and creates one trade at the end', async () => {
    const h = await harness();
    await h.tick('GOLD', { ltp: R(100000), bid: R(100000), ask: R(100000) });
    const { position } = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 10, ...h.plan });
    await h.tick('GOLD', { ltp: R(101000), bid: R(101000), ask: R(101000) });
    await h.engine.closePosition(h.user.id, position!.id, 4);
    let acc = await h.account();
    expect(acc.cash_reserved).toBe(R(60000));
    expect(acc.cash_available).toBe(START - R(100000) + R(40000) + R(400));
    expect(await h.trade(position!.id)).toBeNull();
    await h.tick('GOLD', { ltp: R(99000), bid: R(99000), ask: R(99000) });
    const out = await h.engine.closePosition(h.user.id, position!.id);
    expect(out!.trade).toMatchObject({ qty_g: 10, gross_pnl: R(400) - R(600), exit_price: R(99800) });
    acc = await h.account();
    expect(acc.cash_reserved).toBe(0);
    expect(acc.cash_available).toBe(START - R(200));
    await expect(h.engine.closePosition(h.user.id, position!.id, 1)).rejects.toMatchObject({ code: 'position_closed' });
  });

  it('falls back to LTP -/+ half the configured spread when depth is missing', async () => {
    const h = await harness();
    await pool.query(`UPDATE instruments SET fallback_spread_paise = $1 WHERE code = 'GOLD'`, [R(5)]);
    await h.md.reloadInstruments();
    await h.tick('GOLD', { ltp: R(120000), bid: null, ask: null });
    const buy = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 1, ...h.plan });
    expect(buy.position!.avgEntry).toBe(R(120000) + 250);
    const sell = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'SHORT', orderType: 'MARKET', qtyG: 1, ...h.plan });
    expect(sell.position!.avgEntry).toBe(R(120000) - 250);
  });

  it('charges simulated brokerage on entry and exit', async () => {
    const h = await harness();
    await pool.query(`UPDATE instruments SET brokerage_paise = $1 WHERE code = 'GOLD'`, [R(20)]);
    await h.md.reloadInstruments();
    await h.tick('GOLD', { ltp: R(100000), bid: R(100000), ask: R(100000) });
    const { position } = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 10, ...h.plan });
    expect((await h.account()).cash_available).toBe(START - R(100000) - R(20));
    await h.tick('GOLD', { ltp: R(100100), bid: R(100100), ask: R(100100) });
    const out = await h.engine.closePosition(h.user.id, position!.id);
    expect(out!.trade).toMatchObject({ gross_pnl: R(100), brokerage: R(40), net_pnl: R(60) });
    expect((await h.account()).cash_available).toBe(START + R(60));
    const kinds = (await query(`SELECT kind FROM points_ledger WHERE kind = 'brokerage'`)).length;
    expect(kinds).toBe(2);
  });

  it('triggers stop-loss on the bid for longs and target on the ask for shorts', async () => {
    const h = await harness();
    await h.tick('GOLD', { ltp: R(100000), bid: R(99999), ask: R(100001) });
    const long = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 10, slPrice: R(99500), tpPrice: R(101000), ...h.plan });
    const short = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'SHORT', orderType: 'MARKET', qtyG: 10, slPrice: R(100500), tpPrice: R(99600), ...h.plan });
    await h.tick('GOLD', { ltp: R(99700), bid: R(99600), ask: R(99700) }); // short target needs ask <= 99,600: not yet
    expect((await h.positions()).length).toBe(2);
    await h.tick('GOLD', { ltp: R(99550), bid: R(99490), ask: R(99590) });
    const closed = await h.positions('closed');
    expect(closed.map((p: any) => [p.id, p.exit_reason])).toEqual([
      [long.position!.id, 'stop_loss'],
      [short.position!.id, 'target'],
    ]);
    const longTrade = await h.trade(long.position!.id);
    expect(longTrade.exit_price).toBe(R(99500)); // filled at the stop level (no gap within a session)
    expect(longTrade.gap_exit).toBe(false);
    expect((await h.trade(short.position!.id)).exit_price).toBe(R(99600)); // target filled at its level
    expect(h.events.some((e) => e.type === 'fill' && e.data.reason === 'stop_loss')).toBe(true);
  });

  it('fills a gapped stop at the first available price after the open and flags it', async () => {
    const h = await harness('2026-10-20T23:00:00');
    await h.tick('GOLD', { ltp: R(100000), bid: R(100000), ask: R(100000) });
    const { position } = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 10, slPrice: R(99500), ...h.plan });
    // Overnight: market closed, a stray tick far below the stop must not trigger anything.
    h.clock.now = IST('2026-10-21T02:00:00');
    await h.tick('GOLD', { ltp: R(98000), bid: R(98000), ask: R(98000) }, 0);
    expect((await h.positions()).length).toBe(1);
    // Next open: first tick gaps below the stop.
    h.clock.now = IST('2026-10-21T09:00:00');
    await h.tick('GOLD', { ltp: R(99000), bid: R(99000), ask: R(99000) }, 1000);
    const t = await h.trade(position!.id);
    expect(t).toMatchObject({ exit_reason: 'stop_loss', exit_price: R(99000), gap_exit: true });
  });

  it('assumes the stop-loss hit first when one candle touches both stop and target', () => {
    const bar = barFromCandle({ ts: 0, o: R(100000), h: R(101500), l: R(99000), c: R(100500) }, 0, false);
    expect(evaluateExit({ direction: 'LONG', sl: R(99500), tp: R(101000), trailing: false }, bar)).toEqual({ reason: 'stop_loss', price: R(99500), gap: false, bothTouched: true });
    expect(evaluateExit({ direction: 'SHORT', sl: R(101000), tp: R(99500), trailing: false }, bar)).toEqual({ reason: 'stop_loss', price: R(101000), gap: false, bothTouched: true });
    // A candle that opens beyond the stop at a session open fills at the open (gap).
    const gapBar = barFromCandle({ ts: 0, o: R(98000), h: R(98500), l: R(97500), c: R(98200) }, 0, true);
    expect(evaluateExit({ direction: 'LONG', sl: R(99500), tp: null, trailing: false }, gapBar)).toMatchObject({ price: R(98000), gap: true });
  });

  it('records both-touched candles on the trade', async () => {
    const h = await harness();
    await h.tick('GOLD', { ltp: R(100000), bid: R(100000), ask: R(100000) });
    const { position } = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 10, slPrice: R(99500), tpPrice: R(101000), ...h.plan });
    const c = h.md.activeContract(h.gold)!;
    h.clock.now += 60_000;
    await h.engine.processBar({ mode: 'live', instrumentId: h.gold, contractId: c.id }, barFromCandle({ ts: h.clock.now, o: R(100000), h: R(101200), l: R(99400), c: R(100800) }, 0, false));
    expect(await h.trade(position!.id)).toMatchObject({ exit_reason: 'stop_loss', exit_price: R(99500), both_touched: true });
  });

  it('rests LIMIT and STOP entries until price crosses, then fills at the level', async () => {
    const h = await harness();
    await h.tick('GOLD', { ltp: R(100000), bid: R(99999), ask: R(100001) });
    const lim = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'LIMIT', triggerPrice: R(99800), qtyG: 10, slPrice: R(99500), ...h.plan });
    const stp = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'SHORT', orderType: 'STOP', triggerPrice: R(99850), qtyG: 5, ...h.plan });
    expect(lim.order.status).toBe('pending');
    const acc = await h.account();
    expect(acc.cash_reserved).toBe(R(99800) + R(49925)); // pending orders reserve their notional
    await expect(h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'LIMIT', triggerPrice: R(100500), qtyG: 1, ...h.plan })).rejects.toMatchObject({ code: 'invalid_trigger' });

    await h.tick('GOLD', { ltp: R(99900), bid: R(99899), ask: R(99901) });
    expect((await h.positions()).length).toBe(0);
    await h.tick('GOLD', { ltp: R(99800), bid: R(99790), ask: R(99795) });
    const open = await h.positions();
    expect(open.map((p: any) => [p.direction, p.avg_entry_price])).toEqual([
      ['LONG', R(99800)],
      ['SHORT', R(99850)],
    ]);
    // Fill prices are the order levels, not the (better / worse) ticks that crossed them.
    // Reservation swapped from the orders to the positions.
    expect((await h.account()).cash_reserved).toBe(R(99800) + R(49925));
    expect((await query(`SELECT status FROM orders ORDER BY id`)).map((o: any) => o.status)).toEqual(['filled', 'filled']);
  });

  it('cancels a pending order and releases its points', async () => {
    const h = await harness();
    await h.tick('GOLD', { ltp: R(100000), bid: R(100000), ask: R(100000) });
    const { order } = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'LIMIT', triggerPrice: R(99000), qtyG: 10, ...h.plan });
    await h.engine.cancelOrder(h.user.id, order.id);
    const acc = await h.account();
    expect([acc.cash_available, acc.cash_reserved]).toEqual([START, 0]);
  });

  it('pauses orders when the market is closed or prices are stale, and never triggers on them', async () => {
    const h = await harness();
    await h.tick('GOLD', { ltp: R(100000), bid: R(100000), ask: R(100000) });
    const { position } = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 1, slPrice: R(99000), ...h.plan });
    h.clock.now += 5 * 60_000; // feed silent for 5 minutes
    await expect(h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 1, ...h.plan })).rejects.toMatchObject({ code: 'prices_delayed' });
    await expect(h.engine.closePosition(h.user.id, position!.id)).rejects.toMatchObject({ code: 'prices_delayed' });
    h.clock.now = IST('2026-10-24T11:00:00'); // Saturday
    await expect(h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 1, ...h.plan })).rejects.toMatchObject({ code: 'market_closed' });
    await h.tick('GOLD', { ltp: R(90000), bid: R(90000), ask: R(90000) }, 0);
    expect((await h.positions()).length).toBe(1);
  });

  it('rejects orders that need more points than are free', async () => {
    const h = await harness();
    await h.tick('GOLD', { ltp: R(120000), bid: R(120000), ask: R(120000) });
    // 10,00,000 points buys at most 83 g at 1,20,000 per 10 g.
    await expect(h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 84, ...h.plan })).rejects.toMatchObject({ code: 'insufficient_points' });
    await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 83, ...h.plan });
    await expect(h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'SHORT', orderType: 'MARKET', qtyG: 1, ...h.plan })).rejects.toMatchObject({ code: 'insufficient_points' });
  });

  it('requires a trade plan', async () => {
    const h = await harness();
    await h.tick('GOLD', { ltp: R(120000), bid: R(120000), ask: R(120000) });
    await expect(h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 1, setupTag: 'Hunch', planNote: 'x', confidence: 3 })).rejects.toMatchObject({ code: 'setup_tag_required' });
    await expect(h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 1, setupTag: 'Breakout', planNote: '', confidence: 3 })).rejects.toMatchObject({ code: 'plan_required' });
  });

  it('validates and records stop-loss edits, and trails stops', async () => {
    const h = await harness();
    await h.tick('GOLD', { ltp: R(100000), bid: R(100000), ask: R(100000) });
    const { position } = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 10, slPrice: R(99500), ...h.plan });
    await expect(h.engine.modifyPosition(h.user.id, position!.id, { slPrice: R(100100) })).rejects.toMatchObject({ code: 'invalid_sl' });
    await h.engine.modifyPosition(h.user.id, position!.id, { slPrice: R(99000), trailPaise: R(300) });
    expect(await query('SELECT kind, old_value, new_value FROM position_events ORDER BY id')).toEqual([
      { kind: 'sl_changed', old_value: R(99500), new_value: R(99000) },
      { kind: 'trail_changed', old_value: null, new_value: R(300) },
    ]);
    await h.tick('GOLD', { ltp: R(100800), bid: R(100800), ask: R(100800) });
    expect((await h.positions())[0].sl_price).toBe(R(100500)); // trailed 300 below the best bid
    await h.tick('GOLD', { ltp: R(100600), bid: R(100600), ask: R(100600) });
    expect((await h.positions())[0].sl_price).toBe(R(100500)); // never moves back
    await h.tick('GOLD', { ltp: R(100400), bid: R(100400), ask: R(100400) });
    expect(await h.trade(position!.id)).toMatchObject({ exit_reason: 'trailing_stop', exit_price: R(100500) });
  });

  it('closes live positions on rollover day at the old contract last price and cancels its orders', async () => {
    const h = await harness('2026-10-30T12:00:00');
    await h.tick('GOLD', { ltp: R(100000), bid: R(100000), ask: R(100000) });
    const old = h.md.activeContract(h.gold)!;
    expect(old.expiry).toBe('2026-11-05');
    const { position } = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 5, ...h.plan });
    await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'LIMIT', triggerPrice: R(99000), qtyG: 5, ...h.plan });
    await h.tick('GOLD', { ltp: R(100400), bid: R(100400), ask: R(100400) });
    // Notice before rollover (rollover date 2026-11-02, notice 2 days earlier).
    await h.engine.sendRolloverNotices('2026-10-31');
    expect(h.events.filter((e) => e.type === 'rollover' && e.data.notice)).toHaveLength(1);
    await h.engine.sendRolloverNotices('2026-11-01');
    expect(h.events.filter((e) => e.type === 'rollover' && e.data.notice)).toHaveLength(1); // only once

    h.clock.now = IST('2026-11-02T09:00:00');
    await h.md.ensureActiveContracts('2026-11-02');
    const next = h.md.activeContract(h.gold)!;
    expect(next.expiry).toBe('2026-12-05');
    expect(await h.trade(position!.id)).toMatchObject({ exit_reason: 'rollover', exit_price: R(100400), contract_symbol: old.trading_symbol });
    expect((await query(`SELECT status, cancel_reason FROM orders WHERE order_type = 'LIMIT'`))[0]).toMatchObject({ status: 'cancelled' });
    const acc = await h.account();
    expect([acc.cash_available, acc.cash_reserved]).toEqual([START + R(200), 0]);
    expect(h.events.some((e) => e.type === 'rollover' && !e.data.notice)).toBe(true);
    // Ticks from the old contract are ignored; the new one trades.
    await h.tick('GOLD', { ltp: R(100900), bid: R(100900), ask: R(100900) });
    const again = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 1, ...h.plan });
    expect((await queryOne('SELECT contract_id FROM positions WHERE id = $1', [again.position!.id])).contract_id).toBe(next.id);
  });
});

describe('account reset', () => {
  beforeEach(resetDb);

  it('allows a reset only below 10% of starting points, once every 7 days, keeping history', async () => {
    const h = await harness();
    const acc = await h.account();
    expect(await resetEligibility(h.user.id, 'live')).toMatchObject({ eligible: false });
    // Simulate heavy losses.
    await tx((c) => applyLedger(c, acc.id, { kind: 'grant', available: -(START - R(50000)), note: 'test loss' }));
    expect(await resetEligibility(h.user.id, 'live')).toMatchObject({ eligible: true });
    const s2 = await resetAccount(h.user.id, 'live');
    expect(s2).toMatchObject({ season: 2, cash_available: START });
    const all = await query('SELECT season, is_active FROM accounts WHERE user_id = $1 ORDER BY season', [h.user.id]);
    expect(all).toEqual([{ season: 1, is_active: false }, { season: 2, is_active: true }]);

    await tx((c) => applyLedger(c, s2.id, { kind: 'grant', available: -(START - R(50000)), note: 'test loss' }));
    const now = new Date();
    expect(await resetEligibility(h.user.id, 'live', now)).toMatchObject({ eligible: false, reason: expect.stringContaining('7 days') });
    await expect(resetAccount(h.user.id, 'live', now)).rejects.toMatchObject({ code: 'reset_not_allowed' });
    const later = new Date(now.getTime() + 7 * 86_400_000 + 1000);
    expect(await resetEligibility(h.user.id, 'live', later)).toMatchObject({ eligible: true });
  });
});
