import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { toPaise, type DepthLevel, type Tick } from '../types.js';

const PROTO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'proto/MarketDataFeedV3.proto');
const TYPE = 'com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse';

let feedType: protobuf.Type | null = null;

export function feedResponseType(): protobuf.Type {
  if (!feedType) feedType = protobuf.loadSync(PROTO_PATH).lookupType(TYPE);
  return feedType;
}

export interface DecodedFeed {
  type: 'initial_feed' | 'live_feed' | 'market_info' | string;
  currentTs: number | null;
  ticks: Tick[];
  /** MCX segment status from market_info messages, e.g. NORMAL_OPEN / NORMAL_CLOSE. */
  segmentStatus: Record<string, string>;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Decode one binary FeedResponse message from the Upstox Market Data Feed V3. */
export function decodeFeedMessage(buf: Uint8Array): DecodedFeed {
  const T = feedResponseType();
  const msg = T.toObject(T.decode(buf), { longs: Number, enums: String, defaults: false, oneofs: true }) as any;
  const out: DecodedFeed = {
    type: msg.type ?? 'initial_feed',
    currentTs: num(msg.currentTs),
    ticks: [],
    segmentStatus: msg.marketInfo?.segmentStatus ?? {},
  };
  const now = out.currentTs ?? Date.now();
  for (const [key, feed] of Object.entries<any>(msg.feeds ?? {})) {
    const t = normalizeFeed(key, feed, now);
    if (t) out.ticks.push(t);
  }
  return out;
}

function normalizeFeed(instrumentKey: string, feed: any, fallbackTs: number): Tick | null {
  const ff = feed.fullFeed?.marketFF;
  const ltpc = ff?.ltpc ?? feed.ltpc ?? feed.firstLevelWithGreeks?.ltpc;
  if (!ltpc || !num(ltpc.ltp)) return null;
  const ts = num(ltpc.ltt) || fallbackTs;
  const tick: Tick = {
    instrumentKey,
    ltp: toPaise(num(ltpc.ltp))!,
    prevClose: toPaise(num(ltpc.cp)),
    bid: null,
    ask: null,
    volume: null,
    oi: null,
    ts,
  };
  if (ff) {
    const quotes: any[] = ff.marketLevel?.bidAskQuote ?? [];
    const bids: DepthLevel[] = [];
    const asks: DepthLevel[] = [];
    for (const q of quotes) {
      const bp = toPaise(num(q.bidP));
      const ap = toPaise(num(q.askP));
      if (bp && bp > 0) bids.push({ price: bp, qty: num(q.bidQ) ?? 0 });
      if (ap && ap > 0) asks.push({ price: ap, qty: num(q.askQ) ?? 0 });
    }
    tick.depth = { bids: bids.slice(0, 5), asks: asks.slice(0, 5) };
    tick.bid = bids[0]?.price ?? null;
    tick.ask = asks[0]?.price ?? null;
    tick.bidQty = bids[0]?.qty ?? null;
    tick.askQty = asks[0]?.qty ?? null;
    tick.volume = num(ff.vtt);
    tick.oi = num(ff.oi) === null ? null : Math.round(num(ff.oi)!);
    const daily = (ff.marketOHLC?.ohlc ?? []).find((o: any) => o.interval === '1d');
    if (daily) {
      tick.dayOpen = toPaise(num(daily.open));
      tick.dayHigh = toPaise(num(daily.high));
      tick.dayLow = toPaise(num(daily.low));
    }
  } else if (feed.firstLevelWithGreeks) {
    const f = feed.firstLevelWithGreeks;
    tick.bid = toPaise(num(f.firstDepth?.bidP));
    tick.ask = toPaise(num(f.firstDepth?.askP));
    tick.volume = num(f.vtt);
    tick.oi = num(f.oi);
  }
  return tick;
}

/** Build the binary subscribe/unsubscribe request Upstox expects (JSON payload sent as a binary frame). */
export function buildFeedRequest(method: 'sub' | 'unsub' | 'change_mode', instrumentKeys: string[], mode?: 'ltpc' | 'full' | 'option_greeks' | 'full_d30'): Buffer {
  const req: any = { guid: cryptoRandomId(), method, data: { instrumentKeys } };
  if (mode) req.data.mode = mode;
  return Buffer.from(JSON.stringify(req));
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}
