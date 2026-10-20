import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { addDays, DAY, istDate } from '../lib/time.js';
import { getSettings } from '../services/settings.js';
import { CandleBuilder } from './candleBuilder.js';
import {
  activeContract,
  allContracts,
  type ContractRow,
  type InstrumentRow,
  listInstruments,
  recomputeRolloverDates,
  setActiveContract,
  targetContract,
  upsertContracts,
} from './contracts.js';
import { LicensedVendorProvider } from './licensed/LicensedVendorProvider.js';
import { MarketHoursService } from './marketHours.js';
import { MockProvider } from './mock/MockProvider.js';
import type { DepthLevel, PriceProvider, ProviderHealth, Tick } from './types.js';
import { UpstoxProvider } from './upstox/UpstoxProvider.js';

export interface Quote {
  instrumentId: number;
  contractId: number;
  contractKey: string;
  ltp: number;
  bid: number | null;
  ask: number | null;
  depth: { bids: DepthLevel[]; asks: DepthLevel[] } | null;
  volume: number | null;
  oi: number | null;
  prevClose: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  ts: number;
}

export interface QuoteMeta {
  /** First tick of a new session (price may have gapped since the last close). */
  sessionFirst: boolean;
}

export interface FeedError {
  at: string;
  message: string;
}

export type RolloverHandler = (inst: InstrumentRow, from: ContractRow, to: ContractRow) => Promise<void>;

export function createProvider(): PriceProvider {
  switch (config.PRICE_PROVIDER) {
    case 'mock':
      return new MockProvider();
    case 'licensed':
      return new LicensedVendorProvider();
    default:
      return new UpstoxProvider({ token: config.UPSTOX_ANALYTICS_TOKEN, apiBase: config.UPSTOX_API_BASE, instrumentsUrl: config.UPSTOX_INSTRUMENTS_URL });
  }
}

/**
 * Central market-data hub: owns the provider, resolves contracts, turns ticks into quotes,
 * candles and stored ticks, and decides whether live trading is possible right now.
 * Events: 'quote' (Quote, QuoteMeta), 'rollover' ({ instrumentId, from, to }), 'status' (ProviderHealth).
 */
export class MarketData extends EventEmitter {
  readonly hours = new MarketHoursService();
  instruments: InstrumentRow[] = [];
  private active = new Map<number, ContractRow>();
  private byKey = new Map<string, ContractRow>();
  private quotes = new Map<number, Quote>();
  private lastTickAt = new Map<number, number>();
  private tickBuffer: Array<[number, number, Tick]> = [];
  private lastStoredAt = new Map<number, number>();
  private builder: CandleBuilder;
  private timers: NodeJS.Timeout[] = [];
  private errors: FeedError[] = [];
  private rolloverHandler: RolloverHandler | null = null;
  private maintenanceDay: string | null = null;
  private maintaining = false;
  lastContractSync: string | null = null;

  constructor(readonly provider: PriceProvider, public clock: () => number = Date.now) {
    super();
    this.setMaxListeners(50);
    this.builder = new CandleBuilder(provider.name === 'mock' ? 'mock' : 'live');
    this.hours.alwaysOpen = provider.alwaysOpen;
    provider.on('tick', (t: Tick) => this.onTick(t));
    provider.on('error', (e: Error) => this.recordError(e.message));
    provider.on('status', (h: ProviderHealth) => this.emit('status', h));
    provider.on('market_info', (m: { open: boolean }) => this.hours.setProviderStatus(m.open));
  }

  onRollover(fn: RolloverHandler) {
    this.rolloverHandler = fn;
  }

  recordError(message: string) {
    this.errors.unshift({ at: new Date().toISOString(), message });
    this.errors.length = Math.min(this.errors.length, 50);
    console.error(`[market] ${message}`);
  }

  recentErrors() {
    return this.errors;
  }

  async start(opts: { timers?: boolean } = {}) {
    await this.reloadInstruments();
    await this.hours.loadHolidays();
    await this.dailyMaintenance(true);
    await this.provider.start();
    this.resubscribe();
    if (opts.timers !== false) {
      this.timers.push(setInterval(() => void this.flush(), 2_000));
      this.timers.push(setInterval(() => void this.dailyMaintenance(false), 5 * 60_000));
      for (const t of this.timers) t.unref();
    }
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.provider.stop();
    await this.flush().catch(() => {});
  }

  async reloadInstruments() {
    this.instruments = await listInstruments();
  }

  instrument(id: number): InstrumentRow | undefined {
    return this.instruments.find((i) => i.id === id);
  }

  instrumentByCode(code: string): InstrumentRow | undefined {
    return this.instruments.find((i) => i.code === code.toUpperCase());
  }

  activeContract(instrumentId: number): ContractRow | null {
    return this.active.get(instrumentId) ?? null;
  }

