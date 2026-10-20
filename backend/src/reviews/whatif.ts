import { pnl } from '../lib/money.js';
import { DAY, HOUR, MINUTE } from '../lib/time.js';
import type { Candle } from '../market/types.js';

export interface WhatIf {
  available: boolean;
  /** Gross P&L in paise under the scenario (brokerage excluded). */
  pnl: number | null;
  price: number | null;
  outcome?: 'target' | 'stop' | 'open' | 'time';
  note: string;
}

export interface WhatIfs {
  heldToTarget: WhatIf;
  heldOneHour: WhatIf;
  heldOneDay: WhatIf;
  noStop: WhatIf;
}

interface Args {
  direction: 'LONG' | 'SHORT';
  qtyG: number;
  unitGrams: number;
  entryPrice: number;
  entryTs: number;
  exitTs: number;
  exitReason: string;
  initialSl: number | null;
  initialTp: number | null;
  /** 1-minute candles covering entry .. exit + 1 day, already limited to what is known at `asOf`. */
  candles: Candle[];
  asOf: number;
}

/** First stop/target hit in the candles (stop assumed first when one candle touches both). */
export function simulate(direction: 'LONG' | 'SHORT', candles: Candle[], sl: number | null, tp: number | null, until: number) {
  const long = direction === 'LONG';
  for (const c of candles) {
    if (c.openTime >= until) break;
    if (sl !== null && (long ? c.l <= sl : c.h >= sl)) return { outcome: 'stop' as const, price: sl, at: c.openTime };
    if (tp !== null && (long ? c.h >= tp : c.l <= tp)) return { outcome: 'target' as const, price: tp, at: c.openTime };
  }
  return null;
}

/** Last close known at time `t` (the candle that finished at or before t). */
export function closeAt(candles: Candle[], t: number): number | null {
  let price: number | null = null;
  for (const c of candles) {
    if (c.openTime + MINUTE > t) break;
    price = c.c;
  }
  return price;
}

const pending = (note: string): WhatIf => ({ available: false, pnl: null, price: null, note });

export function computeWhatIfs(a: Args): { whatifs: WhatIfs; complete: boolean } {
  const P = (price: number) => pnl(a.direction, a.qtyG, a.entryPrice, price, a.unitGrams);
  const afterEntry = a.candles.filter((c) => c.openTime >= Math.floor(a.entryTs / MINUTE) * MINUTE + MINUTE);
  const afterExit = a.candles.filter((c) => c.openTime >= Math.floor(a.exitTs / MINUTE) * MINUTE + MINUTE);

  // Held to target: replay the original plan (initial stop and target) from entry.
  let heldToTarget: WhatIf;
  if (a.initialTp === null) heldToTarget = { available: false, pnl: null, price: null, note: 'No target was set, so there is nothing to compare.' };
  else if (a.exitReason === 'target') heldToTarget = { available: true, pnl: P(a.initialTp), price: a.initialTp, outcome: 'target', note: 'You held to your target.' };
  else {
    const horizon = a.exitTs + DAY;
    const hit = simulate(a.direction, afterEntry, a.initialSl, a.initialTp, horizon);
    if (hit) {
      heldToTarget = {
        available: true,
        pnl: P(hit.price),
        price: hit.price,
        outcome: hit.outcome,
        note: hit.outcome === 'target' ? 'Holding with your original plan would have reached the target.' : 'Holding with your original plan would have hit the stop-loss first.',
      };
    } else if (a.asOf >= horizon) {
      const px = closeAt(afterEntry, horizon);
      heldToTarget = { available: px !== null, pnl: px !== null ? P(px) : null, price: px, outcome: 'open', note: 'Neither stop nor target was hit within a day after your exit.' };
    } else heldToTarget = pending('Waiting for more price data after your exit.');
  }

  const heldFor = (ms: number, label: string): WhatIf => {
    if (a.asOf < a.exitTs + ms) return pending(`Available ${label} after your exit.`);
    const px = closeAt(afterExit.length ? afterExit : a.candles, a.exitTs + ms);
    if (px === null) return { available: false, pnl: null, price: null, note: 'No price data for that period (market closed).' };
    return { available: true, pnl: P(px), price: px, outcome: 'time', note: `Price ${label} after your exit.` };
  };

  let noStop: WhatIf;
  if (a.exitReason !== 'stop_loss' && a.exitReason !== 'trailing_stop') noStop = { available: false, pnl: null, price: null, note: 'The stop-loss did not close this trade.' };
  else if (a.asOf < a.exitTs + DAY) {
    const hit = simulate(a.direction, afterExit, null, a.initialTp, a.asOf);
    noStop = hit ? { available: true, pnl: P(hit.price), price: hit.price, outcome: 'target', note: 'Without the stop, price later reached your target. Stops still protect you from the times it does not.' } : pending('Available a day after your exit.');
  } else {
    const hit = simulate(a.direction, afterExit, null, a.initialTp, a.exitTs + DAY);
    const px = hit ? hit.price : closeAt(afterExit, a.exitTs + DAY);
    noStop = px === null
      ? { available: false, pnl: null, price: null, note: 'No price data after the exit.' }
      : { available: true, pnl: P(px), price: px, outcome: hit ? 'target' : 'time', note: hit ? 'Without the stop, price later reached your target.' : 'Without a stop, this is where the trade would stand a day later.' };
  }

  const whatifs: WhatIfs = { heldToTarget, heldOneHour: heldFor(HOUR, '1 hour'), heldOneDay: heldFor(DAY, '1 day'), noStop };
  const complete = a.asOf >= a.exitTs + DAY;
  return { whatifs, complete };
}
