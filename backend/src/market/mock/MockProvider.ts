import { EventEmitter } from 'node:events';
import { addDays, DAY, istDate, istInstant, istWeekday, MINUTE } from '../../lib/time.js';
import type { Candle, ContractInfo, DepthLevel, PriceProvider, ProviderHealth, StoredInterval, Tick } from '../types.js';

/** Deterministic PRNG so mock history is identical across restarts and test runs. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface ProductModel {
  base: number; // rupees per price unit, today
  dailyVol: number; // fraction
  spread: number; // rupees, typical bid-ask spread
  qtyScale: number;
}

const MODELS: Record<string, ProductModel> = {
  GOLD: { base: 120_000, dailyVol: 0.009, spread: 4, qtyScale: 3 },
  SILVER: { base: 145_000, dailyVol: 0.016, spread: 30, qtyScale: 8 },
};

function modelFor(product: string): ProductModel {
  return product.startsWith('SILVER') ? MODELS.SILVER : MODELS.GOLD;
}

const SESSION_OPEN = '09:00';
const SESSION_CLOSE = '23:30';
const SESSION_MINUTES = 870;
const EPOCH_DAY = '2015-01-01';

function dayIndex(date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${EPOCH_DAY}T00:00:00Z`)) / DAY);
}

/**
 * Offline price source: random-walk prices with realistic volatility and a fake order book.
 * History is generated deterministically for any date range, so replay works without a network.
 * Market hours are not enforced (alwaysOpen) so you can practise at any time.
 */
export class MockProvider extends EventEmitter implements PriceProvider {
  readonly name = 'mock';
  readonly alwaysOpen: boolean;
  private subs = new Set<string>();
  private latest = new Map<string, Tick>();
  private timer: NodeJS.Timeout | null = null;
  private cum = new Map<string, Float64Array>();
  private todayIdx = dayIndex(istDate(Date.now()));
  private live = new Map<string, { price: number; volume: number; oi: number; prevClose: number; dayOpen: number; hi: number; lo: number; day: string }>();
  private lastMessageAt: number | null = null;
  private rand = mulberry32(Date.now() & 0xffffffff);

  constructor(private opts: { tickMs?: number; alwaysOpen?: boolean; now?: () => number } = {}) {
    super();
    this.alwaysOpen = opts.alwaysOpen ?? true;
  }

  private now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  async start(): Promise<void> {
    const every = this.opts.tickMs ?? 700;
    if (this.timer) return;
    this.timer = setInterval(() => this.emitTicks(), every);
    this.timer.unref();
    this.emit('status', this.health());
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setSubscriptions(keys: string[]): void {
    this.subs = new Set(keys);
    this.emit('status', this.health());
  }

  getLatest(key: string): Tick | null {
    return this.latest.get(key) ?? null;
  }

  health(): ProviderHealth {
    return {
      provider: this.name,
      connected: !!this.timer,
      wsStatus: this.timer ? 'connected' : 'disconnected',
      tokenValid: true,
      tokenExpiresAt: null,
      lastMessageAt: this.lastMessageAt,
      reconnects: 0,
      subscribed: [...this.subs],
      note: 'Simulated random-walk prices (PRICE_PROVIDER=mock)',
    };
  }

  // ---- contracts --------------------------------------------------------

  async listContracts(products: string[]): Promise<ContractInfo[]> {
    const out: ContractInfo[] = [];
    const today = istDate(this.now());
    const [y, m] = today.split('-').map(Number);
    for (const product of products) {
      for (let k = -30; k <= 4; k++) {
        const d = new Date(Date.UTC(y, m - 1 + k, 5));
        const expiry = d.toISOString().slice(0, 10);
        out.push({
          instrumentKey: `MOCK_FO|${product}|${expiry}`,
          product,
          tradingSymbol: `${product} FUT ${expiry}`,
          underlyingKey: `MOCK_COM|${product}`,
          expiry,
          lotSize: 1,
          tickSizePaise: 100,
        });
      }
    }
    return out.sort((a, b) => a.expiry.localeCompare(b.expiry));
  }

  // ---- deterministic history -------------------------------------------

  private cumulative(product: string): Float64Array {
    let arr = this.cum.get(product);
    if (arr) return arr;
    const n = this.todayIdx + 800;
    arr = new Float64Array(n);
    const model = modelFor(product);
    const rand = mulberry32(hashString(`daily:${product}`));
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += gaussian(rand) * model.dailyVol + 0.0001; // slight upward drift
      arr[i] = acc;
    }
    this.cum.set(product, arr);
    return arr;
  }

