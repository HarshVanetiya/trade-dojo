import { pool } from '../db/pool.js';
import { MINUTE } from '../lib/time.js';
import { upsertCandles } from './candles.js';
import type { Candle } from './types.js';

interface Building {
  instrumentId: number;
  contractId: number;
  candle: Candle;
  startVolume: number | null; // cumulative day volume at the start of the minute
  lastVolume: number | null;
  dirty: boolean;
}

/** Builds 1-minute candles from live ticks and writes them to the `candles` table. */
export class CandleBuilder {
  private building = new Map<number, Building>(); // by contract id
  private pending: Building[] = [];

  constructor(private source: 'live' | 'mock' = 'live') {}

  onTick(instrumentId: number, contractId: number, ltp: number, cumVolume: number | null, oi: number | null, ts: number) {
    const minute = Math.floor(ts / MINUTE) * MINUTE;
    let b = this.building.get(contractId);
    if (b && b.candle.openTime !== minute) {
      if (minute < b.candle.openTime) return; // late, out-of-order tick
      this.pending.push(b);
      // The new minute starts from the previous minute's last cumulative volume.
      const startVolume = b.lastVolume;
      b = undefined;
      this.building.delete(contractId);
      this.start(instrumentId, contractId, minute, ltp, startVolume, cumVolume, oi);
      return;
    }
    if (!b) {
      this.start(instrumentId, contractId, minute, ltp, cumVolume, cumVolume, oi);
      return;
    }
    const c = b.candle;
    c.h = Math.max(c.h, ltp);
    c.l = Math.min(c.l, ltp);
    c.c = ltp;
    if (cumVolume !== null) {
      // A smaller cumulative volume means the day rolled over.
      if (b.startVolume === null || cumVolume < b.startVolume) b.startVolume = cumVolume;
      b.lastVolume = cumVolume;
      c.volume = Math.max(0, cumVolume - b.startVolume);
    }
    if (oi !== null) c.oi = oi;
    b.dirty = true;
  }

  private start(instrumentId: number, contractId: number, minute: number, ltp: number, startVolume: number | null, cumVolume: number | null, oi: number | null) {
    const sv = startVolume !== null && cumVolume !== null && cumVolume >= startVolume ? startVolume : cumVolume;
    this.building.set(contractId, {
      instrumentId,
      contractId,
      candle: { openTime: minute, o: ltp, h: ltp, l: ltp, c: ltp, volume: sv !== null && cumVolume !== null ? cumVolume - sv : 0, oi },
      startVolume: sv,
      lastVolume: cumVolume,
      dirty: true,
    });
  }

  /** Current (possibly partial) candle for a contract. */
  current(contractId: number): Candle | null {
    return this.building.get(contractId)?.candle ?? null;
  }

  /** Persist completed candles and the in-progress ones (so charts include the forming bar). */
  async flush(): Promise<void> {
    const done = this.pending.splice(0);
    const partial = [...this.building.values()].filter((b) => b.dirty);
    for (const b of [...done, ...partial]) {
      b.dirty = false;
      await upsertCandles(b.instrumentId, b.contractId, '1m', [{ ...b.candle }], this.source, pool);
    }
  }
}
