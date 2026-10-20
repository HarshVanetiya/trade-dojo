import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { upsertCandles } from '../src/market/candles.js';
import { computeFlags, ema, type FlagInput } from '../src/reviews/flags.js';
import { generateReview } from '../src/reviews/review.js';
import { computeWhatIfs } from '../src/reviews/whatif.js';
import { setSettingsForTest } from '../src/services/settings.js';
import { computeStats, riskAdjustedScore, type StatTrade } from '../src/stats/stats.js';
import { harness, IST, R } from './engineHarness.js';
import { resetDb } from './helpers.js';

const base: FlagInput = {
  direction: 'LONG',
  entryPrice: R(100000),
  entryTs: IST('2026-10-20T11:00:00'),
  exitTs: IST('2026-10-20T12:00:00'),
  exitReason: 'target',
  netPnl: R(1000),
  grossPnl: R(1000),
  initialSl: R(99500),
  initialTp: R(101000),
  initialRisk: R(500),
  rMultiple: 2,
  plannedRr: 2,
  riskPct: 1,
  gapExit: false,
  bothTouched: false,
  slChanges: [],
  priorClosed: [],
  openedSameDay: 1,
  dailyEma50: R(99000),
  session: { open: IST('2026-10-20T09:00:00'), close: IST('2026-10-20T23:30:00') },
  targetReachedAfterExit: null,
  riskWarnPct: 2,
  overtradingLimit: 5,
};
const codes = (p: Partial<FlagInput>) => computeFlags({ ...base, ...p }).map((f) => f.code);

describe('coaching flags', () => {
  it('a clean trade has no flags', () => {
    expect(codes({})).toEqual([]);
  });
  it('no stop-loss', () => {
    expect(codes({ initialSl: null, initialRisk: null, rMultiple: null, plannedRr: null, riskPct: null })).toEqual(['no_stop_loss']);
  });
  it('moved stop-loss further away (long: lower; short: higher; removed)', () => {
    expect(codes({ slChanges: [{ old: R(99500), new: R(99000) }] })).toContain('moved_stop_further');
    expect(codes({ slChanges: [{ old: R(99500), new: R(99800) }] })).not.toContain('moved_stop_further');
    expect(codes({ direction: 'SHORT', entryPrice: R(98000), slChanges: [{ old: R(98500), new: R(99000) }] })).toContain('moved_stop_further');
    expect(codes({ slChanges: [{ old: R(99500), new: null }] })).toContain('moved_stop_further');
  });
  it('risked more than 2%', () => {
    expect(codes({ riskPct: 2.5 })).toEqual(['risk_too_high']);
    expect(codes({ riskPct: 2 })).toEqual([]);
  });
  it('R:R below 1', () => {
    expect(codes({ plannedRr: 0.8 })).toEqual(['low_rr']);
  });
  it('exited a winner early', () => {
    expect(codes({ exitReason: 'manual', rMultiple: 0.5, plannedRr: 2 })).toEqual(['exited_winner_early']);
    expect(codes({ exitReason: 'manual', rMultiple: 1.5, plannedRr: 2 })).toEqual([]);
    expect(codes({ exitReason: 'manual', rMultiple: 1.5, plannedRr: 2, targetReachedAfterExit: true })).toEqual(['exited_winner_early']);
    expect(codes({ exitReason: 'manual', rMultiple: -0.5, netPnl: -R(250), grossPnl: -R(250) })).toEqual([]);
  });
  it('held a loser past the planned stop (but not when a gap caused it)', () => {
    expect(codes({ exitReason: 'manual', netPnl: -R(800), grossPnl: -R(800), rMultiple: -1.6 })).toEqual(['held_loser_past_stop']);
    expect(codes({ exitReason: 'stop_loss', netPnl: -R(800), grossPnl: -R(800), rMultiple: -1.6, gapExit: true })).toEqual(['gap_stop']);
  });
  it('revenge trade within 5 minutes of a loss', () => {
    expect(codes({ priorClosed: [{ exitTs: base.entryTs - 4 * 60_000, netPnl: -R(100) }] })).toEqual(['revenge_trade']);
    expect(codes({ priorClosed: [{ exitTs: base.entryTs - 6 * 60_000, netPnl: -R(100) }] })).toEqual([]);
    expect(codes({ priorClosed: [{ exitTs: base.entryTs - 60_000, netPnl: R(100) }] })).toEqual([]);
  });
  it('overtrading beyond N trades a day', () => {
    expect(codes({ openedSameDay: 5 })).toEqual([]);
    expect(codes({ openedSameDay: 6 })).toEqual(['overtrading']);
  });
  it('traded against the daily EMA-50 trend', () => {
    expect(codes({ dailyEma50: R(100500) })).toEqual(['against_trend']);
    expect(codes({ direction: 'SHORT', entryPrice: R(100000), initialSl: R(100500), initialTp: R(99000), dailyEma50: R(99000) })).toEqual(['against_trend']);
    expect(codes({ dailyEma50: null })).toEqual([]);
  });
  it('entered in the first 5 minutes or the last 15 minutes', () => {
    expect(codes({ entryTs: IST('2026-10-20T09:03:00') })).toEqual(['entered_at_open']);
    expect(codes({ entryTs: IST('2026-10-20T09:06:00') })).toEqual([]);
    expect(codes({ entryTs: IST('2026-10-20T23:20:00') })).toEqual(['entered_near_close']);
  });
  it('gap stop and both-touched are explained', () => {
    expect(codes({ gapExit: true, exitReason: 'stop_loss' })).toEqual(['gap_stop']);
    expect(codes({ bothTouched: true, exitReason: 'stop_loss' })).toEqual(['both_touched']);
  });
  it('EMA', () => {
    expect(ema([1, 2, 3], 5)).toBeNull();
    expect(ema([2, 4, 6], 3)).toBe(4);
    expect(ema([2, 4, 6, 8], 3)).toBe(6);
  });
});

