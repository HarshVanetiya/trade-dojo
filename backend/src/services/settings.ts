import { z } from 'zod';
import { config } from '../config.js';
import { query, type Db, pool } from '../db/pool.js';

export const marketHoursSchema = z.object({
  /** Trading weekdays, 0 = Sunday. */
  weekdays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
  open: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
  /** Close while the US observes daylight saving time (roughly March to November). */
  closeUsDst: z.string().regex(/^\d{2}:\d{2}$/).default('23:30'),
  /** Close during US standard time (roughly November to March). */
  closeUsStd: z.string().regex(/^\d{2}:\d{2}$/).default('23:55'),
  /** Use Upstox market timings / status endpoints when available. */
  useProviderTimings: z.boolean().default(true),
});
export type MarketHours = z.infer<typeof marketHoursSchema>;

export const settingsSchema = z.object({
  starting_points: z.number().int().positive().default(10_000_000), // paise = 1,00,000 points
  rollover_days: z.number().int().min(0).max(30).default(config.ROLLOVER_DAYS_BEFORE_EXPIRY),
  rollover_notice_days: z.number().int().min(0).max(10).default(2),
  market_hours: marketHoursSchema.default(marketHoursSchema.parse({})),
  reset_cooldown_days: z.number().int().min(0).max(365).default(7),
  reset_threshold_pct: z.number().min(0).max(100).default(10),
  overtrading_limit: z.number().int().min(1).max(100).default(5),
  risk_warn_pct: z.number().min(0.1).max(100).default(2),
  stale_after_seconds: z.number().int().min(10).max(3600).default(120),
  leaderboard_enabled: z.boolean().default(false),
  leaderboard_min_trades: z.number().int().min(1).default(20),
  client_max_updates_per_sec: z.number().int().min(1).max(20).default(4),
  tick_retention_days: z.number().int().min(1).max(60).default(7),
});
export type Settings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof Settings;

let cache: Settings | null = null;
const listeners: Array<(s: Settings) => void> = [];

export async function loadSettings(db: Db = pool): Promise<Settings> {
  const rows = await query<{ key: string; value: unknown }>('SELECT key, value FROM settings', [], db);
  const raw: Record<string, unknown> = {};
  for (const r of rows) raw[r.key] = r.value;
  const res = settingsSchema.safeParse(raw);
  // A malformed stored value falls back to defaults key-by-key instead of breaking startup.
  if (res.success) cache = res.data;
  else {
    const fixed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      const field = (settingsSchema.shape as Record<string, z.ZodType>)[k];
      if (field && field.safeParse(v).success) fixed[k] = v;
    }
    cache = settingsSchema.parse(fixed);
  }
  return cache;
}

export function getSettings(): Settings {
  if (!cache) cache = settingsSchema.parse({});
  return cache;
}

export function onSettingsChange(fn: (s: Settings) => void) {
  listeners.push(fn);
}

export async function updateSettings(patch: Partial<Settings>, userId: number | null): Promise<Settings> {
  const current = getSettings();
  const merged = settingsSchema.parse({ ...current, ...patch });
  for (const key of Object.keys(patch) as SettingKey[]) {
    await query(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(merged[key]), userId],
    );
  }
  cache = merged;
  for (const l of listeners) l(merged);
  return merged;
}

/** Test helper: override in-memory settings without touching the DB. */
export function setSettingsForTest(patch: Partial<Settings>) {
  cache = settingsSchema.parse({ ...getSettings(), ...patch });
}
