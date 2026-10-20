// npm run seed:demo [-- --reset]
// Creates the admin (from env) and demo1@local ... demo5@local with closed trades so the dashboard has data.
// Trades go through the real trading engine using stored (or simulated) historical prices.
import { migrate } from '../db/migrate.js';
import { pool, query, queryOne } from '../db/pool.js';
import { TradingEngine } from '../engine/engine.js';
import { backfillRange } from '../market/backfill.js';
import { getCandles, type ChartCandle } from '../market/candles.js';
import { createProvider, MarketData } from '../market/marketData.js';
import { MockProvider } from '../market/mock/MockProvider.js';
import { addDays, istDate, MINUTE } from '../lib/time.js';
import { generateReview } from '../reviews/review.js';
import { seedAdmin, signup } from '../services/auth.js';
import { loadSettings } from '../services/settings.js';

const DEMO_PASSWORD = 'demo-pass-123';
const NAMES = ['Asha Rao', 'Vikram Shah', 'Meera Iyer', 'Rohan Gupta', 'Kavya Nair'];
const TAGS = ['Breakout', 'Pullback', 'Trend-follow', 'Reversal', 'News', 'Other'];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function priceSeries(md: MarketData, instrumentId: number): Promise<ChartCandle[]> {
  const now = Date.now();
  const inst = md.instrument(instrumentId)!;
  await backfillRange(md, inst, '1m', addDays(istDate(now), -12), istDate(now)).catch(() => 0);
  let candles = await getCandles({ instrumentId, interval: '1m', to: now - 60 * MINUTE, limit: 5000 });
  if (candles.length < 1500) {
    // No stored history (e.g. no Upstox token yet): use deterministic simulated prices for the path only.
    const c = md.activeContract(instrumentId)!;
    const mock = new MockProvider();
    const base = await mock.getHistory({ instrumentKey: `MOCK_FO|${inst.product_symbol}|${c.expiry}`, product: inst.product_symbol, tradingSymbol: '', underlyingKey: null, expiry: c.expiry, lotSize: 1, tickSizePaise: 100 }, new Date(now - 10 * 86_400_000), new Date(now - 60 * MINUTE), '1m');
    candles = base.map((b) => ({ ...b, contract: c.trading_symbol, contractId: c.id }));
  }
  return candles;
}

