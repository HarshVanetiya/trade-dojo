import { TradingEngine } from '../src/engine/engine.js';
import { query, queryOne } from '../src/db/pool.js';
import { activeContract } from '../src/market/contracts.js';
import { MarketData } from '../src/market/marketData.js';
import { MockProvider } from '../src/market/mock/MockProvider.js';
import type { Tick } from '../src/market/types.js';
import { getActiveAccount } from '../src/services/accounts.js';
import { setSettingsForTest } from '../src/services/settings.js';
import { instrumentId, makeUser } from './helpers.js';

export const IST = (s: string) => Date.parse(`${s}+05:30`);
export const R = (rupees: number) => Math.round(rupees * 100);

/** A live-market sandbox: controllable clock, mock provider with injected ticks, real DB and engine. */
export async function harness(start = '2026-10-20T10:00:00') {
  const clock = { now: IST(start) };
  const provider = new MockProvider({ alwaysOpen: false, now: () => clock.now });
  const md = new MarketData(provider, () => clock.now);
  md.hours.setHolidays([]);
  await md.reloadInstruments();
  await md.syncContracts();
  await md.ensureActiveContracts(start.slice(0, 10));
  const events: Array<{ userId: number; type: string; data: any }> = [];
  const engine = new TradingEngine(md, { send: (userId, type, data) => events.push({ userId, type, data }) });
  md.on('quote', (q, meta) => engine.onLiveQuote(q, meta));
  md.onRollover((inst, from, to) => engine.handleRollover(inst, from, to));
  const gold = await instrumentId('GOLD');
  const silver = await instrumentId('SILVER');
  // 10 lakh points so tests can trade round gold sizes (1 lakh buys only ~8 g of gold).
  setSettingsForTest({ starting_points: 100_000_000 });
  const user = await makeUser();

  async function tick(code: 'GOLD' | 'SILVER', t: Partial<Tick> & { ltp: number }, advanceMs = 1000) {
    clock.now += advanceMs;
    const c = await activeContract(code === 'GOLD' ? gold : silver);
    provider.injectTick({ instrumentKey: c!.instrument_key, bid: null, ask: null, volume: null, oi: null, prevClose: null, ts: clock.now, ...t });
    await engine.idle();
  }

  const plan = { setupTag: 'Breakout', planNote: 'Test plan: breakout above range', confidence: 3 };
  async function account() {
    return getActiveAccount(user.id, 'live');
  }
  async function positions(status = 'open') {
    return query(`SELECT * FROM positions WHERE user_id = $1 AND status = $2 ORDER BY id`, [user.id, status]);
  }
  async function trade(positionId: number) {
    return queryOne(`SELECT * FROM trades WHERE position_id = $1`, [positionId]);
  }
  return { clock, provider, md, engine, events, gold, silver, user, tick, plan, account, positions, trade };
}
