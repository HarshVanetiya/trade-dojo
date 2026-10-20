// Regenerates test fixtures: npx tsx test/fixtures/makeFixtures.ts
// The feed sample follows the exact MarketDataFeed V3 wire format (FeedResponse protobuf) as Upstox sends it.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { feedResponseType } from '../../src/market/upstox/feedDecoder.js';

const dir = new URL('.', import.meta.url).pathname;
const ist = (d: string) => Date.parse(`${d}T23:59:59+05:30`);

const records = [
  { segment: 'MCX_FO', name: 'GOLDM', exchange: 'MCX', expiry: ist('2026-11-05'), instrument_type: 'FUT', asset_symbol: 'GOLDM', underlying_symbol: 'GOLDM', instrument_key: 'MCX_FO|472781', lot_size: 1, exchange_token: '472781', underlying_key: 'MCX_COM|GOLDM', tick_size: 100.0, trading_symbol: 'GOLDM FUT 05 NOV 26' },
  { segment: 'MCX_FO', name: 'GOLDM', exchange: 'MCX', expiry: ist('2026-12-04'), instrument_type: 'FUT', asset_symbol: 'GOLDM', underlying_symbol: 'GOLDM', instrument_key: 'MCX_FO|472782', lot_size: 1, exchange_token: '472782', underlying_key: 'MCX_COM|GOLDM', tick_size: 100.0, trading_symbol: 'GOLDM FUT 04 DEC 26' },
  { segment: 'MCX_FO', name: 'GOLDM', exchange: 'MCX', expiry: ist('2027-01-05'), instrument_type: 'FUT', asset_symbol: 'GOLDM', underlying_symbol: 'GOLDM', instrument_key: 'MCX_FO|472783', lot_size: 1, exchange_token: '472783', underlying_key: 'MCX_COM|GOLDM', tick_size: 100.0, trading_symbol: 'GOLDM FUT 05 JAN 27' },
  { segment: 'MCX_FO', name: 'GOLD', exchange: 'MCX', expiry: ist('2026-12-04'), instrument_type: 'FUT', asset_symbol: 'GOLD', underlying_symbol: 'GOLD', instrument_key: 'MCX_FO|454818', lot_size: 1, exchange_token: '454818', underlying_key: 'MCX_COM|GOLD', tick_size: 100.0, trading_symbol: 'GOLD FUT 04 DEC 26' },
  { segment: 'MCX_FO', name: 'GOLDM', exchange: 'MCX', expiry: ist('2026-11-05'), instrument_type: 'CE', asset_symbol: 'GOLDM', underlying_symbol: 'GOLDM', instrument_key: 'MCX_FO|500001', strike_price: 120000, trading_symbol: 'GOLDM 120000 CE 05 NOV 26' },
  { segment: 'MCX_FO', name: 'SILVERM', exchange: 'MCX', expiry: ist('2026-11-30'), instrument_type: 'FUT', asset_symbol: 'SILVERM', underlying_symbol: 'SILVERM', instrument_key: 'MCX_FO|451669', lot_size: 1, exchange_token: '451669', underlying_key: 'MCX_COM|SILVERM', tick_size: 100.0, trading_symbol: 'SILVERM FUT 30 NOV 26' },
  { segment: 'MCX_FO', name: 'SILVERM', exchange: 'MCX', expiry: ist('2027-02-26'), instrument_type: 'FUT', asset_symbol: 'SILVERM', underlying_symbol: 'SILVERM', instrument_key: 'MCX_FO|451670', lot_size: 1, exchange_token: '451670', underlying_key: 'MCX_COM|SILVERM', tick_size: 100.0, trading_symbol: 'SILVERM FUT 26 FEB 27' },
  { segment: 'MCX_FO', name: 'SILVERMIC', exchange: 'MCX', expiry: ist('2026-11-30'), instrument_type: 'FUT', asset_symbol: 'SILVERMIC', underlying_symbol: 'SILVERMIC', instrument_key: 'MCX_FO|451700', lot_size: 1, exchange_token: '451700', underlying_key: 'MCX_COM|SILVERMIC', tick_size: 100.0, trading_symbol: 'SILVERMIC FUT 30 NOV 26' },
  { segment: 'MCX_FO', name: 'CRUDEOIL', exchange: 'MCX', expiry: ist('2026-11-19'), instrument_type: 'FUT', asset_symbol: 'CRUDEOIL', underlying_symbol: 'CRUDEOIL', instrument_key: 'MCX_FO|440000', trading_symbol: 'CRUDEOIL FUT 19 NOV 26' },
  { segment: 'MCX_INDEX', name: 'MCXBULLDEX', exchange: 'MCX', instrument_type: 'INDEX', instrument_key: 'MCX_INDEX|MCXBULLDEX', trading_symbol: 'MCXBULLDEX' },
];
fs.writeFileSync(`${dir}/mcx-instruments-sample.json.gz`, zlib.gzipSync(JSON.stringify(records)));

const T = feedResponseType();
const quotes = [0, 1, 2, 3, 4].map((i) => ({ bidQ: 3 + i, bidP: 120345 - i, askQ: 2 + i, askP: 120349 + i }));
const msg = T.fromObject({
  type: 1,
  currentTs: 1792483200123,
  feeds: {
    'MCX_FO|472781': {
      fullFeed: {
        marketFF: {
          ltpc: { ltp: 120347, ltt: 1792483200000, ltq: 1, cp: 119800.5 },
          marketLevel: { bidAskQuote: quotes },
          marketOHLC: { ohlc: [
            { interval: '1d', open: 119900, high: 120500, low: 119700, close: 120347, vol: 15234, ts: 1792434600000 },
            { interval: 'I1', open: 120340, high: 120350, low: 120330, close: 120347, vol: 12, ts: 1792483140000 },
          ] },
          atp: 120100.25,
          vtt: 15234,
          oi: 10456,
          tbq: 1200,
          tsq: 1100,
        },
      },
      requestMode: 1,
    },
    'MCX_FO|451669': { ltpc: { ltp: 145210, ltt: 1792483199000, cp: 144000 }, requestMode: 0 },
  },
});
fs.writeFileSync(`${dir}/feed-v3-full-sample.bin`, Buffer.from(T.encode(msg).finish()));
const info = T.fromObject({ type: 2, currentTs: 1792483200000, marketInfo: { segmentStatus: { MCX_FO: 2, NSE_EQ: 3 } } });
fs.writeFileSync(`${dir}/feed-v3-market-info.bin`, Buffer.from(T.encode(info).finish()));
console.log('fixtures written');