async function main() {
  const reset = process.argv.includes('--reset');
  await migrate(() => {});
  await loadSettings();
  await seedAdmin();

  const existing = await query<{ id: number; email: string }>(`SELECT id, email FROM users WHERE email LIKE 'demo_@local'`);
  if (existing.length && !reset) {
    console.log(`Demo users already exist (${existing.map((e) => e.email).join(', ')}). Run with --reset to recreate them.`);
    console.log(`Shared demo password: ${DEMO_PASSWORD}`);
    await pool.end();
    return;
  }
  if (existing.length) {
    const ids = existing.map((e) => e.id);
    // Remove demo data in dependency order (ledger/fills are append-only, so drop their triggers briefly).
    await pool.query('BEGIN');
    await pool.query('ALTER TABLE fills DISABLE TRIGGER fills_immutable');
    await pool.query('ALTER TABLE points_ledger DISABLE TRIGGER points_ledger_immutable');
    for (const sql of [
      'DELETE FROM trade_notes WHERE user_id = ANY($1)',
      'DELETE FROM trade_reviews WHERE trade_id IN (SELECT id FROM trades WHERE user_id = ANY($1))',
      'DELETE FROM trades WHERE user_id = ANY($1)',
      'DELETE FROM fills WHERE user_id = ANY($1)',
      'DELETE FROM position_events WHERE position_id IN (SELECT id FROM positions WHERE user_id = ANY($1))',
      'UPDATE orders SET position_id = NULL WHERE user_id = ANY($1)',
      'DELETE FROM positions WHERE user_id = ANY($1)',
      'DELETE FROM orders WHERE user_id = ANY($1)',
      'DELETE FROM drawings WHERE user_id = ANY($1)',
      'DELETE FROM replay_sessions WHERE user_id = ANY($1)',
      'DELETE FROM points_ledger WHERE user_id = ANY($1)',
      'DELETE FROM accounts WHERE user_id = ANY($1)',
      'DELETE FROM users WHERE id = ANY($1)',
    ]) await pool.query(sql, [ids]);
    await pool.query('ALTER TABLE fills ENABLE TRIGGER fills_immutable');
    await pool.query('ALTER TABLE points_ledger ENABLE TRIGGER points_ledger_immutable');
    await pool.query('COMMIT');
  }

  // A market-data hub driven by a manual clock: we replay historical prices into the engine.
  const clock = { now: Date.now() };
  const md = new MarketData(createProvider(), () => clock.now);
  await md.reloadInstruments();
  await md.hours.loadHolidays();
  await md.syncContracts();
  await md.ensureActiveContracts();
  md.hours.alwaysOpen = true;
  const engine = new TradingEngine(md);
  engine.events.onTradeClosed = async (id) => {
    await generateReview(md, id);
  };

  const series = new Map<number, ChartCandle[]>();
  for (const inst of md.instruments) {
    if (!md.activeContract(inst.id)) {
      console.warn(`No active contract for ${inst.code}; skipping its demo trades.`);
      continue;
    }
    series.set(inst.id, await priceSeries(md, inst.id));
  }
  if (!series.size) throw new Error('No instruments with contracts. Check the provider configuration (or use PRICE_PROVIDER=mock).');

  const tick = (instId: number, price: number, ts: number) => {
    clock.now = ts;
    const c = md.activeContract(instId)!;
    md.onTick({ instrumentKey: c.instrument_key, ltp: price, bid: null, ask: null, volume: null, oi: null, prevClose: null, ts });
  };

  for (let u = 0; u < 5; u++) {
    const email = `demo${u + 1}@local`;
    const user = await signup(NAMES[u], email, DEMO_PASSWORD);
    await query('UPDATE users SET onboarded = TRUE WHERE id = $1', [user.id]);
    const rand = rng(1000 + u);
    // Personalities: some disciplined, some not, so dashboards and habits differ.
    const discipline = [0.9, 0.7, 0.5, 0.35, 0.8][u];
    const count = 14 + Math.floor(rand() * 14);
    let made = 0;
    const instIds = [...series.keys()];
    let cursor = 0;
    for (let k = 0; k < count; k++) {
      const instId = instIds[Math.floor(rand() * instIds.length)];
      const inst = md.instrument(instId)!;
      const candles = series.get(instId)!;
      cursor = Math.max(cursor, Math.floor(((k + rand()) / count) * (candles.length - 200)));
      const start = candles[Math.min(cursor, candles.length - 200)];
      const direction = rand() < 0.55 ? 'LONG' : 'SHORT';
      const entryTs = start.openTime + 60_000;
      tick(instId, start.c, entryTs);
      const ref = start.c;
      const dist = Math.round((ref * (0.0015 + rand() * 0.003)) / 100) * 100;
      const useStop = rand() < discipline;
      const sl = useStop ? (direction === 'LONG' ? ref - dist : ref + dist) : null;
      const tp = direction === 'LONG' ? ref + Math.round(dist * (1 + rand() * 1.5)) : ref - Math.round(dist * (1 + rand() * 1.5));
      const step = inst.qty_step;
      const qty = Math.max(inst.qty_min, Math.round(((inst.code === 'GOLD' ? 2 + rand() * 4 : 1 + rand() * 4) * (inst.code === 'GOLD' ? 1 : 100)) / step) * step);
      let placed;
      try {
        placed = await engine.placeOrder(user.id, {
          mode: 'live',
          instrument: inst.code,
          direction,
          orderType: 'MARKET',
          qtyG: qty,
          slPrice: sl,
          tpPrice: tp,
          setupTag: TAGS[Math.floor(rand() * TAGS.length)],
          planNote: ['Breakout above the morning range', 'Pullback to the 21 EMA in a trend', 'Reversal at prior day high', 'Following the daily trend', 'Reaction to US data'][Math.floor(rand() * 5)],
          confidence: 1 + Math.floor(rand() * 5),
        });
      } catch (err) {
        console.warn(`  skipped a trade for ${email}: ${(err as Error).message}`);
        continue;
      }
      const posId = placed.position!.id;
      // Undisciplined traders sometimes widen their stop.
      if (sl && rand() > discipline + 0.1) {
        await engine.modifyPosition(user.id, posId, { slPrice: direction === 'LONG' ? sl - dist : sl + dist }).catch(() => {});
      }
      // Walk forward minute by minute; the engine fires stops/targets on each tick.
      const startIdx = candles.indexOf(start);
      const hold = 10 + Math.floor(rand() * 150);
      let closed = false;
      for (let i = startIdx + 1; i < Math.min(candles.length, startIdx + hold); i++) {
        const c = candles[i];
        for (const p of direction === 'LONG' ? [c.o, c.l, c.h, c.c] : [c.o, c.h, c.l, c.c]) {
          tick(instId, p, c.openTime + 15_000);
          await engine.idle();
          await engine.processBar({ mode: 'live', instrumentId: instId, contractId: md.activeContract(instId)!.id }, { ts: c.openTime + 30_000, bid: { o: p, h: p, l: p, c: p }, ask: { o: p, h: p, l: p, c: p }, ltp: p, gapOpen: false, isCandle: false });
        }
        const open = await queryOne(`SELECT 1 FROM positions WHERE id = $1 AND status = 'open'`, [posId]);
        if (!open) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        const c = candles[Math.min(candles.length - 1, startIdx + hold)];
        tick(instId, c.c, c.openTime + 30_000);
        await engine.closePosition(user.id, posId).catch(() => {});
      }
      made += 1;
      cursor = startIdx + hold + Math.floor(rand() * 20);
      // Occasional revenge trade right after a loss.
      if (rand() > discipline + 0.2) cursor = startIdx + hold + 1;
    }
    const acc = await queryOne<{ cash_available: number }>(`SELECT cash_available FROM accounts WHERE user_id = $1 AND mode = 'live' AND is_active`, [user.id]);
    console.log(`  ${email}: ${made} closed trades, balance ${(acc!.cash_available / 100).toLocaleString('en-IN')} points`);
  }

  console.log('\nDemo users created: demo1@local ... demo5@local');
  console.log(`Shared demo password: ${DEMO_PASSWORD}`);
  await md.provider.stop().catch(() => {});
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
