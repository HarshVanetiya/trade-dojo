// IST helpers. MCX runs on Indian Standard Time (UTC+05:30, no DST).
export const IST_OFFSET_MS = 330 * 60 * 1000;

/** YYYY-MM-DD of the IST calendar day containing `d`. */
export function istDate(d: Date | number): string {
  const t = typeof d === 'number' ? d : d.getTime();
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes after IST midnight. */
export function istMinutes(d: Date | number): number {
  const t = typeof d === 'number' ? d : d.getTime();
  const x = new Date(t + IST_OFFSET_MS);
  return x.getUTCHours() * 60 + x.getUTCMinutes();
}

/** Day of week in IST, 0 = Sunday. */
export function istWeekday(d: Date | number): number {
  const t = typeof d === 'number' ? d : d.getTime();
  return new Date(t + IST_OFFSET_MS).getUTCDay();
}

/** UTC instant for an IST date (YYYY-MM-DD) and "HH:MM" wall time. */
export function istInstant(date: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const base = Date.parse(`${date}T00:00:00Z`);
  return new Date(base + (h * 60 + m) * 60_000 - IST_OFFSET_MS);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
