import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { verifyToken, type AuthUser } from '../services/auth.js';
import { AppError, forbidden, unauthorized } from './errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Wraps async handlers so thrown errors reach the error middleware (Express 5 also does this, kept explicit). */
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export const requireAuth: RequestHandler = h(async (req, _res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) throw unauthorized();
  req.user = await verifyToken(token);
  next();
});

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.user?.role !== 'admin') return next(forbidden('Admins only.'));
  next();
};

export function authed(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  const e = err as any;
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON.' } });
    return;
  }
  console.error('[api] unhandled error', err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on our side.' } });
}
