import type { Request } from 'express';
import { z } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const res = schema.safeParse(data);
  if (!res.success) {
    const first = res.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    throw badRequest('validation_error', `${where}${first?.message ?? 'Invalid input'}`, res.error.issues);
  }
  return res.data;
}

export const body = <T extends z.ZodType>(req: Request, schema: T) => parse(schema, req.body ?? {});
export const queryOf = <T extends z.ZodType>(req: Request, schema: T) => parse(schema, req.query);

export const idParam = z.coerce.number().int().positive();