  /** Spot close (rupees) of the IST day index. */
  private dayClose(product: string, idx: number): number {
    const cum = this.cumulative(product);
    const i = Math.max(0, Math.min(cum.length - 1, idx));
    const t = Math.max(0, Math.min(cum.length - 1, this.todayIdx));
    return modelFor(product).base * Math.exp(cum[i] - cum[t]);
  }

  /** Futures premium over spot: about 0.5% per month to expiry. */
  private basis(contract: ContractInfo, ts: number): number {
    const months = Math.max(0, (Date.parse(`${contract.expiry}T00:00:00Z`) - ts) / (30 * DAY));
    return 1 + 0.005 * months;
  }

  /** 1-minute path for one trading day: a Brownian bridge from the previous close to this day's close. */
  private dayPath(product: string, date: string): number[] {
    const idx = dayIndex(date);
    const prev = this.dayClose(product, idx - 1);
    const close = this.dayClose(product, idx);
    const model = modelFor(product);
    const sig = (model.dailyVol / Math.sqrt(SESSION_MINUTES)) * prev;
    const rand = mulberry32(hashString(`intraday:${product}:${date}`));
    const w: number[] = [0];
    for (let i = 1; i <= SESSION_MINUTES; i++) w.push(w[i - 1] + gaussian(rand) * sig);
    const wN = w[SESSION_MINUTES];
    return w.map((wi, i) => prev + ((close - prev) * i) / SESSION_MINUTES + (wi - (wN * i) / SESSION_MINUTES));
  }

  private dayMinuteCandles(contract: ContractInfo, date: string): Candle[] {
    const path = this.dayPath(contract.product, date);
    const open = istInstant(date, SESSION_OPEN).getTime();
    const model = modelFor(contract.product);
    const sig = (model.dailyVol / Math.sqrt(SESSION_MINUTES)) * path[0];
    const rand = mulberry32(hashString(`wick:${contract.product}:${date}`));
    const out: Candle[] = [];
    for (let i = 0; i < SESSION_MINUTES; i++) {
      const t = open + i * MINUTE;
      const b = this.basis(contract, t);
      const o = path[i] * b;
      const c = path[i + 1] * b;
      const h = Math.max(o, c) + Math.abs(gaussian(rand)) * sig * 0.4;
      const l = Math.min(o, c) - Math.abs(gaussian(rand)) * sig * 0.4;
      const toP = (x: number) => Math.round(x) * 100; // whole-rupee ticks
      out.push({
        openTime: t,
        o: toP(o),
        h: toP(h),
        l: toP(l),
        c: toP(c),
        volume: Math.round(5 + rand() * 60 * model.qtyScale),
        oi: Math.round(8000 + 2000 * Math.sin(i / 90)),
      });
    }
    return out;
  }

  private contractListed(contract: ContractInfo, date: string): boolean {
    // Mock contracts trade for ~4 months before expiry, until expiry day.
    return date <= contract.expiry && date >= addDays(contract.expiry, -125);
  }

  async getHistory(contract: ContractInfo, from: Date, to: Date, interval: StoredInterval): Promise<Candle[]> {
    const out: Candle[] = [];
    const end = istDate(Math.min(to.getTime(), this.now()));
    for (let d = istDate(from); d <= end; d = addDays(d, 1)) {
      const wd = istWeekday(Date.parse(`${d}T06:00:00Z`));
      if (wd === 0 || wd === 6 || !this.contractListed(contract, d)) continue;
      const mins = this.dayMinuteCandles(contract, d).filter((c) => c.openTime + MINUTE <= this.now());
      if (!mins.length) continue;
      if (interval === '1m') {
        out.push(...mins.filter((c) => c.openTime >= from.getTime() && c.openTime <= to.getTime()));
      } else {
        const dayStart = Date.parse(`${d}T00:00:00Z`) - 330 * MINUTE;
        if (dayStart < from.getTime() - DAY || dayStart > to.getTime()) continue;
        out.push({
          openTime: dayStart,
          o: mins[0].o,
          h: Math.max(...mins.map((c) => c.h)),
          l: Math.min(...mins.map((c) => c.l)),
          c: mins[mins.length - 1].c,
          volume: mins.reduce((s, c) => s + c.volume, 0),
          oi: mins[mins.length - 1].oi,
        });
      }
    }
    return out;
  }

