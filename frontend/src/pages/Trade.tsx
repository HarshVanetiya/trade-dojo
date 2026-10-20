import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PriceChart, type Drawing, type LineKind, type StaticLine } from '../components/Chart';
import { SourceNote } from '../components/Common';
import { Term } from '../components/Glossary';
import { draftEntry, marketRef, newDraft, OrderTicket, type Draft } from '../components/OrderTicket';
import { Sheet } from '../components/Sheet';
import { DepthPanel, DrawPanel, IndicatorsPanel, InstrumentTabs, MarketBadge, MarketBanner, StatsPanel, type MarketStats } from '../components/TradeWidgets';
import { api } from '../lib/api';
import { grams, points, price, signClass, toRupeeInput } from '../lib/format';
import { useDesktop, useStored } from '../lib/hooks';
import { DEFAULT_INDICATORS, type IndicatorConfig } from '../lib/indicators';
import { pnl } from '../lib/risk';
import type { Candle, Depth, Instrument, MarketStatus, Mode, Position, Quote } from '../lib/types';
import { INTERVALS, useLiveCandles, type Interval } from '../lib/useCandles';
import { useAuth, useIsDark, useMode, useToast, useTradingRefresh } from '../state/app';
import { useDepth, useInstrument, useInstruments, useMarketStatus, useQuote } from '../state/marketStore';
import { ReplayPage } from './Replay';
import { ModeSwitch } from '../components/ModeSwitch';

export interface TradeFeed {
  mode: Mode;
  inst: Instrument | null;
  quote: Quote | null;
  depth: Depth | null;
  status: MarketStatus | null;
  candles: Candle[];
  liveBar: Candle | null;
  loading: boolean;
  error: string | null;
  canTrade: { ok: boolean; reason?: string };
  equity: number;
  free: number;
  replaySessionId?: number | null;
  stats: MarketStats | null;
  /** Time used for the "updated" note (live tick time or replay clock). */
  updatedAt: number | null;
}

interface ViewProps {
  feed: TradeFeed;
  code: string;
  setCode: (c: string) => void;
  interval: Interval;
  setInterval: (i: Interval) => void;
  intervals?: Interval[];
  header?: ReactNode;
  controls?: ReactNode;
  quotesOverride?: Record<string, Quote | null>;
  onReplay?: () => void;
}

const GUIDE_STEPS = [
  { title: 'Read the price', body: 'The big number is the last traded price. Green/red shows the change since yesterday. Tap “Stats” under the chart for the day’s range.' },
  { title: 'Open the order ticket', body: 'Tap BUY if you think the price will rise, SELL if you think it will fall.' },
  { title: 'Set stop-loss and target', body: 'Drag the Stop and Target lines on the chart (or type prices). Keep “% of account” at 2% or less.' },
  { title: 'Write your plan and place it', body: 'Pick a setup tag, write one line about why, set your confidence, then place the order. You’ll get a review when it closes.' },
];

function GuideCard({ step, onClose }: { step: number; onClose: () => void }) {
  if (step >= GUIDE_STEPS.length) {
    return (
      <div className="banner info">
        <div className="grow">
          <b>Nice! Your first trade is on.</b> Watch it in Positions. When it closes, open the review to see what went well.
        </div>
        <button className="btn small" onClick={onClose}>Done</button>
      </div>
    );
  }
  const s = GUIDE_STEPS[step];
  return (
    <div className="banner info guide">
      <div className="grow">
        <div className="tiny muted">Guided first trade · step {step + 1} of {GUIDE_STEPS.length}</div>
        <b>{s.title}.</b> {s.body}
      </div>
      <button className="btn small ghost" onClick={onClose}>Skip</button>
    </div>
  );
}

function usePositions(mode: Mode, sessionId?: number | null) {
  const [positions, setPositions] = useState<Position[]>([]);
  const load = useCallback(() => {
    if (mode === 'replay' && !sessionId) return setPositions([]);
    api<{ positions: Position[] }>('/positions', { query: { mode, sessionId: sessionId ?? undefined } })
      .then((r) => setPositions(r.positions))
      .catch(() => {});
  }, [mode, sessionId]);
  useEffect(() => {
    load();
  }, [load]);
  useTradingRefresh(load);
  return { positions, reload: load };
}

