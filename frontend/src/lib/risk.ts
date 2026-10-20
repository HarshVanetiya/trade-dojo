// Mirrors backend/src/engine/risk.ts so the order ticket can show risk before placing.

export type Direction = 'LONG' | 'SHORT';

function divRound(a: number, b: number) {
  const q = Math.abs(a) / Math.abs(b);
  const r = Math.floor(q + 0.5);
  return (a < 0) !== (b < 0) ? -r : r;
}

export const notional = (qtyG: number, pricePaise: number, unitGrams: number) => divRound(qtyG * pricePaise, unitGrams);

export const pnl = (dir: Direction, qtyG: number, entry: number, exit: number, unitGrams: number) =>
  divRound((exit - entry) * (dir === 'LONG' ? 1 : -1) * qtyG, unitGrams);

export interface Warning {
  code: string;
  message: string;
}

export function riskSummary(a: { direction: Direction; qtyG: number; entry: number; sl: number | null; tp: number | null; unitGrams: number; equity: number; riskWarnPct: number }) {
  const risk = a.sl !== null ? Math.abs(pnl(a.direction, a.qtyG, a.entry, a.sl, a.unitGrams)) : null;
  const reward = a.tp !== null ? Math.abs(pnl(a.direction, a.qtyG, a.entry, a.tp, a.unitGrams)) : null;
  const riskPct = risk !== null && a.equity > 0 ? (risk / a.equity) * 100 : null;
  const rr = risk && reward !== null ? reward / risk : null;
  const warnings: Warning[] = [];
  if (a.sl === null) warnings.push({ code: 'no_stop_loss', message: 'No stop-loss: one bad move could take a big bite out of your points.' });
  if (riskPct !== null && riskPct > a.riskWarnPct) warnings.push({ code: 'risk_too_high', message: `This risks ${riskPct.toFixed(1)}% of your account. Most traders keep it under ${a.riskWarnPct}%.` });
  if (rr !== null && rr < 1) warnings.push({ code: 'low_rr', message: `Reward is smaller than risk (R:R ${rr.toFixed(2)}).` });
  return { notional: notional(a.qtyG, a.entry, a.unitGrams), risk, reward, riskPct, rr, warnings };
}

export function suggestQty(a: { entry: number; sl: number; equity: number; riskPct: number; unitGrams: number; step: number; min: number; maxAffordable: number }) {
  const perGram = Math.abs(a.entry - a.sl) / a.unitGrams;
  if (perGram <= 0) return 0;
  let qty = Math.floor((a.equity * a.riskPct) / 100 / perGram / a.step) * a.step;
  qty = Math.min(qty, Math.floor(a.maxAffordable / a.step) * a.step);
  return qty >= a.min ? qty : 0;
}
