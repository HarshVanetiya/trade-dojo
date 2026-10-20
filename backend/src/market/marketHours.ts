import { query } from '../db/pool.js';
import { addDays, istDate, istInstant, istWeekday, MINUTE } from '../lib/time.js';
import { getSettings, type MarketHours } from '../services/settings.js';
import type { MarketSession } from './types.js';

export interface HolidayRow {
  date: string;
  description: string;
  closed: boolean;
  special_open: string | null;
  special_close: string | null;
}

export interface MarketStatus {
  open: boolean;
  reason: 'open' | 'weekend' | 'holiday' | 'before_open' | 'after_close' | 'provider_closed';
  opensAt: string | null;
  closesAt: string | null;
  sessionOpen: string | null;
  holiday?: string;
  alwaysOpen: boolean;
}

/** Second Sunday of March to first Sunday of November (US daylight saving), by calendar date. */
export function isUsDst(date: string): boolean {
  const y = Number(date.slice(0, 4));
  const nthSunday = (month: number, n: number) => {
    const first = new Date(Date.UTC(y, month, 1));
    const offset = (7 - first.getUTCDay()) % 7;
    return new Date(Date.UTC(y, month, 1 + offset + (n - 1) * 7)).toISOString().slice(0, 10);
  };
  return date >= nthSunday(2, 2) && date < nthSunday(10, 1);
}

export class MarketHoursService {
  private holidays = new Map<string, HolidayRow>();
  private providerSessions = new Map<string, MarketSession | null>();
  private providerStatus: { open: boolean; at: number } | null = null;
  alwaysOpen = false;

  constructor(private hoursOverride?: () => MarketHours) {}

  private hours(): MarketHours {
    return this.hoursOverride ? this.hoursOverride() : getSettings().market_hours;
  }

  async loadHolidays() {
    const rows = await query<HolidayRow>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, description, closed,
              to_char(special_open, 'HH24:MI') AS special_open, to_char(special_close, 'HH24:MI') AS special_close
       FROM market_holidays`,
    );
    this.holidays = new Map(rows.map((r) => [r.date, r]));
  }

  setHolidays(rows: HolidayRow[]) {
    this.holidays = new Map(rows.map((r) => [r.date, r]));
  }

  setProviderSession(date: string, s: MarketSession | null) {
    this.providerSessions.set(date, s);
  }

  /** Live MCX segment status pushed by the feed (market_info messages). */
  setProviderStatus(open: boolean, at = Date.now()) {
    this.providerStatus = { open, at };
  }

  /** Trading session for an IST date, or null when the market is closed all day. */
  session(date: string): MarketSession | null {
    const h = this.holidays.get(date);
    if (h) {
      if (h.closed && !(h.special_open && h.special_close)) return null;
      if (h.special_open && h.special_close) {
        return { open: istInstant(date, h.special_open).getTime(), close: istInstant(date, h.special_close).getTime() };
      }
    }
    const hours = this.hours();
    const weekday = istWeekday(istInstant(date, '12:00'));
    if (!hours.weekdays.includes(weekday)) return null;
    if (hours.useProviderTimings && this.providerSessions.has(date)) {
      const ps = this.providerSessions.get(date);
      if (ps) return ps;
    }
    const close = isUsDst(date) ? hours.closeUsDst : hours.closeUsStd;
    return { open: istInstant(date, hours.open).getTime(), close: istInstant(date, close).getTime() };
  }

  isOpen(now = Date.now()): boolean {
    return this.status(now).open;
  }

  status(now = Date.now()): MarketStatus {
    const date = istDate(now);
    const s = this.session(date);
    const holiday = this.holidays.get(date)?.description;
    const base = { alwaysOpen: this.alwaysOpen };
    if (this.alwaysOpen) {
      return { ...base, open: true, reason: 'open', opensAt: null, closesAt: null, sessionOpen: s ? new Date(s.open).toISOString() : null };
    }
    if (s && now >= s.open && now < s.close) {
      // A fresh "closed" from the exchange feed wins (unscheduled halts, holidays we do not know about).
      if (this.providerStatus && !this.providerStatus.open && now - this.providerStatus.at < 10 * MINUTE) {
        return { ...base, open: false, reason: 'provider_closed', opensAt: this.nextOpen(now), closesAt: null, sessionOpen: null };
      }
      return { ...base, open: true, reason: 'open', opensAt: null, closesAt: new Date(s.close).toISOString(), sessionOpen: new Date(s.open).toISOString() };
    }
    const weekday = istWeekday(now);
    let reason: MarketStatus['reason'] = 'after_close';
    if (s && now < s.open) reason = 'before_open';
    else if (!s) reason = holiday ? 'holiday' : weekday === 0 || weekday === 6 ? 'weekend' : 'holiday';
    return { ...base, open: false, reason, opensAt: this.nextOpen(now), closesAt: null, sessionOpen: null, holiday };
  }

  nextOpen(now = Date.now()): string | null {
    let date = istDate(now);
    for (let i = 0; i < 20; i++) {
      const s = this.session(date);
      if (s && s.open > now) return new Date(s.open).toISOString();
      date = addDays(date, 1);
    }
    return null;
  }

  /** Session (open/close) containing `ts`, if any. */
  sessionAt(ts: number): MarketSession | null {
    const s = this.session(istDate(ts));
    return s && ts >= s.open && ts < s.close ? s : null;
  }
}