  getQuote(instrumentId: number): Quote | null {
    return this.quotes.get(instrumentId) ?? null;
  }

  lastTick(instrumentId: number): number | null {
    return this.lastTickAt.get(instrumentId) ?? null;
  }

  isStale(instrumentId: number, now = this.clock()): boolean {
    const last = this.lastTickAt.get(instrumentId);
    if (!this.hours.isOpen(now)) return false;
    const session = this.hours.sessionAt(now);
    const staleMs = getSettings().stale_after_seconds * 1000;
    // Give the feed the same grace period right after the open.
    if (session && now - session.open < staleMs) return false;
    return !last || now - last > staleMs;
  }

  /** Can a live order be placed / triggered right now? */
  liveTradable(instrumentId: number, now = this.clock()): { ok: boolean; code?: string; message?: string } {
    const status = this.hours.status(now);
    if (!status.open) return { ok: false, code: 'market_closed', message: 'Market is closed. Practise in Replay mode meanwhile.' };
    const h = this.provider.health();
    if (h.tokenValid === false) return { ok: false, code: 'prices_unavailable', message: 'Live prices are unavailable right now.' };
    if (!this.quotes.get(instrumentId)) return { ok: false, code: 'no_price', message: 'Waiting for the first live price.' };
    if (this.isStale(instrumentId, now)) return { ok: false, code: 'prices_delayed', message: 'Prices are delayed. New live orders are paused.' };
    return { ok: true };
  }

  marketStatus(instrumentId: number, now = this.clock()) {
    const st = this.hours.status(now);
    const h = this.provider.health();
    return {
      ...st,
      stale: this.isStale(instrumentId, now),
      lastTickAt: this.lastTickAt.get(instrumentId) ? new Date(this.lastTickAt.get(instrumentId)!).toISOString() : null,
      liveAvailable: h.tokenValid !== false && this.provider.name !== 'licensed',
      provider: this.provider.name,
    };
  }

  // ---- ticks -------------------------------------------------------------

  onTick(t: Tick) {
    const contract = this.byKey.get(t.instrumentKey);
    if (!contract || !contract.is_active) return;
    // Receipt time, not the exchange's last-trade time: quotes can update without new trades.
    const now = this.clock();
    const instId = contract.instrument_id;
    const prev = this.lastTickAt.get(instId);
    // Never act on prices outside trading hours (a late or stray message).
    if (!this.hours.isOpen(now)) return;
    const session = this.hours.sessionAt(now);
    const sessionFirst = !this.provider.alwaysOpen && !!session && (!prev || prev < session.open);
    const q: Quote = {
      instrumentId: instId,
      contractId: contract.id,
      contractKey: contract.instrument_key,
      ltp: t.ltp,
      bid: t.bid,
      ask: t.ask,
      depth: t.depth ?? null,
      volume: t.volume,
      oi: t.oi,
      prevClose: t.prevClose,
      dayOpen: t.dayOpen ?? null,
      dayHigh: t.dayHigh ?? null,
      dayLow: t.dayLow ?? null,
      ts: now,
    };
    this.quotes.set(instId, q);
    this.lastTickAt.set(instId, now);
    this.builder.onTick(instId, contract.id, t.ltp, t.volume, t.oi, now);
    const lastStored = this.lastStoredAt.get(instId) ?? 0;
    if (now - lastStored >= 500) {
      this.lastStoredAt.set(instId, now);
      this.tickBuffer.push([instId, contract.id, t]);
    }
    this.emit('quote', q, { sessionFirst } satisfies QuoteMeta);
  }

  async flush() {
    try {
      const ticks = this.tickBuffer.splice(0);
      for (let i = 0; i < ticks.length; i += 200) {
        const part = ticks.slice(i, i + 200);
        const vals: unknown[] = [];
        const rows = part.map(([inst, contract, t], j) => {
          const b = j * 8;
          vals.push(inst, contract, t.ltp, t.bid, t.ask, t.volume, t.oi, new Date(t.ts));
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
        });
        await pool.query(`INSERT INTO price_ticks (instrument_id, contract_id, ltp, bid, ask, volume, oi, ts) VALUES ${rows.join(',')}`, vals);
      }
      await this.builder.flush();
    } catch (err) {
      this.recordError(`storing ticks/candles failed: ${(err as Error).message}`);
    }
  }

  // ---- contracts & rollover ---------------------------------------------

  private resubscribe() {
    this.provider.setSubscriptions([...this.active.values()].map((c) => c.instrument_key));
  }

  private async refreshContractMaps() {
    this.byKey.clear();
    for (const inst of this.instruments) {
      for (const c of await allContracts(inst.id)) this.byKey.set(c.instrument_key, c);
      const a = await activeContract(inst.id);
      if (a) this.active.set(inst.id, a);
      else this.active.delete(inst.id);
    }
  }

