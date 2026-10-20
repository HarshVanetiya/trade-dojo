import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { verifyToken, type AuthUser } from '../services/auth.js';
import { getSettings } from '../services/settings.js';

interface Client {
  ws: WebSocket;
  user: AuthUser;
  alive: boolean;
  instruments: Set<string> | null; // null = all
  sent: Map<string, { version: number; at: number }>;
}

interface Latest {
  version: number;
  tick: unknown;
  depth: unknown;
}

/**
 * The app's own WebSocket (/ws?token=JWT). Public market data is throttled per client
 * (at most N updates/sec per instrument); private events go only to the owning user.
 */
export class WsHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<Client>();
  private latest = new Map<string, Latest>();
  private timers: NodeJS.Timeout[] = [];

  attach(server: http.Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws, req) => void this.onConnection(ws, req));
    this.timers.push(setInterval(() => this.heartbeat(), 30_000));
    this.timers.push(setInterval(() => this.pump(), 50));
    for (const t of this.timers) t.unref();
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    for (const c of this.clients) c.ws.terminate();
    this.wss?.close();
  }

  private async onConnection(ws: WebSocket, req: http.IncomingMessage) {
    const url = new URL(req.url ?? '/ws', 'http://localhost');
    const token = url.searchParams.get('token');
    let user: AuthUser;
    try {
      if (!token) throw new Error('missing token');
      user = await verifyToken(token);
    } catch {
      ws.close(4401, 'unauthorized');
      return;
    }
    const client: Client = { ws, user, alive: true, instruments: null, sent: new Map() };
    this.clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && Array.isArray(msg.instruments)) {
          client.instruments = new Set(msg.instruments.map((s: string) => String(s).toUpperCase()));
          client.sent.clear();
        } else if (msg.type === 'ping') {
          this.send(client, { type: 'pong', ts: Date.now() });
        }
      } catch {
        /* ignore malformed client messages */
      }
    });
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
    this.send(client, { type: 'hello', userId: user.id, serverTime: Date.now() });
    this.onConnectHook?.(user.id);
  }

  /** Called after a client connects (used to send the current market status / snapshot). */
  onConnectHook: ((userId: number) => void) | null = null;

  private heartbeat() {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        this.clients.delete(c);
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  private send(c: Client, data: unknown) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(data));
  }

  /** Queue the latest tick/depth for an instrument; delivery is throttled per client. */
  publishQuote(instrument: string, tick: unknown, depth: unknown) {
    const prev = this.latest.get(instrument);
    this.latest.set(instrument, { version: (prev?.version ?? 0) + 1, tick, depth });
  }

  private pump() {
    if (!this.clients.size) return;
    const minGap = 1000 / getSettings().client_max_updates_per_sec;
    const now = Date.now();
    for (const [instrument, l] of this.latest) {
      for (const c of this.clients) {
        if (c.instruments && !c.instruments.has(instrument)) continue;
        const s = c.sent.get(instrument);
        if (s && (s.version >= l.version || now - s.at < minGap)) continue;
        c.sent.set(instrument, { version: l.version, at: now });
        this.send(c, { type: 'tick', data: l.tick });
        if (l.depth) this.send(c, { type: 'depth', data: l.depth });
      }
    }
  }

  broadcast(type: string, data: unknown) {
    for (const c of this.clients) this.send(c, { type, data });
  }

  sendToUser(userId: number, type: string, data: unknown) {
    for (const c of this.clients) if (c.user.id === userId) this.send(c, { type, data });
  }

  connectedUsers(): number {
    return new Set([...this.clients].map((c) => c.user.id)).size;
  }
}

export const hub = new WsHub();
