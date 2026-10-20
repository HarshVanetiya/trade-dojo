import { AreaSeries, createChart, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toChartTime } from '../components/Chart';
import { Empty } from '../components/Common';
import { DEFAULT_FILTERS, FilterBar, filterQuery, type TradeFilters } from '../components/Filters';
import { Term } from '../components/Glossary';
import { api } from '../lib/api';
import { duration, pct, points, rMult, signClass } from '../lib/format';
import { useAuth, useIsDark } from '../state/app';

interface Group {
  key: string;
  trades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  avgR: number | null;
}

interface Stats {
  trades: number;
  wins: number;
  losses: number;
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
  equityCurve: Array<{ t: number; equity: number }>;
  byTag: Group[];
  byDirection: Group[];
  byTimeOfDay: Group[];
  byConfidence: Group[];
  calendar: Array<{ date: string; netPnl: number; trades: number }>;
  topHabits: Array<{ code: string; title: string; advice: string; count: number }>;
}

function EquityChart({ curve, dark }: { curve: Stats['equityCurve']; dark: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Area'> | null>(null);
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, { autoSize: true, layout: { attributionLogo: false, fontSize: 11 }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false }, handleScroll: false, handleScale: false });
    chart.current = c;
    series.current = c.addSeries(AreaSeries, { lineWidth: 2, priceLineVisible: false });
    return () => c.remove();
  }, []);
  useEffect(() => {
    const up = curve.length > 1 && curve[curve.length - 1].equity >= curve[0].equity;
    const line = up ? (dark ? '#4ade80' : '#15803d') : dark ? '#f87171' : '#c62828';
    chart.current?.applyOptions({
      layout: { background: { color: 'transparent' }, textColor: dark ? '#9aa5b8' : '#5b6474' },
      grid: { vertLines: { visible: false }, horzLines: { color: dark ? '#1e2737' : '#eef0f4' } },
    });
    series.current?.applyOptions({ lineColor: line, topColor: `${line}55`, bottomColor: `${line}05` });
    // Ensure strictly increasing times (several trades can close in the same second).
    let last = 0;
    const data = curve.map((p) => {
      let t = toChartTime(p.t) as number;
      if (t <= last) t = last + 1;
      last = t;
      return { time: t as any, value: p.equity / 100 };
    });
    series.current?.setData(data);
    chart.current?.timeScale().fitContent();
  }, [curve, dark]);
  return <div ref={el} style={{ height: 220 }} />;
}

function Bars({ groups, label }: { groups: Group[]; label: (k: string) => string }) {
  if (!groups.length) return <p className="small muted">No data.</p>;
  const max = Math.max(1, ...groups.map((g) => Math.abs(g.netPnl)));
  return (
    <div>
      {groups.map((g) => (
        <div className="bar-row" key={g.key}>
          <span className="small">{label(g.key)} <span className="tiny muted">({g.trades})</span></span>
          <div className="bar-track" aria-hidden="true">
            <div className="bar-fill" style={{ left: g.netPnl >= 0 ? '50%' : `${50 - (Math.abs(g.netPnl) / max) * 50}%`, width: `${(Math.abs(g.netPnl) / max) * 50}%`, background: g.netPnl >= 0 ? 'var(--profit)' : 'var(--loss)' }} />
          </div>
          <span className={`num small ${signClass(g.netPnl)}`} style={{ textAlign: 'right' }}>
            {points(g.netPnl, { sign: true }).replace(' pts', '')}
            <div className="tiny muted">{g.winRate.toFixed(0)}% win{g.avgR !== null ? ` · ${rMult(g.avgR)}` : ''}</div>
          </span>
        </div>
      ))}
    </div>
  );
}

function Calendar({ days }: { days: Stats['calendar'] }) {
  // Last 10 weeks, Monday-first, ending this week.
  const byDate = new Map(days.map((d) => [d.date, d]));
  const today = new Date(Date.now() + 330 * 60_000);
  const dow = (today.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - dow - 63));
  const max = Math.max(1, ...days.map((d) => Math.abs(d.netPnl)));
  const cells = [];
  for (let i = 0; i < 70; i++) {
    const d = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const v = byDate.get(d);
    const a = v ? 0.2 + 0.8 * (Math.abs(v.netPnl) / max) : 0;
    const bg = v ? (v.netPnl >= 0 ? `rgba(34,197,94,${a})` : `rgba(239,68,68,${a})`) : undefined;
    cells.push(
      <div key={d} className="cell" style={{ background: bg }} title={v ? `${d}: ${points(v.netPnl, { sign: true })} (${v.trades} trades)` : d}>
        {Number(d.slice(8))}
      </div>,
    );
  }
  return (
    <div>
      <div className="heatmap">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x, i) => <div key={i} className="cell head">{x}</div>)}
        {cells}
      </div>
      <p className="tiny faint" style={{ marginTop: 6 }}>Daily net P&amp;L, last 10 weeks. Green = profit, red = loss; darker = bigger.</p>
    </div>
  );
}

