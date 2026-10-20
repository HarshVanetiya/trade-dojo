import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { addDays, istDate } from '../../lib/time.js';
import { extractFutures, type UpstoxInstrumentRecord } from '../contractResolver.js';
import type { Candle, ContractInfo, MarketSession, PriceProvider, ProviderHealth, StoredInterval, Tick } from '../types.js';
import { chunkHistoryRange } from './historyChunks.js';
import { downloadInstrumentsMaster, sleep, tokenExpiry, UpstoxApiError, UpstoxClient } from './client.js';
import { buildFeedRequest, decodeFeedMessage } from './feedDecoder.js';

export interface UpstoxProviderOptions {
  token: string;
  apiBase: string;
  instrumentsUrl: string;
  log?: (msg: string) => void;
}

/**
 * Upstox market data via a read-only Analytics Token.
 * Opens exactly ONE Market Data Feed V3 WebSocket (Upstox allows two per account).
 */
export class UpstoxProvider extends EventEmitter implements PriceProvider {
  readonly name = 'upstox';
  readonly alwaysOpen = false;
  readonly client: UpstoxClient;
  private ws: WebSocket | null = null;
  private subs = new Set<string>();
  private latest = new Map<string, Tick>();
  private wsStatus: ProviderHealth['wsStatus'] = 'disconnected';
  private tokenValid: boolean | null = null;
  private lastMessageAt: number | null = null;
  private reconnects = 0;
  private backoffMs = 1000;
  private stopped = false;
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private note: string | undefined;
  private masterCache: { at: number; records: UpstoxInstrumentRecord[] } | null = null;
  private log: (msg: string) => void;

  constructor(private opts: UpstoxProviderOptions) {
    super();
    this.client = new UpstoxClient(opts.token, opts.apiBase);
    this.log = opts.log ?? ((m) => console.log(`[upstox] ${m}`));
  }

  async validateToken(): Promise<boolean> {
    if (!this.opts.token) {
      this.tokenValid = false;
      this.note = 'UPSTOX_ANALYTICS_TOKEN is not set';
      return false;
    }
    const exp = tokenExpiry(this.opts.token);
    if (exp && exp.getTime() < Date.now()) {
      this.tokenValid = false;
      this.note = `Analytics Token expired on ${exp.toISOString().slice(0, 10)}. Generate a new one in Upstox Developer Apps -> Analytics.`;
      return false;
    }
    try {
      await this.client.marketStatus('MCX');
      this.tokenValid = true;
      this.note = undefined;
      return true;
    } catch (err) {
      const e = err as UpstoxApiError;
      // Only an auth failure means the token is bad; network trouble leaves it "unknown".
      this.tokenValid = e.status === 401 || e.status === 403 ? false : null;
      this.note = e.message;
      return false;
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    const ok = await this.validateToken();
    if (!ok) {
      this.log(`Live prices unavailable: ${this.note}`);
      this.emit('error', new Error(`Live prices unavailable: ${this.note}`));
      this.wsStatus = this.tokenValid === false ? 'disabled' : 'disconnected';
      this.emitStatus();
      if (this.tokenValid === false) return;
    }
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close(1000);
    this.ws = null;
    this.wsStatus = 'disconnected';
  }

  setSubscriptions(keys: string[]): void {
    const next = new Set(keys);
    const removed = [...this.subs].filter((k) => !next.has(k));
    const added = keys.filter((k) => !this.subs.has(k));
    this.subs = next;
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (removed.length) this.ws.send(buildFeedRequest('unsub', removed));
      if (added.length) this.ws.send(buildFeedRequest('sub', added, 'full'));
    }
    this.emitStatus();
  }

