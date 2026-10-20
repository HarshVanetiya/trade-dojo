import { ctx } from './context.js';
import { TradingEngine } from './engine/engine.js';
import type { MarketData } from './market/marketData.js';
import { depthView, quoteView } from './market/views.js';
import { queryOne } from './db/pool.js';
import { generateReview, refreshPendingReviews } from './reviews/review.js';
import { hub } from './ws/hub.js';

/** Wire market data, the trading engine and the WebSocket hub together. */
export function wireRuntime(md: MarketData) {
  const engine = new TradingEngine(md, { send: (userId, type, data) => hub.sendToUser(userId, type, data) });
  ctx.md = md;
  ctx.engine = engine;

  md.on('quote', (q, meta) => {
    engine.onLiveQuote(q, meta);
    const inst = md.instrument(q.instrumentId);
    if (inst) hub.publishQuote(inst.code, quoteView(inst, q, md.activeContract(inst.id)), depthView(inst, q));
  });
  md.onRollover((inst, from, to) => engine.handleRollover(inst, from, to));
  md.on('rollover', ({ instrumentId, from, to }) => {
    const inst = md.instrument(instrumentId);
    hub.broadcast('rollover', { instrument: inst?.code, from: from.trading_symbol, to: to.trading_symbol, expiry: to.expiry });
  });
  md.on('maintenance', () => {
    engine.sendRolloverNotices().catch((err) => md.recordError(`Rollover notices failed: ${err.message}`));
  });
  // Every closed trade gets a review; what-ifs that need later prices are filled in by a periodic job.
  engine.events.onTradeClosed = async (tradeId) => {
    const review = await generateReview(md, tradeId);
    const t = await queryOne<{ user_id: number }>('SELECT user_id FROM trades WHERE id = $1', [tradeId]);
    if (t) hub.sendToUser(t.user_id, 'review_ready', { tradeId, flags: review.flags.map((f) => f.title) });
  };
  setInterval(() => {
    refreshPendingReviews(md).catch((err) => md.recordError(`Review refresh failed: ${err.message}`));
  }, 5 * 60_000).unref();
  return engine;
}
