import { tokenStore, WS_URL } from './api';

type Listener = (data: any) => void;

/** App WebSocket with auto-reconnect (exponential backoff) and typed event listeners. */
export class LiveSocket {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private backoff = 1000;
  private timer: number | null = null;
  private stopped = true;
  private pingTimer: number | null = null;
  status: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    this.setStatus('idle');
  }

  private setStatus(s: LiveSocket['status']) {
    this.status = s;
    this.emit('__status', s);
  }

  private connect() {
    const token = tokenStore.get();
    if (!token || this.stopped) return;
    this.setStatus('connecting');
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.setStatus('open');
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), 25_000);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        this.emit(msg.type, msg.data ?? msg);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = (ev) => {
      this.ws = null;
      this.setStatus('closed');
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.stopped || ev.code === 4401) return;
      const delay = Math.min(this.backoff, 30_000) * (0.8 + Math.random() * 0.4);
      this.backoff = Math.min(this.backoff * 2, 30_000);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  on(type: string, fn: Listener): () => void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  private emit(type: string, data: unknown) {
    this.listeners.get(type)?.forEach((fn) => fn(data));
  }
}

export const socket = new LiveSocket();
