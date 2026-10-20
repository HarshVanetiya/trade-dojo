import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool, query } from '../src/db/pool.js';
import { CandleBuilder } from '../src/market/candleBuilder.js';
import { aggregate, getCandles, upsertCandles, type ChartCandle } from '../src/market/candles.js';
import { extractFutures, pickActiveContract } from '../src/market/contractResolver.js';
import { activeContract, upsertContracts } from '../src/market/contracts.js';
import { MarketData } from '../src/market/marketData.js';
import { isUsDst, MarketHoursService } from '../src/market/marketHours.js';
import { MockProvider } from '../src/market/mock/MockProvider.js';
import { parseCandles, parseInstrumentsFile, RequestBudget, UpstoxClient } from '../src/market/upstox/client.js';
import { buildFeedRequest, decodeFeedMessage } from '../src/market/upstox/feedDecoder.js';
import { chunkHistoryRange } from '../src/market/upstox/historyChunks.js';
import { marketHoursSchema } from '../src/services/settings.js';
import { instrumentId, resetDb } from './helpers.js';

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const IST = (s: string) => Date.parse(`${s}+05:30`);

describe('instruments master and contract resolution', () => {
  const records = parseInstrumentsFile(fixture('mcx-instruments-sample.json.gz'));

  it('extracts only MCX futures of the requested products, sorted by expiry', () => {
    const gold = extractFutures(records, ['GOLDM']);
    expect(gold.map((c) => c.instrumentKey)).toEqual(['MCX_FO|472781', 'MCX_FO|472782', 'MCX_FO|472783']);
    expect(gold[0]).toMatchObject({ product: 'GOLDM', expiry: '2026-11-05', tickSizePaise: 100, underlyingKey: 'MCX_COM|GOLDM' });
    // GOLD (big contract) and the GOLDM option are excluded.
    expect(extractFutures(records, ['GOLD']).map((c) => c.instrumentKey)).toEqual(['MCX_FO|454818']);
    expect(extractFutures(records, ['SILVERM', 'SILVERMIC'])).toHaveLength(3);
  });

  it('picks the near-month contract and rolls over N days before expiry', () => {
    const gold = extractFutures(records, ['GOLDM']);
    expect(pickActiveContract(gold, '2026-10-20', 3)?.instrumentKey).toBe('MCX_FO|472781');
    expect(pickActiveContract(gold, '2026-11-01', 3)?.instrumentKey).toBe('MCX_FO|472781');
    // Rollover date = 2026-11-02 (expiry 05 Nov minus 3 days): switch on that day.
    expect(pickActiveContract(gold, '2026-11-02', 3)?.instrumentKey).toBe('MCX_FO|472782');
    expect(pickActiveContract(gold, '2026-11-04', 0)?.instrumentKey).toBe('MCX_FO|472781');
    expect(pickActiveContract(gold, '2027-02-01', 3)).toBeNull();
  });
});

describe('historical API chunking', () => {
  it('splits 1-minute requests into at most one month each, from Jan 2022', () => {
    const chunks = chunkHistoryRange('1m', '2021-06-01', '2022-03-15');
    expect(chunks[0].from).toBe('2022-01-01');
    expect(chunks).toEqual([
      { from: '2022-01-01', to: '2022-01-31' },
      { from: '2022-02-01', to: '2022-02-28' },
      { from: '2022-03-01', to: '2022-03-15' },
    ]);
  });

  it('keeps every minute chunk within one month even from mid-month starts', () => {
    for (const ch of chunkHistoryRange('1m', '2024-01-31', '2024-12-31')) {
      const months = (Date.parse(ch.to) - Date.parse(ch.from)) / 86_400_000;
      expect(months).toBeLessThanOrEqual(31);
      expect(ch.from <= ch.to).toBe(true);
    }
    const covered = chunkHistoryRange('1m', '2024-01-31', '2024-12-31');
    for (let i = 1; i < covered.length; i++) {
      expect(Date.parse(covered[i].from) - Date.parse(covered[i - 1].to)).toBe(86_400_000);
    }
  });

  it('splits daily requests into decades, from Jan 2000', () => {
    expect(chunkHistoryRange('1d', '1995-01-01', '2026-10-20')).toEqual([
      { from: '2000-01-01', to: '2009-12-31' },
      { from: '2010-01-01', to: '2019-12-31' },
      { from: '2020-01-01', to: '2026-10-20' },
    ]);
  });
});

