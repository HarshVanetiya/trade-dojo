import type { Express } from 'express';
import { marketRouter } from './market.js';
import { settingsPublicRouter } from './settings.js';

export function registerRoutes(app: Express) {
  app.use('/api/settings', settingsPublicRouter);
  app.use('/api', marketRouter);
}