function useDrawings(code: string) {
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const toast = useToast();
  useEffect(() => {
    api<{ drawings: Drawing[] }>('/drawings', { query: { instrument: code } })
      .then((r) => setDrawings(r.drawings))
      .catch(() => setDrawings([]));
  }, [code]);
  const add = async (d: Omit<Drawing, 'id'>) => {
    try {
      const r = await api<{ drawing: Drawing }>('/drawings', { body: { instrument: code, ...d } });
      setDrawings((xs) => [...xs, r.drawing]);
    } catch (e) {
      toast({ title: 'Could not save drawing', body: (e as Error).message, kind: 'error' });
    }
  };
  const remove = async (id: number) => {
    await api(`/drawings/${id}`, { method: 'DELETE' }).catch(() => {});
    setDrawings((xs) => xs.filter((d) => d.id !== id));
  };
  return { drawings, add, remove };
}

/** Trade screen body shared by live and replay modes. */
export function TradeView({ feed, code, setCode, interval, setInterval, intervals = INTERVALS, header, controls, quotesOverride, onReplay }: ViewProps) {
  const { settings } = useAuth();
  const dark = useIsDark();
  const desktop = useDesktop();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'depth' | 'stats' | 'indicators' | 'draw'>('stats');
  const [indicators, setIndicators] = useStored<IndicatorConfig>('td-indicators', DEFAULT_INDICATORS);
  const [drawMode, setDrawMode] = useState<'none' | 'hline' | 'trend'>('none');
  const [ticketOpen, setTicketOpen] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [guideStep, setGuideStep] = useState<number | null>(params.get('guide') === '1' ? 0 : null);
  const { positions } = usePositions(feed.mode, feed.replaySessionId);
  const { drawings, add, remove } = useDrawings(code);
  const inst = feed.inst;
  const quote = feed.quote;

  // Reset the draft when switching instrument or mode.
  useEffect(() => {
    setDraft(null);
    setTicketOpen(false);
  }, [code, feed.mode]);

  const openTicket = (direction: 'LONG' | 'SHORT') => {
    if (!inst) return;
    const ref = marketRef(direction, quote, inst);
    setDraft((d) => (d && d.direction === direction ? d : newDraft(inst, direction, ref)));
    setTicketOpen(true);
    if (guideStep === 1) setGuideStep(2);
  };

  // On desktop the ticket is always visible.
  useEffect(() => {
    if (desktop && inst && !draft) setDraft(newDraft(inst, 'LONG', marketRef('LONG', quote, inst)));
  }, [desktop, inst, quote, draft]);

  useEffect(() => {
    if (guideStep === 0) {
      const t = setTimeout(() => setGuideStep((s) => (s === 0 ? 1 : s)), 6000);
      return () => clearTimeout(t);
    }
  }, [guideStep]);

  const entry = draft && inst ? draftEntry(draft, quote, inst) : null;
  const orderLines = draft
    ? {
        entry: draft.orderType === 'MARKET' ? null : entry,
        sl: draft.sl ? Number(draft.sl.replace(/,/g, '')) * 100 || null : null,
        tp: draft.tp ? Number(draft.tp.replace(/,/g, '')) * 100 || null : null,
        draggable: ['entry', 'sl', 'tp'] as LineKind[],
      }
    : undefined;
  const onDragLine = (kind: LineKind, raw: number) => {
    if (!draft || !inst) return;
    const tick = inst.tickSizePaise || 100;
    const v = toRupeeInput(Math.round(raw / tick) * tick);
    if (kind === 'sl') setDraft({ ...draft, sl: v });
    if (kind === 'tp') setDraft({ ...draft, tp: v });
    if (kind === 'entry') setDraft({ ...draft, trigger: v });
    if (guideStep === 2) setGuideStep(3);
  };

  const myPositions = positions.filter((p) => p.instrument === code);
  const staticLines = useMemo<StaticLine[]>(() => {
    const out: StaticLine[] = [];
    for (const p of myPositions) {
      out.push({ price: p.avgEntry, title: `${p.direction === 'LONG' ? 'Long' : 'Short'} ${grams(p.qtyOpen)}`, color: '#64748b', style: 'dashed' });
      if (p.slPrice) out.push({ price: p.slPrice, title: 'SL', color: '#ef4444', style: 'dotted' });
      if (p.tpPrice) out.push({ price: p.tpPrice, title: 'TP', color: '#22c55e', style: 'dotted' });
    }
    if (indicators.levels.on && feed.stats) {
      const s = feed.stats;
      if (s.prevDay) {
        out.push({ price: s.prevDay.high, title: 'PDH', color: '#94a3b8', style: 'dotted' });
        out.push({ price: s.prevDay.low, title: 'PDL', color: '#94a3b8', style: 'dotted' });
        out.push({ price: s.prevDay.close, title: 'PDC', color: '#94a3b8', style: 'dotted' });
      }
      if (s.pivots) {
        for (const [k, v] of Object.entries(s.pivots)) out.push({ price: v, title: k.toUpperCase(), color: k === 'p' ? '#a855f7' : k.startsWith('r') ? '#f97316' : '#0ea5e9', style: 'dotted' });
      }
    }
    return out;
  }, [myPositions, indicators.levels.on, feed.stats]);

  const unrealized = (p: Position) => {
    if (!quote || !inst || p.instrument !== code) return p.unrealizedPnl;
    const mark = p.direction === 'LONG' ? quote.bid ?? quote.ltp - Math.floor(inst.spreadPaise / 2) : quote.ask ?? quote.ltp + Math.ceil(inst.spreadPaise / 2);
    return pnl(p.direction, p.qtyOpen, p.avgEntry, mark, p.unitGrams);
  };

  const ticket = inst && draft && (
    <OrderTicket
      inst={inst}
      quote={quote}
      equity={feed.equity}
      free={feed.free}
      riskWarnPct={settings?.riskWarnPct ?? 2}
      mode={feed.mode}
      replaySessionId={feed.replaySessionId}
      draft={draft}
      setDraft={(d) => {
        setDraft(d);
        if (guideStep === 2 && (d.sl || d.tp)) setGuideStep(3);
      }}
      canTrade={feed.canTrade}
      onPlaced={() => {
        setTicketOpen(false);
        setDraft(desktop ? newDraft(inst, draft.direction, marketRef(draft.direction, quote, inst)) : null);
        if (guideStep !== null) {
          setGuideStep(GUIDE_STEPS.length);
          params.delete('guide');
          setParams(params, { replace: true });
        }
      }}
      onCancel={desktop ? undefined : () => setTicketOpen(false)}
      onSetOnChart={
        desktop
          ? undefined
          : () => {
              setTicketOpen(false);
              setAdjusting(true);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }
      }
    />
  );

  const chartHeight = desktop ? 520 : 360;
  return (
    <div className={`page with-tradebar trade-page ${feed.mode} ${controls && !desktop ? 'with-dock' : ''}`}>
      {header}
      <div className="trade-top">
        <InstrumentTabs value={code} onChange={setCode} quotes={quotesOverride} />
      </div>
      {guideStep !== null && <GuideCard step={guideStep} onClose={() => { setGuideStep(null); params.delete('guide'); setParams(params, { replace: true }); }} />}
      {feed.mode === 'live' && <MarketBanner status={feed.status} onReplay={() => onReplay?.()} />}

      <div className="trade-grid">
        <section className="trade-main">
          <div className="quote-head">
            <div>
              <div className="row">
                <span className="big-price num">{quote ? price(quote.ltp) : '—'}</span>
                {feed.mode === 'live' ? <MarketBadge status={feed.status} /> : <span className="badge replay">REPLAY</span>}
              </div>
              <div className={`small num ${signClass(quote?.change)}`}>
                {quote?.change !== null && quote?.change !== undefined ? `${quote.change > 0 ? '+' : quote.change < 0 ? '−' : ''}${price(Math.abs(quote.change))} (${quote.changePct !== null ? `${quote.changePct > 0 ? '+' : ''}${quote.changePct.toFixed(2)}%` : ''})` : ''}
                <span className="muted"> {inst?.priceUnitLabel}</span>
              </div>
            </div>
            <div className="right small muted">
              {inst?.contract && (
                <div title="Active MCX futures contract" className="contract-note">
                  <Term k="contract">{inst.contract.symbol}</Term>
                  <div className="tiny">{inst.contract.daysToExpiry}d to expiry</div>
                </div>
              )}
            </div>
          </div>
          <div className="row between" style={{ margin: '8px 0' }}>
            <div className="chips" role="radiogroup" aria-label="Timeframe">
              {intervals.map((i) => (
                <button key={i} className={`chip ${interval === i ? 'active' : ''}`} onClick={() => setInterval(i)}>
                  {i === '1d' ? '1D' : i}
                </button>
              ))}
            </div>
          </div>
          {feed.loading ? (
            <div className="skeleton" style={{ height: chartHeight }} />
          ) : feed.error ? (
            <div className="banner danger">{feed.error}</div>
          ) : feed.candles.length === 0 && !feed.liveBar ? (
            <div className="card empty" style={{ height: chartHeight }}>
              <h3>No price history yet</h3>
              <p className="small">History is downloaded in the background on first run. Try another timeframe or check back in a minute.</p>
            </div>
          ) : (
            <PriceChart
              candles={feed.candles}
              liveBar={feed.liveBar}
              indicators={indicators}
              dark={dark}
              orderLines={orderLines}
              onDragLine={onDragLine}
              staticLines={staticLines}
              drawings={drawings}
              drawMode={drawMode}
              onDraw={(d) => void add(d)}
              height={chartHeight}
            />
          )}
          <div className="row between" style={{ marginTop: 4 }}>
            <SourceNote ts={feed.updatedAt} provider={feed.status?.provider} />
          </div>
          {desktop && controls}

          <div className="tabs" role="tablist">
            {(['depth', 'stats', 'indicators', 'draw'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                {t === 'depth' ? 'Depth' : t === 'stats' ? 'Stats' : t === 'indicators' ? 'Indicators' : 'Draw'}
              </button>
            ))}
          </div>
          <div className="card flat tab-body">
            {tab === 'depth' && (feed.mode === 'live' ? <DepthPanel depth={feed.depth} quote={quote} /> : <p className="small muted">Replay uses candle prices with the configured spread: buy at close + half spread, sell at close − half spread. There is no order book in replay.</p>)}
            {tab === 'stats' && <StatsPanel stats={feed.stats} quote={quote} inst={inst} />}
            {tab === 'indicators' && <IndicatorsPanel config={indicators} onChange={setIndicators} />}
            {tab === 'draw' && <DrawPanel mode={drawMode} setMode={setDrawMode} drawings={drawings} onDelete={(id) => void remove(id)} />}
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-title">
              <h3>Open {feed.mode === 'replay' ? 'replay ' : ''}positions</h3>
              <a className="small" href="/positions">Manage →</a>
            </div>
            {positions.length === 0 ? (
              <p className="small muted">No open positions. Tap Buy or Sell to practise a trade with a stop-loss and target.</p>
            ) : (
              <ul className="plain-list">
                {positions.map((p) => {
                  const u = unrealized(p);
                  return (
                    <li key={p.id} className="row between pos-mini">
                      <span>
                        <span className={`badge ${p.direction === 'LONG' ? 'long' : 'short'}`}>{p.direction === 'LONG' ? 'Long' : 'Short'}</span>{' '}
                        <b>{p.instrumentName}</b> <span className="small muted num">{grams(p.qtyOpen)} @ {price(p.avgEntry)}</span>
                      </span>
                      <span className={`num bold ${signClass(u)}`}>{points(u, { sign: true })}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {desktop && (
          <aside className="trade-side">
            <div className="card">
              <div className="card-title">
                <h2>Order ticket</h2>
                <span className="small muted">Free {points(feed.free)}</span>
              </div>
              {ticket}
            </div>
            {feed.mode === 'live' && (
              <div className="card">
                <h3>Market depth</h3>
                <DepthPanel depth={feed.depth} quote={quote} />
              </div>
            )}
          </aside>
        )}
      </div>

      {!desktop && adjusting && (
        <div className="trade-bar adjust-bar">
          <div className="small grow">Drag the <b className="loss">Stop</b> and <b className="profit">Target</b> lines on the chart.</div>
          <button className="btn primary" onClick={() => { setAdjusting(false); setTicketOpen(true); }}>Done</button>
        </div>
      )}
      {!desktop && !adjusting && (
        <div className={`trade-bar ${controls ? 'with-controls' : ''}`}>
          {controls && <div className="dock">{controls}</div>}
          <button className="btn sell grow big" onClick={() => openTicket('SHORT')} disabled={!inst}>
            <span>SELL</span>
            <span className="tiny num">{quote && inst ? price(marketRef('SHORT', quote, inst)) : ''}</span>
          </button>
          <button className="btn buy grow big" onClick={() => openTicket('LONG')} disabled={!inst}>
            <span>BUY</span>
            <span className="tiny num">{quote && inst ? price(marketRef('LONG', quote, inst)) : ''}</span>
          </button>
        </div>
      )}
      {!desktop && (
        <Sheet open={ticketOpen} onClose={() => setTicketOpen(false)} title={`${draft?.direction === 'SHORT' ? 'Sell' : 'Buy'} ${inst?.name ?? ''}${feed.mode === 'replay' ? ' (replay)' : ''}`}>
          {ticket}
        </Sheet>
      )}
    </div>
  );
}

export function useMarketStats(code: string, enabled: boolean) {
  const [stats, setStats] = useState<MarketStats | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setStats(null);
    const load = () =>
      api<{ stats: MarketStats }>('/market/stats', { query: { instrument: code } })
        .then((r) => alive && setStats(r.stats))
        .catch(() => {});
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code, enabled]);
  return stats;
}

function LiveTrade() {
  const nav = useNavigate();
  const { setMode } = useMode();
  const { account } = useAuth();
  const instruments = useInstruments();
  const [code, setCode] = useStored<string>('td-instrument', 'GOLD');
  const [interval, setIntervalState] = useStored<Interval>('td-interval', '5m');
  const inst = useInstrument(code);
  const quote = useQuote(code);
  const depth = useDepth(code);
  const status = useMarketStatus(code);
  const stats = useMarketStats(code, true);
  const { candles, liveBar, loading, error } = useLiveCandles(code, interval, quote);

  useEffect(() => {
    if (instruments.length && !instruments.some((i) => i.code === code)) setCode(instruments[0].code);
  }, [instruments, code, setCode]);

  const canTrade = (() => {
    if (!status) return { ok: false, reason: 'Loading market status…' };
    if (!status.liveAvailable) return { ok: false, reason: 'Live prices are unavailable. Practise in Replay.' };
    if (!status.open) return { ok: false, reason: 'Market is closed. Practise in Replay meanwhile.' };
    if (status.stale) return { ok: false, reason: 'Prices are delayed. New live orders are paused.' };
    if (!quote) return { ok: false, reason: 'Waiting for the first live price.' };
    return { ok: true };
  })();

  const feed: TradeFeed = {
    mode: 'live',
    inst,
    quote,
    depth,
    status,
    candles,
    liveBar,
    loading,
    error,
    canTrade,
    equity: account?.equity ?? 0,
    free: account?.pointsFree ?? 0,
    stats,
    updatedAt: quote?.ts ?? null,
  };
  return (
    <TradeView
      feed={feed}
      code={code}
      setCode={setCode}
      interval={interval}
      setInterval={setIntervalState}
      onReplay={() => {
        setMode('replay');
        nav('/');
      }}
      header={<ModeSwitch />}
    />
  );
}

export function TradePage() {
  const { mode } = useMode();
  return mode === 'replay' ? <ReplayPage /> : <LiveTrade />;
}
