import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorText } from '../components/Common';
import { IconPause, IconPlay, IconStep } from '../components/Icons';
import { ModeSwitch } from '../components/ModeSwitch';
import { ConfirmSheet } from '../components/Sheet';
import type { MarketStats } from '../components/TradeWidgets';
import { api } from '../lib/api';
import { date, dateTime, points, signClass } from '../lib/format';
import { useStored } from '../lib/hooks';
import type { Account, Candle, MarketStatus, Quote } from '../lib/types';
import { bucketStart, INTERVALS, type Interval } from '../lib/useCandles';
import { socket } from '../lib/ws';
import { useMode, useToast } from '../state/app';
import { useInstrument, useInstruments } from '../state/marketStore';
import { TradeView, type TradeFeed } from './Trade';

type Step = '1m' | '5m' | '15m' | '1h' | '1d';
const STEPS: Step[] = ['1m', '5m', '15m', '1h', '1d'];
const SPEEDS = [1, 5, 20, 100];
const STEP_MS: Record<Step, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '1d': 86_400_000 };

interface Session {
  id: number;
  instrument: string;
  from: string;
  to: string;
  currentTs: number;
  step: Step;
  speed: number;
  status: 'paused' | 'playing' | 'ended';
  index: number;
  total: number;
  atEnd: boolean;
  quote: Quote | null;
}

function istDateStr(t: number) {
  return new Date(t + 330 * 60_000).toISOString().slice(0, 10);
}

function defaultRange(): { from: string; to: string } {
  // The most recent full weekday before today.
  let d = Date.now() - 86_400_000;
  for (let i = 0; i < 7; i++) {
    const wd = new Date(d + 330 * 60_000).getUTCDay();
    if (wd !== 0 && wd !== 6) break;
    d -= 86_400_000;
  }
  const s = istDateStr(d);
  return { from: s, to: s };
}

