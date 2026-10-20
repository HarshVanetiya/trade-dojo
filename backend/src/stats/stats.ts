import { FLAG_TITLES, type Flag, type FlagCode } from '../reviews/flags.js';
import { IST_OFFSET_MS, istDate } from '../lib/time.js';

export interface StatTrade {
  id: number;
  entryTs: number;
  exitTs: number;
  netPnl: number;
  rMultiple: number | null;
  holdingSeconds: number;
  setupTag: string | null;
  direction: 'LONG' | 'SHORT';
  confidence: number | null;
  flags: Flag[];
}

export interface Group {
  key: string;
  trades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  avgR: number | null;
}

export interface Stats {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  totalPnl: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;
  expectancy: number;
  avgR: number | null;
  maxDrawdown: number;
  maxDrawdownPct: number;
  longestWinStreak: number;
  longestLossStreak: number;
  avgHoldingSeconds: number;
  returnPct: number;
  equityCurve: Array<{ t: number; equity: number; tradeId: number | null }>;
  byTag: Group[];
  byDirection: Group[];
  byTimeOfDay: Group[];
  byConfidence: Group[];
  calendar: Array<{ date: string; netPnl: number; trades: number }>;
  topHabits: Array<{ code: FlagCode; title: string; advice: string; count: number }>;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

function group(trades: StatTrade[], keyOf: (t: StatTrade) => string, order?: string[]): Group[] {
  const m = new Map<string, StatTrade[]>();
  for (const t of trades) {
    const k = keyOf(t);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(t);
  }
  const keys = order ? order.filter((k) => m.has(k)) : [...m.keys()].sort();
  return keys.map((key) => {
    const ts = m.get(key)!;
    const wins = ts.filter((t) => t.netPnl > 0).length;
    const rs = ts.map((t) => t.rMultiple).filter((r): r is number => r !== null);
    return { key, trades: ts.length, wins, winRate: ts.length ? (wins / ts.length) * 100 : 0, netPnl: ts.reduce((s, t) => s + t.netPnl, 0), avgR: rs.length ? mean(rs) : null };
  });
}

export const TIME_BUCKETS = ['09:00-12:00', '12:00-15:00', '15:00-18:00', '18:00-21:00', '21:00-close'];

export function timeBucket(ts: number): string {
  const h = new Date(ts + IST_OFFSET_MS).getUTCHours();
  if (h < 12) return TIME_BUCKETS[0];
  if (h < 15) return TIME_BUCKETS[1];
  if (h < 18) return TIME_BUCKETS[2];
  if (h < 21) return TIME_BUCKETS[3];
  return TIME_BUCKETS[4];
}

/** Performance metrics over closed trades (any order; sorted by exit time here). */
export function computeStats(input: StatTrade[], startingEquity: number, startTs?: number): Stats {
  const trades = [...input].sort((a, b) => a.exitTs - b.exitTs || a.id - b.id);
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.netPnl, 0);
  const total = grossWin + grossLoss;

  const curve: Stats['equityCurve'] = [{ t: startTs ?? (trades[0]?.entryTs ?? Date.now()), equity: startingEquity, tradeId: null }];
  let equity = startingEquity;
  let peak = startingEquity;
  let maxDd = 0;
  let maxDdPct = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let bestWin = 0;
  let bestLoss = 0;
  for (const t of trades) {
    equity += t.netPnl;
    curve.push({ t: t.exitTs, equity, tradeId: t.id });
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0) maxDdPct = Math.max(maxDdPct, (dd / peak) * 100);
    if (t.netPnl > 0) {
      winStreak += 1;
      lossStreak = 0;
    } else if (t.netPnl < 0) {
      lossStreak += 1;
      winStreak = 0;
    } else {
      winStreak = 0;
      lossStreak = 0;
    }
    bestWin = Math.max(bestWin, winStreak);
    bestLoss = Math.max(bestLoss, lossStreak);
  }

  const rs = trades.map((t) => t.rMultiple).filter((r): r is number => r !== null);
  const days = new Map<string, { netPnl: number; trades: number }>();
  for (const t of trades) {
    const d = istDate(t.exitTs);
    const cur = days.get(d) ?? { netPnl: 0, trades: 0 };
    cur.netPnl += t.netPnl;
    cur.trades += 1;
    days.set(d, cur);
  }

  // Top habits from the most recent 20 trades.
  const counts = new Map<FlagCode, number>();
  for (const t of trades.slice(-20)) {
    for (const code of new Set(t.flags.filter((f) => FLAG_TITLES[f.code]?.kind === 'habit').map((f) => f.code))) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  const topHabits = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([code, count]) => ({ code, title: FLAG_TITLES[code].title, advice: FLAG_TITLES[code].advice, count }));

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: trades.length - wins.length - losses.length,
    totalPnl: total,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    profitFactor: grossLoss < 0 ? grossWin / Math.abs(grossLoss) : null,
    expectancy: trades.length ? total / trades.length : 0,
    avgR: rs.length ? mean(rs) : null,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    longestWinStreak: bestWin,
    longestLossStreak: bestLoss,
    avgHoldingSeconds: mean(trades.map((t) => t.holdingSeconds)),
    returnPct: startingEquity ? (total / startingEquity) * 100 : 0,
    equityCurve: curve,
    byTag: group(trades, (t) => t.setupTag ?? 'Untagged'),
    byDirection: group(trades, (t) => t.direction, ['LONG', 'SHORT']),
    byTimeOfDay: group(trades, (t) => timeBucket(t.entryTs), TIME_BUCKETS),
    byConfidence: group(trades, (t) => String(t.confidence ?? '-'), ['1', '2', '3', '4', '5', '-']),
    calendar: [...days.entries()].sort().map(([date, v]) => ({ date, ...v })),
    topHabits,
  };
}

/** Risk-adjusted return for the leaderboard: return % divided by max drawdown % (null below the trade minimum). */
export function riskAdjustedScore(s: Pick<Stats, 'trades' | 'returnPct' | 'maxDrawdownPct'>, minTrades: number): number | null {
  if (s.trades < minTrades) return null;
  return s.returnPct / Math.max(s.maxDrawdownPct, 1);
}
