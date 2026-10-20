// Formatting helpers. Money and prices arrive from the API as integer paise.

const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** ₹1,20,345.00 */
export function rupees(paise: number | null | undefined, opts: { sign?: boolean; decimals?: boolean } = {}): string {
  if (paise === null || paise === undefined || Number.isNaN(paise)) return '-';
  const v = paise / 100;
  const s = (opts.decimals === false ? inr0 : inr2).format(Math.abs(v));
  const sign = opts.sign ? (v > 0 ? '+' : v < 0 ? '−' : '') : v < 0 ? '−' : '';
  return `${sign}₹${s}`;
}

/** Price without the currency sign: 1,20,345.00 */
export function price(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '-';
  return inr2.format(paise / 100);
}

/** Points (1 point = ₹1 simulated): +1,234.50 pts */
export function points(paise: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (paise === null || paise === undefined || Number.isNaN(paise)) return '-';
  const v = paise / 100;
  const sign = opts.sign ? (v > 0 ? '+' : v < 0 ? '−' : '') : v < 0 ? '−' : '';
  return `${sign}${inr2.format(Math.abs(v))} pts`;
}

export function pct(v: number | null | undefined, opts: { sign?: boolean; digits?: number } = {}): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  const d = opts.digits ?? 2;
  const n = Number(Number(v).toFixed(d)); // avoid "-0.00%"
  const sign = opts.sign ? (n > 0 ? '+' : n < 0 ? '−' : '') : n < 0 ? '−' : '';
  return `${sign}${Math.abs(n).toFixed(d)}%`;
}

export function rMult(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  const n = Number(Number(v).toFixed(2));
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}R`;
}

export function grams(g: number): string {
  if (g >= 1000 && g % 100 === 0) return `${(g / 1000).toLocaleString('en-IN')} kg`;
  return `${g.toLocaleString('en-IN')} g`;
}

export function signClass(v: number | null | undefined): string {
  if (!v) return '';
  return v > 0 ? 'profit' : 'loss';
}

const ist = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', ...opts });
const fTime = ist({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fDateTime = ist({ day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const fDate = ist({ day: '2-digit', month: 'short', year: 'numeric' });

export const time = (t: string | number | Date | null | undefined) => (t ? fTime.format(new Date(t)) : '-');
export const dateTime = (t: string | number | Date | null | undefined) => (t ? fDateTime.format(new Date(t)) : '-');
export const date = (t: string | number | Date | null | undefined) => (t ? fDate.format(new Date(t)) : '-');

export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function countdown(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

/** Parse a user-typed rupee amount ("1,20,345.5") into paise; null when empty/invalid. */
export function parseRupees(s: string): number | null {
  const clean = s.replace(/[,\s₹]/g, '');
  if (!clean) return null;
  const n = Number(clean);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export const toRupeeInput = (paise: number | null | undefined) => (paise ? (paise / 100).toFixed(2) : '');

export const timeAgo = (t: number | string | null | undefined) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};