describe('what-ifs', () => {
  const t0 = IST('2026-10-20T10:00:00');
  const candles = Array.from({ length: 1800 }, (_, i) => {
    // Price dips to 99,400 at minute 30 then rises to 101,200 by minute 120 and stays.
    const p = i < 30 ? 100000 - i * 20 : i < 120 ? 99400 + (i - 30) * 20 : 101200;
    return { openTime: t0 + i * 60_000, o: R(p), h: R(p + 5), l: R(p - 5), c: R(p), volume: 1, oi: null };
  });
  const args = {
    direction: 'LONG' as const,
    qtyG: 10,
    unitGrams: 10,
    entryPrice: R(100000),
    entryTs: t0,
    initialSl: R(99000),
    initialTp: R(101000),
    candles,
  };

  it('compares an early manual exit with holding to target, +1h, +1d', () => {
    const exitTs = t0 + 40 * 60_000;
    const { whatifs, complete } = computeWhatIfs({ ...args, exitTs, exitReason: 'manual', asOf: t0 + 1800 * 60_000 });
    expect(complete).toBe(true);
    expect(whatifs.heldToTarget).toMatchObject({ available: true, outcome: 'target', pnl: R(1000) });
    expect(whatifs.heldOneHour.price).toBe(R(99400 + 69 * 20)); // close of the minute ending exit+60m
    expect(whatifs.heldOneDay).toMatchObject({ available: true, price: R(101200), pnl: R(1200) });
    expect(whatifs.noStop.available).toBe(false);
  });

  it('shows the no-stop scenario after a stop-out and waits for future data', () => {
    const tight = { ...args, initialSl: R(99500) };
    const exitTs = t0 + 26 * 60_000;
    const partial = computeWhatIfs({ ...tight, exitTs, exitReason: 'stop_loss', asOf: exitTs + 30 * 60_000 });
    expect(partial.complete).toBe(false);
    expect(partial.whatifs.heldOneDay.available).toBe(false);
    expect(partial.whatifs.noStop.available).toBe(false);
    const full = computeWhatIfs({ ...tight, exitTs, exitReason: 'stop_loss', asOf: t0 + 1800 * 60_000 });
    expect(full.whatifs.noStop).toMatchObject({ available: true, outcome: 'target', pnl: R(1000) });
    expect(full.whatifs.heldToTarget).toMatchObject({ outcome: 'stop' });
  });
});