  // ---- live ticks ------------------------------------------------------

  private contractFromKey(key: string): ContractInfo {
    const [, product, expiry] = key.split('|');
    return { instrumentKey: key, product, tradingSymbol: `${product} FUT ${expiry}`, underlyingKey: null, expiry, lotSize: 1, tickSizePaise: 100 };
  }

  private seedLive(key: string) {
    const c = this.contractFromKey(key);
    const now = this.now();
    const today = istDate(now);
    const idx = dayIndex(today);
    const path = this.dayPath(c.product, today);
    const minute = Math.max(0, Math.min(SESSION_MINUTES, Math.floor((now - istInstant(today, SESSION_OPEN).getTime()) / MINUTE)));
    const b = this.basis(c, now);
    const price = path[minute] * b;
    const st = {
      price,
      volume: 2000 + Math.round(this.rand() * 4000),
      oi: 9000,
      prevClose: this.dayClose(c.product, idx - 1) * b,
      dayOpen: path[0] * b,
      hi: Math.max(...path.slice(0, minute + 1)) * b,
      lo: Math.min(...path.slice(0, minute + 1)) * b,
      day: today,
    };
    this.live.set(key, st);
    return st;
  }

  private emitTicks() {
    const now = this.now();
    for (const key of this.subs) {
      const c = this.contractFromKey(key);
      const model = modelFor(c.product);
      const st = this.live.get(key) ?? this.seedLive(key);
      if (st.day !== istDate(now)) {
        st.prevClose = st.price;
        st.dayOpen = st.price;
        st.hi = st.lo = st.price;
        st.volume = 0;
        st.day = istDate(now);
      }
      // Occasionally skip a beat so ticks are irregular like a real feed.
      if (this.rand() < 0.15) continue;
      const perSec = model.dailyVol / Math.sqrt(SESSION_MINUTES * 60);
      st.price *= Math.exp(gaussian(this.rand) * perSec * 1.2);
      st.hi = Math.max(st.hi, st.price);
      st.lo = Math.min(st.lo, st.price);
      st.volume += Math.round(this.rand() * 5 * model.qtyScale);
      st.oi += Math.round(gaussian(this.rand) * 3);
      const ltp = Math.round(st.price) * 100;
      const half = Math.max(1, Math.round((model.spread / 2) * (0.6 + this.rand() * 0.8))) * 100;
      const bid = ltp - half;
      const ask = ltp + half;
      const bids: DepthLevel[] = [];
      const asks: DepthLevel[] = [];
      for (let i = 0; i < 5; i++) {
        bids.push({ price: bid - i * 100, qty: Math.round(1 + this.rand() * 10 * model.qtyScale) });
        asks.push({ price: ask + i * 100, qty: Math.round(1 + this.rand() * 10 * model.qtyScale) });
      }
      const tick: Tick = {
        instrumentKey: key,
        ltp,
        bid,
        ask,
        bidQty: bids[0].qty,
        askQty: asks[0].qty,
        volume: st.volume,
        oi: st.oi,
        prevClose: Math.round(st.prevClose) * 100,
        dayOpen: Math.round(st.dayOpen) * 100,
        dayHigh: Math.round(st.hi) * 100,
        dayLow: Math.round(st.lo) * 100,
        depth: { bids, asks },
        ts: now,
      };
      this.latest.set(key, tick);
      this.lastMessageAt = now;
      this.emit('tick', tick);
    }
  }

  /** Test hook: push a specific tick through the same path as generated ones. */
  injectTick(t: Tick) {
    this.latest.set(t.instrumentKey, t);
    this.lastMessageAt = t.ts;
    this.emit('tick', t);
  }
}