  /** Download the instruments master and store contracts for every configured product. */
  async syncContracts() {
    const rolloverDays = getSettings().rollover_days;
    for (const inst of this.instruments) {
      try {
        const contracts = await this.provider.listContracts([inst.product_symbol]);
        if (!contracts.length) this.recordError(`No futures contracts found for ${inst.product_symbol} in the instruments master`);
        await upsertContracts(inst.id, contracts, rolloverDays);
      } catch (err) {
        this.recordError(`Instrument master sync failed for ${inst.code}: ${(err as Error).message}`);
      }
    }
    this.lastContractSync = new Date().toISOString();
  }

  /**
   * Make sure each instrument tracks the right contract. When the target changes (rollover date
   * reached, or admin changed the product), the rollover handler closes positions on the old
   * contract at its last price before we switch.
   */
  async ensureActiveContracts(today = istDate(this.clock())) {
    const rolloverDays = getSettings().rollover_days;
    await query(`UPDATE contracts SET is_expired = TRUE WHERE expiry < $1 AND NOT is_expired`, [today]);
    let changed = false;
    for (const inst of this.instruments) {
      const current = await activeContract(inst.id);
      const target = await targetContract(inst, rolloverDays, today);
      if (!target) {
        if (!current) this.recordError(`No tradable ${inst.product_symbol} contract found for ${inst.display_name}`);
        continue;
      }
      if (current?.id === target.id) continue;
      if (current && this.rolloverHandler) {
        try {
          await this.rolloverHandler(inst, current, target);
        } catch (err) {
          this.recordError(`Rollover handler failed for ${inst.code}: ${(err as Error).message}`);
          continue; // try again on the next maintenance pass rather than orphaning positions
        }
      }
      await setActiveContract(inst.id, target.id);
      this.quotes.delete(inst.id);
      this.lastTickAt.delete(inst.id);
      changed = true;
      console.log(`[market] ${inst.code} now tracks ${target.trading_symbol} (expiry ${target.expiry})`);
      if (current) this.emit('rollover', { instrumentId: inst.id, from: current, to: target });
    }
    await this.refreshContractMaps();
    if (changed) this.resubscribe();
  }

  /** Runs at startup and every few minutes; does daily work once per IST day. */
  async dailyMaintenance(force: boolean) {
    if (this.maintaining) return;
    this.maintaining = true;
    try {
      const today = istDate(this.clock());
      if (force || this.maintenanceDay !== today) {
        this.maintenanceDay = today;
        await this.syncContracts();
        await this.syncProviderCalendar(today);
        await this.pruneTicks();
      }
      await this.ensureActiveContracts(today);
      this.emit('maintenance');
    } catch (err) {
      this.recordError(`Daily maintenance failed: ${(err as Error).message}`);
    } finally {
      this.maintaining = false;
    }
  }

  async onRolloverSettingChanged() {
    await recomputeRolloverDates(getSettings().rollover_days);
    await this.ensureActiveContracts();
  }

  private async syncProviderCalendar(today: string) {
    if (!this.provider.getSession) return;
    for (const d of [today, addDays(today, 1)]) {
      const s = await this.provider.getSession(d);
      if (s !== undefined) this.hours.setProviderSession(d, s);
    }
    if (this.provider.getHolidays) {
      try {
        const hols = await this.provider.getHolidays();
        for (const h of hols) {
          const toTime = (ms?: number) => (ms ? new Date(ms + 330 * 60_000).toISOString().slice(11, 16) : null);
          await query(
            `INSERT INTO market_holidays (date, description, closed, special_open, special_close)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (date) DO NOTHING`,
            [h.date, h.description, h.closed, toTime(h.open), toTime(h.close)],
          );
        }
        await this.hours.loadHolidays();
      } catch (err) {
        this.recordError(`Holiday sync failed: ${(err as Error).message}`);
      }
    }
  }

  async pruneTicks() {
    const days = getSettings().tick_retention_days;
    await query(`DELETE FROM price_ticks WHERE ts < $1`, [new Date(Date.now() - days * DAY)]);
  }

  health() {
    return {
      ...this.provider.health(),
      instruments: this.instruments.map((i) => {
        const c = this.active.get(i.id);
        return {
          code: i.code,
          product: i.product_symbol,
          contract: c?.trading_symbol ?? null,
          instrumentKey: c?.instrument_key ?? null,
          expiry: c?.expiry ?? null,
          rolloverDate: c?.rollover_date ?? null,
          lastTickAt: this.lastTickAt.get(i.id) ? new Date(this.lastTickAt.get(i.id)!).toISOString() : null,
          stale: this.isStale(i.id),
        };
      }),
      market: this.hours.status(),
      lastContractSync: this.lastContractSync,
      errors: this.errors.slice(0, 20),
    };
  }
}