describe('Upstox REST client', () => {
  it('builds the v3 historical URL (to before from) and parses candles ascending in paise', async () => {
    const calls: string[] = [];
    const fake = (async (url: URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ status: 'success', data: { candles: [
        ['2026-10-19T09:01:00+05:30', 120010.5, 120020, 120000, 120015, 12, 10400],
        ['2026-10-19T09:00:00+05:30', 120000, 120012, 119990, 120010.5, 30, 10390],
      ] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new UpstoxClient('tok', 'https://api.upstox.com', new RequestBudget(1000, 1000), fake);
    const out = await c.historicalV3('MCX_FO|472781', '1m', '2026-10-01', '2026-10-19');
    expect(calls[0]).toBe('https://api.upstox.com/v3/historical-candle/MCX_FO%7C472781/minutes/1/2026-10-19/2026-10-01');
    expect(out[0]).toEqual({ openTime: IST('2026-10-19T09:00:00'), o: 12000000, h: 12001200, l: 11999000, c: 12001050, volume: 30, oi: 10390 });
    expect(out[1].openTime).toBeGreaterThan(out[0].openTime);
  });

  it('backs off and retries on HTTP 429', async () => {
    let n = 0;
    const fake = (async () => {
      n += 1;
      if (n === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
      return new Response(JSON.stringify({ status: 'success', data: { exchange: 'MCX', status: 'NORMAL_OPEN' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new UpstoxClient('tok', 'https://api.upstox.com', new RequestBudget(1000, 1000), fake);
    expect((await c.marketStatus()).status).toBe('NORMAL_OPEN');
    expect(n).toBe(2);
  });

  it('parses empty candle payloads', () => {
    expect(parseCandles(undefined)).toEqual([]);
  });
});

describe('Market Data Feed V3 protobuf', () => {
  it('decodes a full-mode feed message into normalized ticks', () => {
    const msg = decodeFeedMessage(fixture('feed-v3-full-sample.bin'));
    expect(msg.type).toBe('live_feed');
    const gold = msg.ticks.find((t) => t.instrumentKey === 'MCX_FO|472781')!;
    expect(gold).toMatchObject({
      ltp: 12034700,
      prevClose: 11980050,
      bid: 12034500,
      ask: 12034900,
      bidQty: 3,
      askQty: 2,
      volume: 15234,
      oi: 10456,
      dayOpen: 11990000,
      dayHigh: 12050000,
      dayLow: 11970000,
      ts: 1792483200000,
    });
    expect(gold.depth!.bids.map((b) => b.price)).toEqual([12034500, 12034400, 12034300, 12034200, 12034100]);
    expect(gold.depth!.asks).toHaveLength(5);
    const silver = msg.ticks.find((t) => t.instrumentKey === 'MCX_FO|451669')!;
    expect(silver).toMatchObject({ ltp: 14521000, bid: null, ask: null, prevClose: 14400000 });
  });

  it('decodes market_info segment status', () => {
    const msg = decodeFeedMessage(fixture('feed-v3-market-info.bin'));
    expect(msg.type).toBe('market_info');
    expect(msg.segmentStatus.MCX_FO).toBe('NORMAL_OPEN');
  });

  it('builds subscribe requests as binary JSON in full mode', () => {
    const req = JSON.parse(buildFeedRequest('sub', ['MCX_FO|1'], 'full').toString());
    expect(req).toMatchObject({ method: 'sub', data: { mode: 'full', instrumentKeys: ['MCX_FO|1'] } });
    expect(req.guid).toBeTruthy();
  });
});

describe('market hours', () => {
  const hours = new MarketHoursService(() => marketHoursSchema.parse({ useProviderTimings: false }));
  hours.setHolidays([{ date: '2026-11-09', description: 'Diwali (Laxmi Pujan)', closed: true, special_open: '18:00', special_close: '19:15' }, { date: '2026-12-25', description: 'Christmas', closed: true, special_open: null, special_close: null }]);

  it('knows US daylight saving dates', () => {
    expect(isUsDst('2026-07-01')).toBe(true);
    expect(isUsDst('2026-11-02')).toBe(false);
    expect(isUsDst('2026-03-07')).toBe(false);
    expect(isUsDst('2026-03-09')).toBe(true);
  });

  it('opens 09:00 IST and closes 23:30 (US DST) or 23:55 (US standard time)', () => {
    expect(hours.isOpen(IST('2026-10-20T08:59:59'))).toBe(false);
    expect(hours.isOpen(IST('2026-10-20T09:00:00'))).toBe(true);
    expect(hours.isOpen(IST('2026-10-20T23:29:00'))).toBe(true);
    expect(hours.isOpen(IST('2026-10-20T23:31:00'))).toBe(false);
    expect(hours.isOpen(IST('2026-11-20T23:45:00'))).toBe(true);
    expect(hours.isOpen(IST('2026-11-20T23:56:00'))).toBe(false);
  });

  it('is closed on weekends and holidays, with special sessions', () => {
    const sat = hours.status(IST('2026-10-24T12:00:00'));
    expect(sat).toMatchObject({ open: false, reason: 'weekend' });
    expect(sat.opensAt).toBe(new Date(IST('2026-10-26T09:00:00')).toISOString());
    expect(hours.status(IST('2026-12-25T12:00:00'))).toMatchObject({ open: false, reason: 'holiday' });
    expect(hours.isOpen(IST('2026-11-09T12:00:00'))).toBe(false);
    expect(hours.isOpen(IST('2026-11-09T18:30:00'))).toBe(true);
  });
});

describe('candles', () => {
  beforeEach(resetDb);

  it('builds 1m candles from ticks with per-minute volume from cumulative volume', async () => {
    const goldId = await instrumentId('GOLD');
    await upsertContracts(goldId, [{ instrumentKey: 'K1', product: 'GOLDM', tradingSymbol: 'GOLDM A', underlyingKey: null, expiry: '2026-12-04', lotSize: 1, tickSizePaise: 100 }], 3);
    const [{ id: cid }] = await query('SELECT id FROM contracts');
    const b = new CandleBuilder('live');
    const t0 = IST('2026-10-20T10:00:05');
    b.onTick(goldId, cid, 100_00, 1000, 5, t0);
    b.onTick(goldId, cid, 103_00, 1010, 6, t0 + 10_000);
    b.onTick(goldId, cid, 99_00, 1015, 7, t0 + 20_000);
    b.onTick(goldId, cid, 101_00, 1030, 8, t0 + 60_000); // next minute
    await b.flush();
    const rows = await query('SELECT o, h, l, c, volume, oi FROM candles ORDER BY open_time');
    expect(rows).toEqual([
      { o: 10000, h: 10300, l: 9900, c: 9900, volume: 15, oi: 7 },
      { o: 10100, h: 10100, l: 10100, c: 10100, volume: 15, oi: 8 },
    ]);
  });

  it('aggregates 1m into session-aligned 1h/4h and IST daily bars', () => {
    const base: ChartCandle[] = [];
    const start = IST('2026-10-20T09:00:00');
    for (let i = 0; i < 300; i++) base.push({ openTime: start + i * 60_000, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, volume: 1, oi: i, contract: 'A', contractId: 1 });
    const h1 = aggregate(base, '1h');
    expect(h1).toHaveLength(5);
    expect(h1[0]).toMatchObject({ openTime: start, o: 100, h: 160, l: 99, c: 159, volume: 60, oi: 59 });
    const h4 = aggregate(base, '4h');
    expect(h4.map((b) => b.openTime)).toEqual([start, IST('2026-10-20T13:00:00')]);
    const d = aggregate(base, '1d');
    expect(d).toHaveLength(1);
    expect(d[0].openTime).toBe(IST('2026-10-20T00:00:00'));
  });

  it('stitches contracts at rollover dates and marks the stitch point', async () => {
    const goldId = await instrumentId('GOLD');
    await upsertContracts(goldId, [
      { instrumentKey: 'OLD', product: 'GOLDM', tradingSymbol: 'GOLDM OCT', underlyingKey: null, expiry: '2026-10-05', lotSize: 1, tickSizePaise: 100 },
      { instrumentKey: 'NEW', product: 'GOLDM', tradingSymbol: 'GOLDM NOV', underlyingKey: null, expiry: '2026-11-05', lotSize: 1, tickSizePaise: 100 },
    ], 3);
    const ids = Object.fromEntries((await query('SELECT id, instrument_key FROM contracts')).map((r: any) => [r.instrument_key, r.id]));
    const day = (d: string, price: number) => ({ openTime: IST(`${d}T00:00:00`), o: price, h: price, l: price, c: price, volume: 1, oi: null });
    // Both contracts trade on overlapping days; OLD rolls over on 2026-10-02.
    await upsertCandles(goldId, ids.OLD, '1d', [day('2026-09-30', 100), day('2026-10-01', 101), day('2026-10-02', 102)], 'history');
    await upsertCandles(goldId, ids.NEW, '1d', [day('2026-09-30', 200), day('2026-10-01', 201), day('2026-10-02', 202), day('2026-10-05', 205)], 'history');
    const bars = await getCandles({ instrumentId: goldId, interval: '1d', from: IST('2026-09-29T00:00:00'), to: IST('2026-10-06T00:00:00') });
    expect(bars.map((b) => [b.c, b.contract, !!b.stitch])).toEqual([
      [100, 'GOLDM OCT', false],
      [101, 'GOLDM OCT', false],
      [202, 'GOLDM NOV', true],
      [205, 'GOLDM NOV', false],
    ]);
  });

  it('never returns data at or after the replay cutoff (asOf)', async () => {
    const goldId = await instrumentId('GOLD');
    await upsertContracts(goldId, [{ instrumentKey: 'K', product: 'GOLDM', tradingSymbol: 'GOLDM X', underlyingKey: null, expiry: '2026-12-04', lotSize: 1, tickSizePaise: 100 }], 3);
    const [{ id: cid }] = await query('SELECT id FROM contracts');
    const start = IST('2026-10-20T09:00:00');
    const mins = Array.from({ length: 120 }, (_, i) => ({ openTime: start + i * 60_000, o: 1000 + i, h: 1000 + i, l: 1000 + i, c: 1000 + i, volume: 1, oi: null }));
    await upsertCandles(goldId, cid, '1m', mins, 'history');
    const asOf = start + 37 * 60_000; // 37 one-minute candles are complete
    for (const interval of ['1m', '5m', '15m', '1h', '4h', '1d'] as const) {
      const bars = await getCandles({ instrumentId: goldId, interval, asOf, to: start + 10 * 3_600_000 });
      const last = bars[bars.length - 1];
      expect(last.c).toBe(1036); // the close of the 37th minute, never later
      expect(Math.max(...bars.map((b) => b.h))).toBe(1036);
    }
  });
});

describe('MarketData hub', () => {
  beforeEach(resetDb);

  it('resolves contracts, ignores ticks when the market is closed, and flags stale prices', async () => {
    let now = IST('2026-10-20T10:00:00');
    const provider = new MockProvider({ alwaysOpen: false, now: () => now });
    const md = new MarketData(provider, () => now);
    md.hours.setHolidays([]);
    await md.reloadInstruments();
    await md.syncContracts();
    await md.ensureActiveContracts('2026-10-20');
    const goldId = await instrumentId('GOLD');
    const active = await activeContract(goldId);
    expect(active?.expiry).toBe('2026-11-05');

    const quotes: number[] = [];
    md.on('quote', (q) => quotes.push(q.ltp));
    provider.injectTick({ instrumentKey: active!.instrument_key, ltp: 120_000_00, bid: 119_998_00, ask: 120_002_00, volume: 10, oi: 5, prevClose: null, ts: now });
    expect(quotes).toEqual([12_000_000]);
    expect(md.liveTradable(goldId).ok).toBe(true);

    now += 3 * 60_000; // no tick for 3 minutes during market hours
    expect(md.isStale(goldId)).toBe(true);
    expect(md.liveTradable(goldId)).toMatchObject({ ok: false, code: 'prices_delayed' });

    now = IST('2026-10-20T23:45:00'); // after the close
    provider.injectTick({ instrumentKey: active!.instrument_key, ltp: 121_000_00, bid: null, ask: null, volume: 10, oi: 5, prevClose: null, ts: now });
    expect(quotes).toHaveLength(1);
    expect(md.liveTradable(goldId)).toMatchObject({ ok: false, code: 'market_closed' });
  });
});
