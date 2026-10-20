import type { Express } from 'express';
import { adminRouter } from './admin.js';
import { drawingsRouter } from './drawings.js';
import { leaderboardRouter } from './leaderboard.js';
import { marketRouter } from './market.js';
import { replayRouter } from './replay.js';
import { settingsPublicRouter } from './settings.js';
import { tradesRouter } from './trades.js';
import { tradingRouter } from './trading.js';

export function registerRoutes(app: Express) {
  app.use('/api/settings', settingsPublicRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', leaderboardRouter);
  app.use('/api', marketRouter);
  app.use('/api', tradingRouter);
  app.use('/api', tradesRouter);
  app.use('/api', drawingsRouter);
  app.use('/api', replayRouter);
}
