import zlib from 'node:zlib';
import type { StoredInterval, Candle, MarketSession } from '../types.js';
import { toPaise } from '../types.js';
import type { UpstoxInstrumentRecord } from '../contractResolver.js';

/** Token bucket shared by every REST call: ~20 requests/sec, plus pauses after HTTP 429. */
export class RequestBudget {
  private tokens: number;
  private last = Date.now();
  private pausedUntil = 0;

  constructor(private perSecond = 20, private burst = 20) {
    this.tokens = burst;
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) {
        await sleep(this.pausedUntil - now);
        continue;
      }
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.perSecond) * 1000));
    }
  }

  pause(ms: number) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class UpstoxApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

/** v3 unit/interval for our stored intervals. */
const V3_UNITS: Record<StoredInterval, { unit: string; interval: string }> = {
  '1m': { unit: 'minutes', interval: '1' },
  '1d': { unit: 'days', interval: '1' },
};
/** v2 interval names used by the expired-instruments history endpoint. */
const V2_INTERVALS: Record<StoredInterval, string> = { '1m': '1minute', '1d': 'day' };

type RawCandle = [string, number, number, number, number, number, number?];

export function parseCandles(raw: RawCandle[] | undefined): Candle[] {
  if (!raw) return [];
  return raw
    .map((r) => ({
      openTime: Date.parse(r[0]),
      o: toPaise(r[1])!,
      h: toPaise(r[2])!,
      l: toPaise(r[3])!,
      c: toPaise(r[4])!,
      volume: Math.round(r[5] ?? 0),
      oi: r[6] === undefined || r[6] === null ? null : Math.round(r[6]),
    }))
    .filter((c) => Number.isFinite(c.openTime) && c.o > 0)
    .sort((a, b) => a.openTime - b.openTime);
}

export class UpstoxClient {
  constructor(
    private token: string,
    private base = 'https://api.upstox.com',
    public budget = new RequestBudget(),
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T = any>(path: string, query?: Record<string, string>, attempt = 0): Promise<T> {
    await this.budget.take();
    const url = new URL(path, this.base);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if (attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        return this.get(path, query, attempt + 1);
      }
      throw new UpstoxApiError(0, `Network error calling Upstox ${path}: ${(err as Error).message}`);
    }
    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
      this.budget.pause(retryAfter * 1000);
      return this.get(path, query, attempt + 1);
    }
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok || body?.status === 'error') {
      const msg = body?.errors?.[0]?.message || body?.message || `HTTP ${res.status}`;
      throw new UpstoxApiError(res.status, `Upstox ${path}: ${msg}`, body);
    }
    return body as T;
  }

  /** Cheap authenticated call used to validate the Analytics Token. */
  async marketStatus(exchange = 'MCX'): Promise<{ exchange: string; status: string; last_updated?: number }> {
    const body = await this.get<{ data: any }>(`/v2/market/status/${exchange}`);
    return body.data;
  }

  async marketTimings(date: string): Promise<MarketSession | null> {
    const body = await this.get<{ data: Array<{ exchange: string; start_time: number; end_time: number }> }>(`/v2/market/timings/${date}`);
    const mcx = body.data?.find((d) => d.exchange === 'MCX');
    return mcx ? { open: mcx.start_time, close: mcx.end_time } : null;
  }

  async holidays(): Promise<Array<{ date: string; description: string; closed_exchanges?: string[]; open_exchanges?: Array<{ exchange: string; start_time: number; end_time: number }> }>> {
    const body = await this.get<{ data: any[] }>('/v2/market/holidays');
    return body.data ?? [];
  }

  /** GET /v3/historical-candle/:instrument_key/:unit/:interval/:to_date/:from_date */
  async historicalV3(instrumentKey: string, interval: StoredInterval, from: string, to: string): Promise<Candle[]> {
    const { unit, interval: n } = V3_UNITS[interval];
    const path = `/v3/historical-candle/${encodeURIComponent(instrumentKey)}/${unit}/${n}/${to}/${from}`;
    const body = await this.get<{ data: { candles: RawCandle[] } }>(path);
    return parseCandles(body.data?.candles);
  }

  /** Today's candles for an active contract (historical endpoint excludes the current day). */
  async intradayV3(instrumentKey: string, interval: StoredInterval): Promise<Candle[]> {
    const { unit, interval: n } = V3_UNITS[interval];
    const body = await this.get<{ data: { candles: RawCandle[] } }>(`/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${unit}/${n}`);
    return parseCandles(body.data?.candles);
  }

  async expiredExpiries(underlyingKey: string): Promise<string[]> {
    const body = await this.get<{ data: string[] }>('/v2/expired-instruments/expiries', { instrument_key: underlyingKey });
    return body.data ?? [];
  }

  async expiredFutureContracts(underlyingKey: string, expiryDate: string): Promise<UpstoxInstrumentRecord[]> {
    const body = await this.get<{ data: UpstoxInstrumentRecord[] }>('/v2/expired-instruments/future/contract', {
      instrument_key: underlyingKey,
      expiry_date: expiryDate,
    });
    return body.data ?? [];
  }

  async expiredHistorical(expiredKey: string, interval: StoredInterval, from: string, to: string): Promise<Candle[]> {
    const path = `/v2/expired-instruments/historical-candle/${encodeURIComponent(expiredKey)}/${V2_INTERVALS[interval]}/${to}/${from}`;
    const body = await this.get<{ data: { candles: RawCandle[] } }>(path);
    return parseCandles(body.data?.candles);
  }

  /** Returns the one-time authorized WebSocket URL for Market Data Feed V3. */
  async feedAuthorizeV3(): Promise<string> {
    const body = await this.get<{ data: { authorized_redirect_uri?: string; authorizedRedirectUri?: string } }>(
      '/v3/feed/market-data-feed/authorize',
    );
    const uri = body.data?.authorized_redirect_uri ?? body.data?.authorizedRedirectUri;
    if (!uri) throw new UpstoxApiError(500, 'Upstox feed authorize returned no redirect URI', body);
    return uri;
  }
}

/** Download and parse the gzipped MCX instruments master JSON (public file, no auth). */
export async function downloadInstrumentsMaster(url: string, fetchImpl: typeof fetch = fetch): Promise<UpstoxInstrumentRecord[]> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Instruments master download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return parseInstrumentsFile(buf);
}

export function parseInstrumentsFile(buf: Buffer): UpstoxInstrumentRecord[] {
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  const json = (isGzip ? zlib.gunzipSync(buf) : buf).toString('utf8');
  const data = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error('Instruments master is not a JSON array');
  return data;
}

/** Decode the `exp` claim of the Analytics Token (a JWT) without verifying it. */
export function tokenExpiry(token: string): Date | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}