function SetupForm({ onStarted }: { onStarted: (s: Session) => void }) {
  const instruments = useInstruments();
  const toast = useToast();
  const [instrument, setInstrument] = useState('GOLD');
  const [{ from, to }, setRange] = useState(defaultRange);
  const [step, setStep] = useState<Step>('5m');
  const [speed, setSpeed] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [past, setPast] = useState<any[]>([]);
  const [acc, setAcc] = useState<Account | null>(null);
  useEffect(() => {
    api('/replay/sessions').then((r) => setPast(r.sessions)).catch(() => {});
    api('/account', { query: { mode: 'replay' } }).then((r) => setAcc(r.account)).catch(() => {});
  }, []);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ session: Session }>('/replay', { body: { instrument, from, to, step, speed } });
      toast({ title: 'Replay ready', body: 'Press play or step one candle at a time. Future candles stay hidden.' });
      onStarted(r.session);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid md-two">
      <div className="card stack">
        <h2>Start a replay</h2>
        <p className="small muted">Pick past dates and trade them candle by candle as if they were live, without seeing what comes next. Replay has its own balance, so it never touches your live account. Available 24/7.</p>
        <ErrorText error={error} />
        <label className="field">
          Instrument
          <select value={instrument} onChange={(e) => setInstrument(e.target.value)}>
            {instruments.map((i) => <option key={i.code} value={i.code}>{i.name} ({i.product})</option>)}
          </select>
        </label>
        <div className="grid two">
          <label className="field">From<input type="date" value={from} max={istDateStr(Date.now())} onChange={(e) => setRange({ from: e.target.value, to: e.target.value > to ? e.target.value : to })} /></label>
          <label className="field">To<input type="date" value={to} min={from} max={istDateStr(Date.now())} onChange={(e) => setRange({ from, to: e.target.value })} /></label>
        </div>
        <label className="field">
          Candle step
          <div className="chips">
            {STEPS.map((s) => <button key={s} type="button" className={`chip ${step === s ? 'active' : ''}`} onClick={() => setStep(s)}>{s === '1d' ? '1D' : s}</button>)}
          </div>
          <span className="tiny faint">Each step reveals one candle of this size. Intraday history starts Jan 2022; use 1D for older dates.</span>
        </label>
        <label className="field">
          Speed
          <div className="chips">
            {SPEEDS.map((s) => <button key={s} type="button" className={`chip ${speed === s ? 'active' : ''}`} onClick={() => setSpeed(s)}>{s}x</button>)}
          </div>
          <span className="tiny faint">1x = one candle per second. You can also step manually.</span>
        </label>
        <button className="btn primary block" disabled={busy} onClick={start}>{busy ? 'Loading history…' : 'Start replay'}</button>
      </div>
      <div>
        {acc && (
          <div className="card">
            <h3>Replay balance</h3>
            <div className="grid two">
              <div className="stat"><span className="label">Equity</span><span className="value">{points(acc.equity)}</span></div>
              <div className="stat"><span className="label">Season</span><span className="value">{acc.season}</span></div>
            </div>
            <p className="tiny faint" style={{ marginTop: 6 }}>Reset it any time from Account.</p>
          </div>
        )}
        <div className="card">
          <h3>Past replays</h3>
          {past.length === 0 ? <p className="small muted">None yet.</p> : (
            <ul className="plain-list small">
              {past.map((p) => (
                <li key={p.id} className="row between">
                  <span>{p.instrument} · {date(p.from)} → {date(new Date(new Date(p.to).getTime() - 1))} · {p.step}</span>
                  <span className="badge">{p.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function mergeBars(candles: Candle[], bars: Candle[], interval: Interval): Candle[] {
  let out = candles;
  for (const b of bars) {
    const start = bucketStart(b.openTime, interval);
    const last = out[out.length - 1];
    if (last && last.openTime === start) {
      out = [...out.slice(0, -1), { ...last, h: Math.max(last.h, b.h), l: Math.min(last.l, b.l), c: b.c, volume: last.volume + b.volume, oi: b.oi ?? last.oi }];
    } else if (!last || start > last.openTime) {
      out = [...out, { ...b, openTime: start, stitch: last && b.contract && last.contract !== b.contract ? true : undefined }];
    }
  }
  return out;
}

function ReplayControls({ s, onAction, onEnd }: { s: Session; onAction: (a: string, body?: unknown) => void; onEnd: () => void }) {
  const playing = s.status === 'playing';
  const progress = s.total ? (s.index / s.total) * 100 : 0;
  return (
    <div className="replay-controls" aria-label="Replay controls">
      <div className="rc-top">
        <span className="clock">{dateTime(s.currentTs)}</span>
        <span className="tiny muted">{s.index}/{s.total}</span>
        <div className="progress" aria-hidden="true"><div style={{ width: `${progress}%` }} /></div>
      </div>
      <div className="rc-row">
        <button className="btn icon-btn primary" onClick={() => onAction(playing ? 'pause' : 'play')} disabled={s.atEnd && !playing} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <button className="btn icon-btn" onClick={() => onAction('step', { count: 1 })} disabled={s.atEnd} aria-label="Step one candle">
          <IconStep />
        </button>
        <div className="speeds" role="radiogroup" aria-label="Speed">
          {SPEEDS.map((sp) => <button key={sp} className={`chip ${s.speed === sp ? 'active' : ''}`} onClick={() => onAction('speed', { speed: sp })}>{sp}x</button>)}
        </div>
        <button className="btn small" onClick={onEnd}>End</button>
      </div>
    </div>
  );
}

function ActiveReplay({ session, setSession, onEnded }: { session: Session; setSession: (s: Session) => void; onEnded: () => void }) {
  const toast = useToast();
  const inst = useInstrument(session.instrument);
  const [interval, setIntervalState] = useStored<Interval>('td-replay-interval', session.step === '1d' ? '1d' : session.step);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [acc, setAcc] = useState<Account | null>(null);
  const [stats, setStats] = useState<MarketStats | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const intervals = INTERVALS.filter((i) => STEP_MS[session.step] <= ({ '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 } as const)[i]);
  const effInterval = intervals.includes(interval) ? interval : intervals[0];
  const intervalRef = useRef(effInterval);
  intervalRef.current = effInterval;

  const loadCandles = useCallback(() => {
    api<{ candles: Candle[] }>(`/replay/${session.id}/candles`, { query: { interval: effInterval, limit: 500 } })
      .then((r) => setCandles(r.candles))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [session.id, effInterval]);
  useEffect(() => {
    setLoading(true);
    loadCandles();
  }, [loadCandles]);

  const loadSide = useCallback(() => {
    api('/account', { query: { mode: 'replay' } }).then((r) => setAcc(r.account)).catch(() => {});
    api(`/replay/${session.id}/market-stats`).then((r) => setStats(r.stats)).catch(() => {});
  }, [session.id]);
  useEffect(() => {
    loadSide();
    const onAcc = (e: Event) => {
      const a = (e as CustomEvent<Account>).detail;
      if (a.mode === 'replay') setAcc(a);
    };
    window.addEventListener('td-account', onAcc);
    return () => window.removeEventListener('td-account', onAcc);
  }, [loadSide]);

  // Stream of newly revealed candles (only ever sent to this user).
  const lastStatsAt = useRef(0);
  useEffect(() => {
    return socket.on('replay', (data: Session & { bars: Candle[] }) => {
      if (data.id !== session.id) return;
      const { bars, ...rest } = data;
      setSession(rest);
      if (bars?.length) setCandles((cs) => mergeBars(cs, bars, intervalRef.current));
      if (Date.now() - lastStatsAt.current > 4000) {
        lastStatsAt.current = Date.now();
        api(`/replay/${session.id}/market-stats`).then((r) => setStats(r.stats)).catch(() => {});
      }
    });
  }, [session.id, setSession]);

  const action = async (a: string, body?: unknown) => {
    try {
      const r = await api<{ session: Session }>(`/replay/${session.id}/${a}`, { method: 'POST', body: body ?? {} });
      setSession(r.session);
      if (a === 'step') loadCandles();
    } catch (e) {
      toast({ title: 'Replay', body: (e as Error).message, kind: 'warn' });
    }
  };

  const end = async () => {
    setEnding(true);
    try {
      const r = await api(`/replay/${session.id}/end`, { method: 'POST' });
      toast({ title: 'Replay finished', body: `${r.session.trades} trade(s), net ${points(r.session.netPnl, { sign: true })}. Reviews are in your journal (Replay).`, kind: r.session.netPnl >= 0 ? 'profit' : 'loss', action: { label: 'Open journal', href: '/journal' } });
      onEnded();
    } catch (e) {
      toast({ title: 'Could not end replay', body: (e as Error).message, kind: 'error' });
    } finally {
      setEnding(false);
      setConfirmEnd(false);
    }
  };

  const status: MarketStatus = { open: session.status !== 'ended', reason: 'open', opensAt: null, closesAt: null, stale: false, lastTickAt: null, liveAvailable: true, alwaysOpen: true, provider: 'replay' };
  const canTrade = session.status === 'ended' ? { ok: false, reason: 'This replay has ended.' } : !session.quote ? { ok: false, reason: 'Step forward once to get a price.' } : { ok: true };
  const feed: TradeFeed = {
    mode: 'replay',
    inst,
    quote: session.quote,
    depth: null,
    status,
    candles,
    liveBar: null,
    loading,
    error: null,
    canTrade,
    equity: acc?.equity ?? 0,
    free: acc?.pointsFree ?? 0,
    replaySessionId: session.id,
    stats,
    updatedAt: session.currentTs,
  };
  const quotes = useMemo(() => ({ [session.instrument]: session.quote }), [session.instrument, session.quote]);
  const header = (
    <>
      <ModeSwitch />
      <div className="banner replay" role="status">
        <span>REPLAY · {session.instrument} · {dateTime(session.currentTs)} IST</span>
        <span className="tiny">{session.index}/{session.total} candles{session.atEnd ? ' · end reached' : ''}</span>
      </div>
      {acc && (
        <p className="small muted" style={{ marginTop: -6 }}>
          Replay balance: <b className="num">{points(acc.equity)}</b>{' '}
          <span className={signClass(acc.equity - acc.startingPoints)}>({points(acc.equity - acc.startingPoints, { sign: true })})</span> · trades here don’t affect your live account.
        </p>
      )}
    </>
  );
  return (
    <>
      <TradeView
        feed={feed}
        code={session.instrument}
        setCode={(c) => c !== session.instrument && toast({ title: 'One instrument per replay', body: 'End this replay to practise another instrument.' })}
        interval={effInterval}
        setInterval={setIntervalState}
        intervals={intervals}
        header={header}
        quotesOverride={quotes}
        controls={<ReplayControls s={session} onAction={action} onEnd={() => setConfirmEnd(true)} />}
      />
      <ConfirmSheet
        open={confirmEnd}
        title="End this replay?"
        body={<p>Open replay positions close at the current replay price and pending replay orders are cancelled. Your reviews then get their full what-ifs.</p>}
        confirmLabel="End replay"
        busy={ending}
        onConfirm={end}
        onClose={() => setConfirmEnd(false)}
      />
    </>
  );
}

export function ReplayPage() {
  const { replaySessionId, setReplaySessionId } = useMode();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    api<{ session: Session | null }>('/replay/current')
      .then((r) => {
        setSession(r.session);
        setReplaySessionId(r.session?.id ?? null);
      })
      .catch(() => setSession(null));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  void replaySessionId;
  if (session === undefined) return <div className="page"><ModeSwitch /><div className="skeleton" style={{ height: 300 }} /></div>;
  if (!session) {
    return (
      <div className="page">
        <ModeSwitch />
        <SetupForm onStarted={(s) => { setSession(s); setReplaySessionId(s.id); }} />
      </div>
    );
  }
  return <ActiveReplay session={session} setSession={setSession} onEnded={() => { setSession(null); setReplaySessionId(null); }} />;
}