function Leaderboard() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [info, setInfo] = useState<{ minTrades: number } | null>(null);
  useEffect(() => {
    api('/leaderboard').then((r) => { setRows(r.rows); setInfo(r); }).catch(() => setRows([]));
  }, []);
  if (!rows) return null;
  return (
    <div className="card">
      <h2>Leaderboard</h2>
      <p className="small muted">Ranked by risk-adjusted return (return ÷ max drawdown), minimum {info?.minTrades ?? 20} trades. Raw profit is not the goal.</p>
      {rows.length === 0 ? <p className="small faint">Nobody qualifies yet.</p> : (
        <table className="data">
          <thead><tr><th>#</th><th>Trader</th><th className="r">Score</th><th className="r">Return</th><th className="r">Max DD</th><th className="r">Trades</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.me ? 'bold' : ''}><td>{i + 1}</td><td>{r.name}</td><td className="r">{r.score.toFixed(2)}</td><td className={`r ${signClass(r.returnPct)}`}>{pct(r.returnPct, { sign: true })}</td><td className="r">{pct(r.maxDrawdownPct)}</td><td className="r">{r.trades}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function StatsPage() {
  const dark = useIsDark();
  const { settings } = useAuth();
  const [filters, setFilters] = useState<TradeFilters>(DEFAULT_FILTERS);
  const [stats, setStats] = useState<Stats | null>(null);
  const [seasons, setSeasons] = useState<number[]>([]);
  useEffect(() => {
    setStats(null);
    api('/stats', { query: filterQuery(filters) })
      .then((r) => {
        setStats(r.stats);
        setSeasons(r.seasons.map((s: { season: number }) => s.season));
      })
      .catch(() => {});
  }, [filters]);

  return (
    <div className="page">
      <div className="page-header"><h1>Stats</h1></div>
      <FilterBar value={filters} onChange={setFilters} seasons={seasons} show={['mode', 'season', 'instrument', 'setupTag', 'dates']} />
      {!stats ? (
        <div className="skeleton" style={{ height: 300 }} />
      ) : stats.trades === 0 ? (
        <div className="card">
          <Empty icon="📈" title="Your stats start with your first closed trade">
            Win rate, expectancy, drawdown and your top habits to fix appear here. Ten trades give you a first picture; fifty start to tell the truth.
          </Empty>
          <div className="center"><Link className="btn primary" to="/">Make a practice trade</Link></div>
        </div>
      ) : (
        <>
          <div className="grid two md-four">
            <div className="stat"><span className="label">Total P&amp;L</span><span className={`value ${signClass(stats.totalPnl)}`}>{points(stats.totalPnl, { sign: true })}</span></div>
            <div className="stat"><span className="label">Return</span><span className={`value ${signClass(stats.returnPct)}`}>{pct(stats.returnPct, { sign: true })}</span></div>
            <div className="stat"><span className="label"><Term k="winrate">Win rate</Term></span><span className="value">{stats.winRate.toFixed(0)}% <span className="tiny muted">({stats.wins}/{stats.trades})</span></span></div>
            <div className="stat"><span className="label"><Term k="expectancy">Expectancy</Term></span><span className={`value ${signClass(stats.expectancy)}`}>{points(stats.expectancy, { sign: true })}</span></div>
            <div className="stat"><span className="label">Average win</span><span className="value profit">{points(stats.avgWin, { sign: true })}</span></div>
            <div className="stat"><span className="label">Average loss</span><span className="value loss">{points(stats.avgLoss, { sign: true })}</span></div>
            <div className="stat"><span className="label"><Term k="profitfactor">Profit factor</Term></span><span className="value">{stats.profitFactor !== null ? stats.profitFactor.toFixed(2) : '∞'}</span></div>
            <div className="stat"><span className="label">Average <Term k="rmultiple">R</Term></span><span className={`value ${signClass(stats.avgR)}`}>{rMult(stats.avgR)}</span></div>
            <div className="stat"><span className="label">Max <Term k="drawdown">drawdown</Term></span><span className="value loss">{points(-stats.maxDrawdown)} <span className="tiny muted">({pct(stats.maxDrawdownPct)})</span></span></div>
            <div className="stat"><span className="label">Longest streaks</span><span className="value">{stats.longestWinStreak}W · {stats.longestLossStreak}L</span></div>
            <div className="stat"><span className="label">Avg holding time</span><span className="value">{duration(stats.avgHoldingSeconds)}</span></div>
            <div className="stat"><span className="label">Trades</span><span className="value">{stats.trades}</span></div>
          </div>

          <div className="grid md-two" style={{ marginTop: 12 }}>
            <div>
              <div className="card">
                <h2>Equity curve</h2>
                <EquityChart curve={stats.equityCurve} dark={dark} />
              </div>
              <div className="card">
                <h2>Top 3 habits to fix</h2>
                <p className="small muted">From your last 20 trades.</p>
                {stats.topHabits.length === 0 ? (
                  <p className="small profit">✓ No repeated bad habits in your recent trades. Great discipline.</p>
                ) : (
                  stats.topHabits.map((h, i) => (
                    <div className="habit" key={h.code}>
                      <span className="n">{i + 1}</span>
                      <div>
                        <div className="bold">{h.title} <span className="tiny muted">· {h.count} of last {Math.min(20, stats.trades)} trades</span></div>
                        <div className="small muted">{h.advice}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="card">
                <h2>Calendar</h2>
                <Calendar days={stats.calendar} />
              </div>
            </div>
            <div>
              <div className="card">
                <h2>By setup</h2>
                <Bars groups={stats.byTag} label={(k) => k} />
              </div>
              <div className="card">
                <h2>Long vs short</h2>
                <Bars groups={stats.byDirection} label={(k) => (k === 'LONG' ? 'Long' : 'Short')} />
              </div>
              <div className="card">
                <h2>Time of day (IST)</h2>
                <Bars groups={stats.byTimeOfDay} label={(k) => k} />
              </div>
              <div className="card">
                <h2>By confidence</h2>
                <Bars groups={stats.byConfidence} label={(k) => (k === '-' ? 'Not set' : `${k} / 5`)} />
                <p className="tiny faint">Do your high-confidence trades actually do better?</p>
              </div>
            </div>
          </div>
        </>
      )}
      {settings?.leaderboardEnabled && <Leaderboard />}
    </div>
  );
}
