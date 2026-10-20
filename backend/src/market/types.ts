import type { EventEmitter } from 'node:events';

export type Underlying = 'GOLD' | 'SILVER';
export type StoredInterval = '1m' | '1d';
export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export const INTERVALS: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export interface DepthLevel {
  price: number; // paise
  qty: number; // exchange quantity (lots/units as reported)
}

/** A normalized market update. Prices in paise per instrument price unit. */
export interface Tick {
  instrumentKey: string; // provider contract key, e.g. MCX_FO|439488
  ltp: number;
  bid: number | null;
  ask: number | null;
  bidQty?: number | null;
  askQty?: number | null;
  volume: number | null; // cumulative volume traded today
  oi: number | null;
  prevClose: number | null;
  dayOpen?: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
  depth?: { bids: DepthLevel[]; asks: DepthLevel[] };
  ts: number; // epoch ms
}

export interface Candle {
  openTime: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
  oi: number | null;
}

/** A tradable futures contract as resolved from the instruments master file. */
export interface ContractInfo {
  instrumentKey: string;
  product: string; // e.g. GOLDM
  tradingSymbol: string;
  underlyingKey: string | null;
  expiry: string; // YYYY-MM-DD (IST)
  lotSize: number | null;
  tickSizePaise: number | null;
}

export interface ProviderHealth {
  provider: string;
  connected: boolean;
  wsStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'disabled';
  tokenValid: boolean | null;
  tokenExpiresAt: string | null;
  lastMessageAt: number | null;
  reconnects: number;
  subscribed: string[];
  note?: string;
}

export interface MarketSession {
  open: number; // epoch ms
  close: number; // epoch ms
}

/**
 * Pluggable source of MCX prices.
 * Events: 'tick' (Tick), 'status' (ProviderHealth), 'error' (Error), 'market_info' ({ open: boolean }).
 */
export interface PriceProvider extends EventEmitter {
  readonly name: string;
  /** True when the provider produces prices around the clock (mock), so market hours are not enforced. */
  readonly alwaysOpen: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Contracts to stream. Called at startup and after every rollover. */
  setSubscriptions(instrumentKeys: string[]): void;
  getLatest(instrumentKey: string): Tick | null;
  getHistory(contract: ContractInfo, from: Date, to: Date, interval: StoredInterval, opts?: { expired?: boolean }): Promise<Candle[]>;
  /** All futures contracts for the given MCX products (from the instruments master or equivalent). */
  listContracts(products: string[]): Promise<ContractInfo[]>;
  /** Expired contracts (for stitching older history), if the provider supports it. */
  listExpiredContracts?(product: string, sample: ContractInfo): Promise<ContractInfo[]>;
  /** Exchange session for an IST date, if the provider exposes market timings. null = unknown / closed. */
  getSession?(date: string): Promise<MarketSession | null | undefined>;
  /** MCX holidays known to the provider. */
  getHolidays?(): Promise<Array<{ date: string; description: string; closed: boolean; open?: number; close?: number }>>;
  health(): ProviderHealth;
}

export const toPaise = (rupees: number | null | undefined): number | null =>
  rupees === null || rupees === undefined || !Number.isFinite(rupees) ? null : Math.round(rupees * 100);