describe('dashboard metrics', () => {
  const mk = (id: number, day: number, netPnl: number, r: number | null, extra: Partial<StatTrade> = {}): StatTrade => ({
    id,
    entryTs: IST(`2026-10-${String(day).padStart(2, '0')}T10:00:00`),
    exitTs: IST(`2026-10-${String(day).padStart(2, '0')}T11:00:00`),
    netPnl,
    rMultiple: r,
    holdingSeconds: 3600,
    setupTag: 'Breakout',
    direction: 'LONG',
    confidence: 3,
    flags: [],
    ...extra,
  });
  // Hand-calculated fixture: +1000, -500, -500, +2000, -1000 on a 10,000 start.
  const trades = [
    mk(1, 5, R(1000), 2, { flags: [{ code: 'no_stop_loss', title: '', detail: '', kind: 'habit' }] }),
    mk(2, 6, R(-500), -1, { direction: 'SHORT', setupTag: 'Reversal', confidence: 5 }),
    mk(3, 6, R(-500), -1, { entryTs: IST('2026-10-06T22:00:00'), flags: [{ code: 'revenge_trade', title: '', detail: '', kind: 'habit' }, { code: 'no_stop_loss', title: '', detail: '', kind: 'habit' }] }),
    mk(4, 7, R(2000), 4, { holdingSeconds: 7200 }),
    mk(5, 8, R(-1000), null, { flags: [{ code: 'gap_stop', title: '', detail: '', kind: 'info' }, { code: 'no_stop_loss', title: '', detail: '', kind: 'habit' }] }),
  ];
  const s = computeStats(trades, R(10000));

  it('computes headline numbers', () => {
    expect(s.trades).toBe(5);
    expect(s.totalPnl).toBe(R(1000));
    expect(s.winRate).toBe(40);
    expect(s.avgWin).toBe(R(1500));
    expect(s.avgLoss).toBeCloseTo(R(-2000) / 3);
    expect(s.profitFactor).toBe(1.5);
    expect(s.expectancy).toBe(R(200));
    expect(s.avgR).toBe(1);
    expect(s.avgHoldingSeconds).toBe(4320);
    expect(s.returnPct).toBe(10);
  });

  it('computes drawdown and streaks from the equity curve', () => {
    // Equity: 10000 -> 11000 -> 10500 -> 10000 -> 12000 -> 11000. Max DD = 1000 (from 11000 to 10000).
    expect(s.equityCurve.map((p) => p.equity / 100)).toEqual([10000, 11000, 10500, 10000, 12000, 11000]);
    expect(s.maxDrawdown).toBe(R(1000));
    expect(s.maxDrawdownPct).toBeCloseTo((1000 / 11000) * 100);
    expect(s.longestWinStreak).toBe(1);
    expect(s.longestLossStreak).toBe(2);
  });

  it('breaks down by tag, direction, time of day, confidence and calendar', () => {
    expect(s.byTag.find((g) => g.key === 'Breakout')).toMatchObject({ trades: 4, wins: 2, netPnl: R(1500) });
    expect(s.byDirection).toEqual([
      expect.objectContaining({ key: 'LONG', trades: 4 }),
      expect.objectContaining({ key: 'SHORT', trades: 1, netPnl: R(-500) }),
    ]);
    expect(s.byTimeOfDay.map((g) => [g.key, g.trades])).toEqual([['09:00-12:00', 4], ['21:00-close', 1]]);
    expect(s.byConfidence.map((g) => g.key)).toEqual(['3', '5']);
    expect(s.calendar).toEqual([
      { date: '2026-10-05', netPnl: R(1000), trades: 1 },
      { date: '2026-10-06', netPnl: R(-1000), trades: 2 },
      { date: '2026-10-07', netPnl: R(2000), trades: 1 },
      { date: '2026-10-08', netPnl: R(-1000), trades: 1 },
    ]);
  });

  it('ranks top habits from the last 20 trades (info flags excluded)', () => {
    expect(s.topHabits.map((x) => [x.code, x.count])).toEqual([['no_stop_loss', 3], ['revenge_trade', 1]]);
  });

  it('scores risk-adjusted return only with enough trades', () => {
    expect(riskAdjustedScore(s, 20)).toBeNull();
    expect(riskAdjustedScore(s, 5)).toBeCloseTo(10 / ((1000 / 11000) * 100));
  });
});

