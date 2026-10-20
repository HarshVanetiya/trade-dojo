// Rule-based coaching flags. Pure functions so every rule is easy to test.

export type FlagCode =
  | 'no_stop_loss'
  | 'moved_stop_further'
  | 'risk_too_high'
  | 'low_rr'
  | 'exited_winner_early'
  | 'held_loser_past_stop'
  | 'revenge_trade'
  | 'overtrading'
  | 'against_trend'
  | 'entered_at_open'
  | 'entered_near_close'
  | 'gap_stop'
  | 'both_touched';

export interface Flag {
  code: FlagCode;
  title: string;
  detail: string;
  /** 'habit' flags count toward "Top 3 habits to fix"; 'info' flags explain what happened. */
  kind: 'habit' | 'info';
}

export const FLAG_TITLES: Record<FlagCode, { title: string; advice: string; kind: 'habit' | 'info' }> = {
  no_stop_loss: { title: 'No stop-loss', advice: 'Always decide where you are wrong before you enter, and place a stop there.', kind: 'habit' },
  moved_stop_further: { title: 'Moved stop-loss further away', advice: 'Moving a stop away from price increases the loss you agreed to. Tighten stops, never widen them.', kind: 'habit' },
  risk_too_high: { title: 'Risked too much', advice: 'Keep the loss at your stop to about 1-2% of your account so a losing streak cannot sink you.', kind: 'habit' },
  low_rr: { title: 'Reward smaller than risk', advice: 'Look for trades where the target is at least as far as the stop (R:R of 1 or more).', kind: 'habit' },
  exited_winner_early: { title: 'Exited a winner early', advice: 'Let winners run to your planned target unless your plan says otherwise.', kind: 'habit' },
  held_loser_past_stop: { title: 'Held a loser past the planned stop', advice: 'The loss grew beyond what you planned. Respect your original stop.', kind: 'habit' },
  revenge_trade: { title: 'Revenge trade', advice: 'Opened within 5 minutes of a loss. Take a break after a loss before the next trade.', kind: 'habit' },
  overtrading: { title: 'Overtrading', advice: 'Too many trades in one day usually means lower-quality setups. Wait for your best ones.', kind: 'habit' },
  against_trend: { title: 'Traded against the higher-timeframe trend', advice: 'Trades with the daily trend (price vs 50-day EMA) have the wind at their back.', kind: 'habit' },
  entered_at_open: { title: 'Entered in the first 5 minutes', advice: 'The first minutes after the open are volatile and spreads are wide. Let the market settle.', kind: 'habit' },
  entered_near_close: { title: 'Entered near the close', advice: 'Entries in the last 15 minutes have little time to work and carry overnight gap risk.', kind: 'habit' },
  gap_stop: { title: 'Stopped out by a price gap', advice: 'Price opened beyond your stop, so you were filled worse than planned. That is gap risk: size positions held overnight smaller.', kind: 'info' },
  both_touched: { title: 'Stop and target in the same candle', advice: 'One candle touched both levels. We cannot know which came first, so we assume the stop (the conservative choice).', kind: 'info' },
};

export interface FlagInput {
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  entryTs: number;
  exitTs: number;
  exitReason: string;
  netPnl: number;
  grossPnl: number;
  initialSl: number | null;
  initialTp: number | null;
  initialRisk: number | null;
  rMultiple: number | null;
  plannedRr: number | null;
  riskPct: number | null;
  gapExit: boolean;
  bothTouched: boolean;
  /** Stop-loss edits in time order. */
  slChanges: Array<{ old: number | null; new: number | null }>;
  /** Exit times and net P&L of this account's trades closed before this entry. */
  priorClosed: Array<{ exitTs: number; netPnl: number }>;
  /** Positions opened the same IST day up to and including this one. */
  openedSameDay: number;
  /** 50-day EMA of daily closes before the entry day (null when not enough history). */
  dailyEma50: number | null;
  /** Session (open/close epoch ms) of the entry day, if known. */
  session: { open: number; close: number } | null;
  /** Did price reach the original target within a day after a manual exit? */
  targetReachedAfterExit: boolean | null;
  riskWarnPct: number;
  overtradingLimit: number;
}

