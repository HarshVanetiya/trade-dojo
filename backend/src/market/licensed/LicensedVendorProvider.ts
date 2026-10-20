import { EventEmitter } from 'node:events';
import type { Candle, ContractInfo, PriceProvider, ProviderHealth, StoredInterval, Tick } from '../types.js';

/**
 * Placeholder for a licensed MCX data vendor (required before a public launch unless Upstox
 * gives written permission to redistribute its data).
 *
 * TODO: pick a vendor licensed by MCX for real-time and historical data redistribution.
 * TODO: authenticate with the vendor's credentials from env (e.g. VENDOR_API_KEY), never exposed to the frontend.
 * TODO: implement listContracts() from the vendor's contract master and map to ContractInfo (expiry as IST date).
 * TODO: stream ticks (LTP, best 5 bid/ask, volume, OI) and emit them as normalized `Tick`s in paise.
 * TODO: implement getHistory() with the vendor's range limits and rate limits (chunk like upstox/historyChunks.ts).
 * TODO: implement getSession()/getHolidays() if the vendor publishes exchange timings.
 */
export class LicensedVendorProvider extends EventEmitter implements PriceProvider {
  readonly name = 'licensed';
  readonly alwaysOpen = false;

  async start(): Promise<void> {
    this.emit('error', new Error('LicensedVendorProvider is not implemented yet. Set PRICE_PROVIDER=upstox or mock.'));
  }

  async stop(): Promise<void> {}

  setSubscriptions(_keys: string[]): void {}

  getLatest(_key: string): Tick | null {
    return null;
  }

  async getHistory(_c: ContractInfo, _from: Date, _to: Date, _i: StoredInterval): Promise<Candle[]> {
    return [];
  }

  async listContracts(_products: string[]): Promise<ContractInfo[]> {
    return [];
  }

  health(): ProviderHealth {
    return {
      provider: this.name,
      connected: false,
      wsStatus: 'disabled',
      tokenValid: null,
      tokenExpiresAt: null,
      lastMessageAt: null,
      reconnects: 0,
      subscribed: [],
      note: 'Licensed vendor provider is a stub (see LicensedVendorProvider.ts TODOs).',
    };
  }
}
