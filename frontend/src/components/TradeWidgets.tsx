import { useEffect, useState } from 'react';
import { countdown, pct, price, rupees, signClass, timeAgo } from '../lib/format';
import type { IndicatorConfig } from '../lib/indicators';
import type { Depth, Instrument, MarketStatus, Quote } from '../lib/types';
import { useMarket } from '../state/marketStore';
import { Term } from './Glossary';
import type { Drawing } from './Chart';

export function InstrumentTabs({ value, onChange, quotes }: { value: string; onChange: (code: string) => void; quotes?: Record<string, Quote | null> }) {
  const instruments = useMarket((s) => s.instruments);
  const live = useMarket((s) => s.quotes);
  const q = quotes ?? live;
  return (
    <div className="inst-tabs" role="tablist" aria-label="Instrument">
      {instruments.map((i) => {
        const quote = q[i.code];
        return (
          <button key={i.code} role="tab" aria-selected={value === i.code} className={`inst-tab ${value === i.code ? 'active' : ''}`} onClick={() => onChange(i.code)}>
            <span className={`inst-dot ${i.underlying.toLowerCase()}`} aria-hidden="true" />
            <span className="inst-name">{i.name}</span>
            <span className="inst-price num">{quote ? price(quote.ltp) : '—'}</span>
            <span className={`inst-chg num ${signClass(quote?.change)}`}>{quote?.changePct !== null && quote?.changePct !== undefined ? pct(quote.changePct, { sign: true }) : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

export function MarketBadge({ status }: { status: MarketStatus | null }) {
  if (!status) return <span className="badge">…</span>;
  if (!status.liveAvailable) return <span className="badge closed"><span className="dot" />Prices unavailable</span>;
  if (status.open && status.stale) return <span className="badge warn"><span className="dot" />Delayed</span>;
  if (status.open) return <span className="badge open"><span className="dot" />{status.alwaysOpen ? 'Simulated' : 'Open'}</span>;
  return <span className="badge closed"><span className="dot" />Closed</span>;
}

/** Banners for closed market, delayed prices and unavailable feed, with a countdown to the open. */
export function MarketBanner({ status, onReplay }: { status: MarketStatus | null; onReplay: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!status) return null;
  if (!status.liveAvailable) {
    return (
      <div className="banner danger">
        <div className="grow">
          <b>Live prices unavailable.</b> The market data connection is down. Replay still works with stored history.
        </div>
        <button className="btn small" onClick={onReplay}>Practise in Replay</button>
      </div>
    );
  }
  if (!status.open) {
    const opens = status.opensAt ? new Date(status.opensAt) : null;
    return (
      <div className="banner warn">
        <div className="grow">
          <b>Market closed{status.holiday ? ` (${status.holiday})` : ''}.</b>{' '}
          {opens ? <>Opens {opens.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit' })} IST · in {countdown(opens.getTime() - Date.now())}.</> : null} Pending orders stay pending.
        </div>
        <button className="btn small" onClick={onReplay}>Practise in Replay</button>
      </div>
    );
  }
  if (status.stale) {
    return (
      <div className="banner warn">
        <div><b>Prices delayed.</b> No update since {timeAgo(status.lastTickAt)}. New live orders are paused until prices resume.</div>
      </div>
    );
  }
  return null;
}

export function DepthPanel({ depth, quote }: { depth: Depth | null; quote: Quote | null }) {
  if (!depth || (!depth.bids.length && !depth.asks.length)) {
    return <p className="muted small">No order book yet. <Term k="depth">Market depth</Term> appears while the market is open.</p>;
  }
  const maxQty = Math.max(1, ...depth.bids.map((b) => b.qty), ...depth.asks.map((a) => a.qty));
  return (
    <div>
      <div className="depth">
        <div className="depth-head tiny muted"><span>Qty</span><span>Bid</span><span>Ask</span><span>Qty</span></div>
        {Array.from({ length: 5 }).map((_, i) => {
          const b = depth.bids[i];
          const a = depth.asks[i];
          return (
            <div className="depth-row num" key={i}>
              <span className="depth-bar bid" style={{ width: `${b ? (b.qty / maxQty) * 50 : 0}%` }} />
              <span className="depth-bar ask" style={{ width: `${a ? (a.qty / maxQty) * 50 : 0}%` }} />
              <span>{b?.qty ?? ''}</span>
              <span className="profit">{b ? price(b.price) : ''}</span>
              <span className="loss">{a ? price(a.price) : ''}</span>
              <span>{a?.qty ?? ''}</span>
            </div>
          );
        })}
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>
        <Term k="spread">Spread</Term>: <b className="num">{rupees(depth.spread ?? (quote?.ask && quote?.bid ? quote.ask - quote.bid : null))}</b> · Buy at the <Term k="bidask">ask</Term>, sell at the bid.
      </p>
    </div>
  );
}

export interface MarketStats {
  ltp: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  oi: number | null;
  oiChange: number | null;
  week52High: number | null;
  week52Low: number | null;
  atr14: number | null;
  prevDay: { high: number; low: number; close: number } | null;
  pivots: Record<string, number> | null;
  contract: { symbol: string; expiry: string; daysToExpiry: number } | null;
}

export function StatsPanel({ stats, quote, inst }: { stats: MarketStats | null; quote: Quote | null; inst: Instrument | null }) {
  if (!stats) return <div className="skeleton" style={{ height: 120 }} />;
  const ltp = quote?.ltp ?? stats.ltp;
  const change = quote?.change ?? stats.change;
  const changePct = quote?.changePct ?? stats.changePct;
  const atrPct = stats.atr14 && ltp ? (stats.atr14 / ltp) * 100 : null;
  return (
    <dl className="kv">
      <dt>Last price</dt><dd><b>{rupees(ltp)}</b> <span className="tiny muted">{inst?.priceUnitLabel}</span></dd>
      <dt>Change vs prev. close</dt><dd className={signClass(change)}>{rupees(change, { sign: true })} ({pct(changePct, { sign: true })})</dd>
      <dt>Day open / high / low</dt><dd>{price(quote?.dayOpen ?? stats.dayOpen)} / {price(quote?.dayHigh ?? stats.dayHigh)} / {price(quote?.dayLow ?? stats.dayLow)}</dd>
      <dt><Term k="volume">Volume</Term> today</dt><dd>{(quote?.volume ?? stats.volume)?.toLocaleString('en-IN') ?? '-'}</dd>
      <dt><Term k="oi">Open interest</Term></dt><dd>{(quote?.oi ?? stats.oi)?.toLocaleString('en-IN') ?? '-'} {stats.oiChange !== null && <span className={`tiny ${signClass(stats.oiChange)}`}>({stats.oiChange > 0 ? '+' : ''}{stats.oiChange.toLocaleString('en-IN')})</span>}</dd>
      <dt>52-week high / low</dt><dd>{price(stats.week52High)} / {price(stats.week52Low)}</dd>
      <dt>Typical daily move (<Term k="atr">ATR</Term> 14)</dt><dd>{rupees(stats.atr14)} {atrPct !== null && <span className="tiny muted">({atrPct.toFixed(2)}%)</span>}</dd>
      <dt>Prev. day H / L / C</dt><dd>{stats.prevDay ? `${price(stats.prevDay.high)} / ${price(stats.prevDay.low)} / ${price(stats.prevDay.close)}` : '-'}</dd>
      <dt><Term k="pivots">Pivots</Term> P · R1 · S1</dt><dd>{stats.pivots ? `${price(stats.pivots.p)} · ${price(stats.pivots.r1)} · ${price(stats.pivots.s1)}` : '-'}</dd>
      <dt><Term k="contract">Contract</Term></dt><dd>{stats.contract ? `${stats.contract.symbol}` : '-'}</dd>
      <dt>Expiry</dt><dd>{stats.contract ? `${stats.contract.expiry} (${stats.contract.daysToExpiry} days)` : '-'}</dd>
    </dl>
  );
}

type Toggle = { key: keyof IndicatorConfig; label: string; term?: string; params?: Array<{ name: string; field: string; min: number; max: number }> };
const TOGGLES: Toggle[] = [
  { key: 'ema', label: 'EMA', term: 'ema', params: [{ name: 'Period', field: 'period', min: 2, max: 200 }] },
  { key: 'sma', label: 'SMA', term: 'ema', params: [{ name: 'Period', field: 'period', min: 2, max: 200 }] },
  { key: 'vwap', label: 'VWAP (intraday)', term: 'vwap' },
  { key: 'bb', label: 'Bollinger Bands', term: 'bollinger', params: [{ name: 'Period', field: 'period', min: 5, max: 100 }, { name: 'Std dev', field: 'mult', min: 1, max: 4 }] },
  { key: 'rsi', label: 'RSI', term: 'rsi', params: [{ name: 'Period', field: 'period', min: 2, max: 50 }] },
  { key: 'macd', label: 'MACD', term: 'macd', params: [{ name: 'Fast', field: 'fast', min: 2, max: 50 }, { name: 'Slow', field: 'slow', min: 5, max: 100 }, { name: 'Signal', field: 'signal', min: 2, max: 50 }] },
  { key: 'atr', label: 'ATR', term: 'atr', params: [{ name: 'Period', field: 'period', min: 2, max: 50 }] },
  { key: 'volMa', label: 'Volume average', term: 'volume', params: [{ name: 'Period', field: 'period', min: 2, max: 100 }] },
  { key: 'oi', label: 'Open interest', term: 'oi' },
  { key: 'levels', label: 'Prev. day H/L/C + pivots', term: 'pivots' },
];

export function IndicatorsPanel({ config, onChange }: { config: IndicatorConfig; onChange: (c: IndicatorConfig) => void }) {
  return (
    <div className="ind-list">
      {TOGGLES.map((t) => {
        const cfg = config[t.key] as any;
        return (
          <div className="ind-row" key={t.key}>
            <label className="checkbox grow">
              <input type="checkbox" checked={cfg.on} onChange={(e) => onChange({ ...config, [t.key]: { ...cfg, on: e.target.checked } })} />
              <span>{t.term ? <Term k={t.term}>{t.label}</Term> : t.label}</span>
            </label>
            {cfg.on &&
              t.params?.map((p) => (
                <input
                  key={p.field}
                  className="ind-param"
                  aria-label={`${t.label} ${p.name}`}
                  title={p.name}
                  type="number"
                  inputMode="numeric"
                  min={p.min}
                  max={p.max}
                  value={cfg[p.field]}
                  onChange={(e) => {
                    const v = Math.max(p.min, Math.min(p.max, Number(e.target.value) || p.min));
                    onChange({ ...config, [t.key]: { ...cfg, [p.field]: v } });
                  }}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}

export function DrawPanel({ mode, setMode, drawings, onDelete }: { mode: 'none' | 'hline' | 'trend'; setMode: (m: 'none' | 'hline' | 'trend') => void; drawings: Drawing[]; onDelete: (id: number) => void }) {
  return (
    <div className="stack">
      <div className="chips">
        <button className={`chip ${mode === 'hline' ? 'active' : ''}`} onClick={() => setMode(mode === 'hline' ? 'none' : 'hline')}>Horizontal line</button>
        <button className={`chip ${mode === 'trend' ? 'active' : ''}`} onClick={() => setMode(mode === 'trend' ? 'none' : 'trend')}>Trend line</button>
        {mode !== 'none' && <button className="chip" onClick={() => setMode('none')}>Done</button>}
      </div>
      <p className="small muted">Mark support and resistance. Lines are saved for this instrument.</p>
      {drawings.length === 0 ? (
        <p className="small faint">No drawings yet.</p>
      ) : (
        <ul className="plain-list">
          {drawings.map((d) => (
            <li key={d.id} className="row between">
              <span className="small num">{d.kind === 'hline' ? `Line at ${price(d.data.price!)}` : `Trend ${price(d.data.p1!.price)} → ${price(d.data.p2!.price)}`}</span>
              <button className="btn small ghost danger" onClick={() => onDelete(d.id)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