  getLatest(key: string): Tick | null {
    return this.latest.get(key) ?? null;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.tokenValid === false) return;
    this.wsStatus = this.reconnects ? 'reconnecting' : 'connecting';
    this.emitStatus();
    let url: string;
    try {
      // Authorize first; Upstox answers with a one-time redirect URL for the socket.
      url = await this.client.feedAuthorizeV3();
    } catch (err) {
      const e = err as UpstoxApiError;
      if (e.status === 401 || e.status === 403) {
        this.tokenValid = false;
        this.note = e.message;
        this.wsStatus = 'disabled';
        this.emit('error', new Error(`Live prices unavailable: ${e.message}`));
        this.emitStatus();
        return;
      }
      this.emit('error', e);
      return this.scheduleReconnect();
    }
    const ws = new WebSocket(url, { followRedirects: true, headers: { Authorization: `Bearer ${this.opts.token}` } });
    ws.binaryType = 'nodebuffer';
    this.ws = ws;
    ws.on('open', () => {
      this.wsStatus = 'connected';
      this.backoffMs = 1000;
      this.lastMessageAt = Date.now();
      this.log(`feed connected, subscribing ${[...this.subs].join(', ') || '(none)'}`);
      if (this.subs.size) ws.send(buildFeedRequest('sub', [...this.subs], 'full'));
      this.emitStatus();
    });
    ws.on('message', (data: Buffer) => {
      this.lastMessageAt = Date.now();
      try {
        const msg = decodeFeedMessage(data);
        const mcx = msg.segmentStatus.MCX_FO;
        if (mcx) this.emit('market_info', { open: mcx === 'NORMAL_OPEN', status: mcx });
        for (const t of msg.ticks) {
          this.latest.set(t.instrumentKey, t);
          this.emit('tick', t);
        }
      } catch (err) {
        this.emit('error', new Error(`Feed decode error: ${(err as Error).message}`));
      }
    });
    // `ws` answers server pings automatically; we also track liveness ourselves.
    ws.on('ping', () => {
      this.lastMessageAt = Date.now();
    });
    ws.on('close', (code) => {
      this.ws = null;
      if (this.stopped) return;
      this.log(`feed closed (${code}), reconnecting`);
      this.scheduleReconnect();
    });
    ws.on('error', (err) => this.emit('error', new Error(`Feed socket error: ${err.message}`)));
    if (!this.watchdog) {
      this.watchdog = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
          // No traffic at all (not even pong) for 90 s: assume a dead connection.
          if (this.lastMessageAt && Date.now() - this.lastMessageAt > 90_000) this.ws.terminate();
        }
      }, 30_000);
      this.watchdog.unref();
    }
    ws.on('pong', () => {
      this.lastMessageAt = Date.now();
    });
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.wsStatus = 'reconnecting';
    this.reconnects += 1;
    const delay = Math.min(this.backoffMs, 60_000) * (0.8 + Math.random() * 0.4);
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    this.emitStatus();
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private emitStatus() {
    this.emit('status', this.health());
  }

  health(): ProviderHealth {
    const exp = tokenExpiry(this.opts.token);
    return {
      provider: this.name,
      connected: this.wsStatus === 'connected',
      wsStatus: this.wsStatus,
      tokenValid: this.tokenValid,
      tokenExpiresAt: exp ? exp.toISOString() : null,
      lastMessageAt: this.lastMessageAt,
      reconnects: this.reconnects,
      subscribed: [...this.subs],
      note: this.note,
    };
  }

  private async master(): Promise<UpstoxInstrumentRecord[]> {
    if (this.masterCache && Date.now() - this.masterCache.at < 6 * 3_600_000) return this.masterCache.records;
    const records = await downloadInstrumentsMaster(this.opts.instrumentsUrl);
    this.masterCache = { at: Date.now(), records };
    return records;
  }

  async listContracts(products: string[]): Promise<ContractInfo[]> {
    return extractFutures(await this.master(), products);
  }

  /** Expired near-month contracts for stitching older history (uses the Expired Instruments API). */
  async listExpiredContracts(product: string, sample: ContractInfo): Promise<ContractInfo[]> {
    if (!sample.underlyingKey) return [];
    try {
      const expiries = await this.client.expiredExpiries(sample.underlyingKey);
      const out: ContractInfo[] = [];
      for (const exp of expiries.slice(-30)) {
        const recs = await this.client.expiredFutureContracts(sample.underlyingKey, exp);
        out.push(...extractFutures(recs.map((r) => ({ ...r, instrument_type: r.instrument_type ?? 'FUT' })), [product]));
      }
      return out;
    } catch (err) {
      // Expired-instrument data may not cover MCX or may need a different plan; history then starts with live contracts.
      this.log(`expired contracts unavailable for ${product}: ${(err as Error).message}`);
      return [];
    }
  }

  async getHistory(contract: ContractInfo, from: Date, to: Date, interval: StoredInterval, opts?: { expired?: boolean }): Promise<Candle[]> {
    const chunks = chunkHistoryRange(interval, istDate(from), istDate(to));
    const out: Candle[] = [];
    for (const ch of chunks) {
      try {
        const part = opts?.expired
          ? await this.client.expiredHistorical(contract.instrumentKey, interval, ch.from, ch.to)
          : await this.client.historicalV3(contract.instrumentKey, interval, ch.from, ch.to);
        out.push(...part);
      } catch (err) {
        const e = err as UpstoxApiError;
        if (e.status === 400 || e.status === 404) continue; // no data for this range (e.g. before listing)
        throw err;
      }
    }
    // The historical API stops at yesterday; add today's candles for live contracts.
    if (!opts?.expired && istDate(to) >= istDate(Date.now())) {
      try {
        out.push(...(await this.client.intradayV3(contract.instrumentKey, interval)));
      } catch {
        /* intraday data is best-effort */
      }
    }
    const seen = new Map<number, Candle>();
    for (const c of out) if (c.openTime >= from.getTime() && c.openTime <= to.getTime()) seen.set(c.openTime, c);
    return [...seen.values()].sort((a, b) => a.openTime - b.openTime);
  }

  async getSession(date: string): Promise<MarketSession | null | undefined> {
    if (this.tokenValid === false) return undefined;
    try {
      return await this.client.marketTimings(date);
    } catch {
      return undefined;
    }
  }

  async getHolidays() {
    if (this.tokenValid === false) return [];
    const rows = await this.client.holidays();
    const today = istDate(Date.now());
    const out: Array<{ date: string; description: string; closed: boolean; open?: number; close?: number }> = [];
    for (const h of rows) {
      if (!h.date || h.date < addDays(today, -1)) continue;
      const open = h.open_exchanges?.find((e) => e.exchange === 'MCX');
      if (open) out.push({ date: h.date, description: h.description, closed: false, open: open.start_time, close: open.end_time });
      else if (h.closed_exchanges?.includes('MCX')) out.push({ date: h.date, description: h.description, closed: true });
    }
    return out;
  }
}

export { sleep };
