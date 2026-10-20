import type { Express } from 'express';
import { settingsPublicRouter } from './settings.js';

export function registerRoutes(app: Express) {
  app.use('/api/settings', settingsPublicRouter);
}