const f = (code: FlagCode, detail: string): Flag => ({ code, title: FLAG_TITLES[code].title, detail, kind: FLAG_TITLES[code].kind });

export function computeFlags(t: FlagInput): Flag[] {
  const out: Flag[] = [];
  const long = t.direction === 'LONG';

  if (t.initialSl === null) out.push(f('no_stop_loss', 'This trade had no stop-loss, so the possible loss was open-ended.'));

  const widened = t.slChanges.some((c) => {
    if (c.old === null) return false;
    if (c.new === null) return true;
    return long ? c.new < c.old : c.new > c.old;
  });
  if (widened) out.push(f('moved_stop_further', 'You moved your stop-loss further from price while the trade was open.'));

  if (t.riskPct !== null && t.riskPct > t.riskWarnPct) {
    out.push(f('risk_too_high', `You risked ${t.riskPct.toFixed(1)}% of your account (guideline: ${t.riskWarnPct}% or less).`));
  }

  if (t.plannedRr !== null && t.plannedRr < 1) {
    out.push(f('low_rr', `Planned reward:risk was ${t.plannedRr.toFixed(2)}, so a win pays less than a loss costs.`));
  }

  if (t.exitReason === 'manual' && t.netPnl > 0 && t.initialTp !== null) {
    const earlyByR = t.rMultiple !== null && t.plannedRr !== null && t.rMultiple < 0.5 * t.plannedRr;
    if (earlyByR || t.targetReachedAfterExit) {
      const why = t.targetReachedAfterExit ? 'Price went on to reach your target after you closed.' : `You banked ${t.rMultiple!.toFixed(2)}R of a planned ${t.plannedRr!.toFixed(2)}R.`;
      out.push(f('exited_winner_early', `You closed a winning trade well before your target. ${why}`));
    }
  }

  if (t.initialRisk && t.grossPnl < 0 && Math.abs(t.grossPnl) > t.initialRisk * 1.1 && !t.gapExit) {
    out.push(f('held_loser_past_stop', `The loss was ${(Math.abs(t.grossPnl) / t.initialRisk).toFixed(2)}x the risk you planned at entry.`));
  }

  const lastLoss = t.priorClosed.filter((p) => p.netPnl < 0 && p.exitTs <= t.entryTs).sort((a, b) => b.exitTs - a.exitTs)[0];
  if (lastLoss && t.entryTs - lastLoss.exitTs <= 5 * 60_000) {
    const mins = Math.max(0, Math.round((t.entryTs - lastLoss.exitTs) / 60_000));
    out.push(f('revenge_trade', `You entered ${mins === 0 ? 'less than a minute' : `${mins} min`} after closing a losing trade.`));
  }

  if (t.openedSameDay > t.overtradingLimit) {
    out.push(f('overtrading', `This was trade #${t.openedSameDay} of the day (limit you set: ${t.overtradingLimit}).`));
  }

  if (t.dailyEma50 !== null) {
    if (long && t.entryPrice < t.dailyEma50) out.push(f('against_trend', 'You went long while price was below the daily 50 EMA (a downtrend).'));
    if (!long && t.entryPrice > t.dailyEma50) out.push(f('against_trend', 'You went short while price was above the daily 50 EMA (an uptrend).'));
  }

  if (t.session) {
    if (t.entryTs >= t.session.open && t.entryTs < t.session.open + 5 * 60_000) out.push(f('entered_at_open', 'You entered in the first 5 minutes after the market opened.'));
    if (t.entryTs < t.session.close && t.entryTs >= t.session.close - 15 * 60_000) out.push(f('entered_near_close', 'You entered within 15 minutes of the market close.'));
  }

  if (t.gapExit) out.push(f('gap_stop', 'Price opened beyond your stop-loss, so the exit was filled at the opening price, worse than your stop.'));
  if (t.bothTouched) out.push(f('both_touched', 'The exit candle touched both your stop and your target; we assumed the stop hit first.'));
  return out;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
