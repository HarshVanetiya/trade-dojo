import { useSyncExternalStore } from 'react';
import type { Depth, Instrument, MarketStatus, Quote } from '../lib/types';

/**
 * Tiny external store for high-frequency market data, so a tick re-renders only the
 * components that read that instrument (not the whole app).
 */
type Snapshot = {
  instruments: Instrument[];
  quotes: Record<string, Quote | null>;
  depth: Record<string, Depth | null>;
  status: Record<string, MarketStatus>;
  lastUpdate: Record<string, number>;
};

let state: Snapshot = { instruments: [], quotes: {}, depth: {}, status: {}, lastUpdate: {} };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const marketStore = {
  get: () => state,
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
  setInstruments(list: Instrument[]) {
    const quotes = { ...state.quotes };
    const status = { ...state.status };
    for (const i of list) {
      if (i.quote && (!quotes[i.code] || (quotes[i.code]!.ts ?? 0) < i.quote.ts)) quotes[i.code] = i.quote;
      status[i.code] = i.market;
    }
    state = { ...state, instruments: list, quotes, status };
    emit();
  },
  setQuote(q: Quote) {
    state = { ...state, quotes: { ...state.quotes, [q.instrument]: q }, lastUpdate: { ...state.lastUpdate, [q.instrument]: Date.now() } };
    emit();
  },
  setDepth(d: Depth) {
    state = { ...state, depth: { ...state.depth, [d.instrument]: d } };
    emit();
  },
  setStatus(code: string, s: MarketStatus) {
    state = { ...state, status: { ...state.status, [code]: s } };
    emit();
  },
};

export function useMarket<T>(select: (s: Snapshot) => T): T {
  return useSyncExternalStore(marketStore.subscribe, () => select(marketStore.get()));
}

export const useInstruments = () => useMarket((s) => s.instruments);
export const useInstrument = (code: string) => useMarket((s) => s.instruments.find((i) => i.code === code) ?? null);
export const useQuote = (code: string) => useMarket((s) => s.quotes[code] ?? null);
export const useDepth = (code: string) => useMarket((s) => s.depth[code] ?? null);
export const useMarketStatus = (code: string) => useMarket((s) => s.status[code] ?? null);
