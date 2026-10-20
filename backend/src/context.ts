import type { MarketData } from './market/marketData.js';

/** Long-lived services shared by routes. Set once at startup (or by tests). */
export const ctx: { md: MarketData | null } = { md: null };

export function md(): MarketData {
  if (!ctx.md) throw new Error('Market data service not started');
  return ctx.md;
}
