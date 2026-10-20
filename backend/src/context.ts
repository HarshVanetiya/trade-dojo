import type { TradingEngine } from './engine/engine.js';
import type { MarketData } from './market/marketData.js';
import type { ReplayService } from './replay/replay.js';

/** Long-lived services shared by routes. Set once at startup (or by tests). */
export const ctx: { md: MarketData | null; engine: TradingEngine | null; replay: ReplayService | null } = { md: null, engine: null, replay: null };

export function md(): MarketData {
  if (!ctx.md) throw new Error('Market data service not started');
  return ctx.md;
}

export function engine(): TradingEngine {
  if (!ctx.engine) throw new Error('Trading engine not started');
  return ctx.engine;
}

export function replay(): ReplayService {
  if (!ctx.replay) throw new Error('Replay service not started');
  return ctx.replay;
}
