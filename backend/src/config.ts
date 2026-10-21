import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === '1' || v?.toLowerCase() === 'true');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z.string().default('*'),
  JWT_SECRET: z.string().min(8, 'JWT_SECRET must be at least 8 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_CA_CERT_PATH: z.string().optional().default(''),
  /** The CA certificate text itself, for hosts where uploading a file is awkward. Used when no path is set. */
  DB_CA_CERT: z.string().optional().default(''),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(18).default(10),

  ADMIN_EMAIL: z.string().optional().default(''),
  ADMIN_PASSWORD: z.string().optional().default(''),
  ADMIN_NAME: z.string().optional().default('Admin'),

  PRICE_PROVIDER: z.enum(['upstox', 'mock', 'licensed']).default('upstox'),
  UPSTOX_ANALYTICS_TOKEN: z.string().optional().default(''),
  UPSTOX_API_BASE: z.string().default('https://api.upstox.com'),
  UPSTOX_INSTRUMENTS_URL: z
    .string()
    .default('https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz'),
  ROLLOVER_DAYS_BEFORE_EXPIRY: z.coerce.number().int().min(0).max(30).default(3),
  BACKFILL_ON_START: bool,

  EMAIL_VERIFICATION: bool,
  AI_COACH_ENABLED: bool,
  AI_COACH_API_KEY: z.string().optional().default(''),
  AI_COACH_MODEL: z.string().default('claude-opus-5-5'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