describe('review generation (integration)', () => {
  beforeEach(resetDb);

  it('stores R-multiple, MFE/MAE and flags for a closed trade', async () => {
    const h = await harness();
    setSettingsForTest({ overtrading_limit: 5, risk_warn_pct: 2 });
    await h.tick('GOLD', { ltp: R(100000), bid: R(100000), ask: R(100000) });
    const { position } = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 10, slPrice: R(99000), tpPrice: R(102000), ...h.plan });
    await h.tick('GOLD', { ltp: R(100800), bid: R(100800), ask: R(100800) });
    await h.tick('GOLD', { ltp: R(99600), bid: R(99600), ask: R(99600) });
    await h.tick('GOLD', { ltp: R(100500), bid: R(100500), ask: R(100500) });
    const out = await h.engine.closePosition(h.user.id, position!.id);
    const t = out!.trade!;
    expect(t.initial_risk).toBe(R(1000));
    expect(Number(t.r_multiple)).toBe(0.5);
    expect(Number(t.planned_rr)).toBe(2);
    expect(Number(t.risk_pct)).toBeCloseTo(0.1);
    const review = await generateReview(h.md, t.id);
    expect(review.mfe_paise).toBe(R(800));
    expect(review.mae_paise).toBe(R(-400));
    expect(review.mfe_price).toBe(R(100800));
    expect(review.flags.map((f) => f.code)).toEqual(['exited_winner_early']);
    expect(review.whatif_complete).toBe(false);

    // A new trade 1 minute after a loss is a revenge trade.
    const second = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'SHORT', orderType: 'MARKET', qtyG: 10, ...h.plan });
    await h.tick('GOLD', { ltp: R(100700), bid: R(100700), ask: R(100700) });
    const lost = await h.engine.closePosition(h.user.id, second.position!.id);
    await h.tick('GOLD', { ltp: R(100700), bid: R(100700), ask: R(100700) }, 60_000);
    const third = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 1, ...h.plan });
    await h.tick('GOLD', { ltp: R(100710), bid: R(100710), ask: R(100710) });
    const t3 = (await h.engine.closePosition(h.user.id, third.position!.id))!.trade!;
    expect(lost!.trade!.net_pnl).toBeLessThan(0);
    const r3 = await generateReview(h.md, t3.id);
    expect(r3.flags.map((f) => f.code)).toEqual(expect.arrayContaining(['no_stop_loss', 'revenge_trade']));
  });

  it('flags trades against the daily trend using stored daily candles', async () => {
    const h = await harness();
    const c = h.md.activeContract(h.gold)!;
    // 60 daily closes falling from 1,10,000 to ~1,04,000: EMA-50 sits above 1,00,000.
    const days = Array.from({ length: 60 }, (_, i) => {
      const p = R(110000 - i * 100);
      return { openTime: IST('2026-08-01T00:00:00') + i * 86_400_000, o: p, h: p, l: p, c: p, volume: 1, oi: null };
    });
    await upsertCandles(h.gold, c.id, '1d', days, 'history');
    await h.tick('GOLD', { ltp: R(100000), bid: R(100000), ask: R(100000) });
    const { position } = await h.engine.placeOrder(h.user.id, { mode: 'live', instrument: 'GOLD', direction: 'LONG', orderType: 'MARKET', qtyG: 1, slPrice: R(99500), tpPrice: R(101000), ...h.plan });
    await h.tick('GOLD', { ltp: R(101000), bid: R(101000), ask: R(101000) });
    const tr = await query('SELECT id FROM trades WHERE position_id = $1', [position!.id]);
    const review = await generateReview(h.md, tr[0].id);
    expect(review.flags.map((f) => f.code)).toEqual(['against_trend']);
  });
});
