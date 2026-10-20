import { notional, pnl } from '../lib/money.js';
import type { Direction } from './rules.js';

export interface RiskSummary {
  notional: number;
  riskPaise: number | null;
  riskPct: number | null;
  rewardPaise: number | null;
  rr: number | null;
  warnings: Array<{ code: 'no_stop_loss' | 'risk_too_high' | 'low_rr' | 'no_target'; message: string }>;
}

/** Risk calculator used by the order ticket (frontend mirrors this) and stored with each trade. */
export function riskSummary(args: {
  direction: Direction;
  qtyG: number;
  entry: number;
  sl: number | null;
  tp: number | null;
  unitGrams: number;
  equity: number;
  riskWarnPct: number;
}): RiskSummary {
  const { direction, qtyG, entry, sl, tp, unitGrams, equity, riskWarnPct } = args;
  const riskPaise = sl !== null ? Math.abs(pnl(direction, qtyG, entry, sl, unitGrams)) : null;
  const rewardPaise = tp !== null ? Math.abs(pnl(direction, qtyG, entry, tp, unitGrams)) : null;
  const riskPct = riskPaise !== null && equity > 0 ? (riskPaise / equity) * 100 : null;
  const rr = riskPaise && rewardPaise !== null ? rewardPaise / riskPaise : null;
  const warnings: RiskSummary['warnings'] = [];
  if (sl === null) warnings.push({ code: 'no_stop_loss', message: 'No stop-loss: one bad move could take a big bite out of your points.' });
  if (riskPct !== null && riskPct > riskWarnPct) {
    warnings.push({ code: 'risk_too_high', message: `This risks ${riskPct.toFixed(1)}% of your account. Most traders keep it under ${riskWarnPct}%.` });
  }
  if (rr !== null && rr < 1) warnings.push({ code: 'low_rr', message: `Reward is smaller than risk (R:R ${rr.toFixed(2)}). You need to win more than half your trades to profit.` });
  return { notional: notional(qtyG, entry, unitGrams), riskPaise, riskPct, rewardPaise, rr, warnings };
}

/** Position size helper: grams so that hitting the stop loses about `riskPct`% of equity. */
export function suggestQty(args: { entry: number; sl: number; equity: number; riskPct: number; unitGrams: number; step: number; min: number; maxAffordable: number }): number {
  const perGram = Math.abs(args.entry - args.sl) / args.unitGrams; // paise lost per gram
  if (perGram <= 0) return 0;
  const budget = (args.equity * args.riskPct) / 100;
  let qty = Math.floor(budget / perGram / args.step) * args.step;
  const affordable = Math.floor(args.maxAffordable / args.step) * args.step;
  qty = Math.min(qty, affordable);
  return qty >= args.min ? qty : 0;
}
