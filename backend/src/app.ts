import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { errorHandler } from './lib/http.js';
import { notFound } from './lib/errors.js';
import { authRouter, meRouter } from './routes/auth.js';
import { registerRoutes } from './routes/index.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  const origins = config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins.includes('*') ? true : origins }));
  app.use(express.json({ limit: '200kb' }));
  // API responses carry live state; never let a browser or service worker cache them.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.use('/api/auth', authRouter);
  app.use('/api/me', meRouter);
  registerRoutes(app);

  app.use('/api', (_req, _res, next) => next(notFound('Endpoint')));
  app.use(errorHandler);
  return app;
}
