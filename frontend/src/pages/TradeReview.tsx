import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PriceChart, type StaticLine } from '../components/Chart';
import { ErrorText } from '../components/Common';
import { Term } from '../components/Glossary';
import { api } from '../lib/api';
import { dateTime, duration, grams, pct, points, price, rMult, signClass } from '../lib/format';
import { DEFAULT_INDICATORS } from '../lib/indicators';
import { EXIT_REASONS, type Candle, type Trade } from '../lib/types';
import { useAuth, useIsDark, useToast } from '../state/app';

interface WhatIf {
  available: boolean;
  pnl: number | null;
  price: number | null;
  outcome?: string;
  note: string;
}

interface Detail {
  trade: Trade;
  review: {
    flags: Array<{ code: string; title: string; detail: string; kind: 'habit' | 'info' }>;
    mfePrice: number | null;
    maePrice: number | null;
    mfe: number | null;
    mae: number | null;
    whatIfs: Record<'heldToTarget' | 'heldOneHour' | 'heldOneDay' | 'noStop', WhatIf>;
    whatIfComplete: boolean;
    aiCoach: string | null;
    planVsOutcome: string;
  };
  fills: Array<{ side: string; qty: number; price: number; brokerage: number; realizedPnl: number; reason: string; gap: boolean; ts: string }>;
  events: Array<{ kind: string; oldValue: number | null; newValue: number | null; ts: string }>;
  chart: { interval: string; candles: Candle[] };
  aiCoachEnabled: boolean;
}

const WHATIF_LABELS: Record<string, string> = {
  heldToTarget: 'Held to your target',
  heldOneHour: 'Held 1 hour longer',
  heldOneDay: 'Held 1 day longer',
  noStop: 'Had no stop-loss',
};

const EVENT_LABELS: Record<string, string> = { sl_changed: 'Stop-loss changed', tp_changed: 'Target changed', trail_changed: 'Trailing stop changed' };

export function TradeReviewPage() {
  const { id } = useParams();
  const dark = useIsDark();
  const toast = useToast();
  const { settings } = useAuth();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reflection, setReflection] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [coachBusy, setCoachBusy] = useState(false);

  useEffect(() => {
    api<Detail>(`/trades/${id}`)
      .then((r) => {
        setD(r);
        setReflection(r.trade.reflection);
        setTags(r.trade.tags.join(', '));
      })
      .catch((e) => setError(e.message));
  }, [id]);

  const t = d?.trade;
  const lines = useMemo(() => {
    if (!t) return [];
    const out: StaticLine[] = [
      { price: t.entryPrice, title: 'Entry', color: '#3b82f6', style: 'solid' },
      { price: t.exitPrice, title: 'Exit', color: '#a855f7', style: 'solid' },
    ];
    if (t.initialSl) out.push({ price: t.initialSl, title: 'Planned stop', color: '#ef4444', style: 'dashed' as const });
    if (t.initialTp) out.push({ price: t.initialTp, title: 'Planned target', color: '#22c55e', style: 'dashed' as const });
    return out;
  }, [t]);
  const markers = useMemo(() => {
    if (!t) return [];
    const entryAt = new Date(t.entryTs).getTime();
    const exitAt = new Date(t.exitTs).getTime();
    const snap = (ts: number) => {
      const cs = d?.chart.candles ?? [];
      let best = cs[0]?.openTime ?? ts;
      for (const c of cs) if (c.openTime <= ts) best = c.openTime;
      return best;
    };
    const long = t.direction === 'LONG';
    return [
      { time: snap(entryAt), position: long ? ('belowBar' as const) : ('aboveBar' as const), color: '#3b82f6', shape: long ? ('arrowUp' as const) : ('arrowDown' as const), text: long ? 'Buy' : 'Sell' },
      { time: snap(exitAt), position: long ? ('aboveBar' as const) : ('belowBar' as const), color: '#a855f7', shape: long ? ('arrowDown' as const) : ('arrowUp' as const), text: 'Exit' },
    ];
  }, [t, d]);

  if (error) return <div className="page"><ErrorText error={error} /><Link to="/journal">Back to journal</Link></div>;
  if (!d || !t) return <div className="page"><div className="skeleton" style={{ height: 32, width: 200, marginBottom: 12 }} /><div className="skeleton" style={{ height: 300 }} /></div>;

  const save = async () => {
    setSaving(true);
    try {
      await api(`/trades/${t.id}/notes`, { method: 'PUT', body: { reflection, tags: tags.split(',').map((s) => s.trim()).filter(Boolean) } });
      toast({ title: 'Reflection saved' });
    } catch (e) {
      toast({ title: 'Could not save', body: (e as Error).message, kind: 'error' });
    } finally {
      setSaving(false);
    }
  };
  const askCoach = async () => {
    setCoachBusy(true);
    try {
      const r = await api(`/trades/${t.id}/ai-coach`, { method: 'POST' });
      setD({ ...d, review: { ...d.review, aiCoach: r.aiCoach } });
    } catch (e) {
      toast({ title: 'AI coach unavailable', body: (e as Error).message, kind: 'error' });
    } finally {
      setCoachBusy(false);
    }
  };

  const won = t.netPnl > 0;
  const habits = d.review.flags.filter((f) => f.kind === 'habit');
  const infos = d.review.flags.filter((f) => f.kind === 'info');
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <Link className="small" to="/journal">← Journal</Link>
          <h1>{t.instrumentName} {t.direction === 'LONG' ? 'long' : 'short'} · {grams(t.qty)}{t.mode === 'replay' ? ' (replay)' : ''}</h1>
          <div className="small muted">{dateTime(t.entryTs)} → {dateTime(t.exitTs)} · {t.contract}</div>
        </div>
      </div>

      <div className={`card review-hero ${won ? 'win' : 'loss'}`}>
        <div className="grid two md-four">
          <div className="stat"><span className="label">Result</span><span className={`value ${signClass(t.netPnl)}`}>{points(t.netPnl, { sign: true })}</span></div>
          <div className="stat"><span className="label">Return on points used</span><span className={`value ${signClass(t.netPnl)}`}>{pct(t.pnlPct, { sign: true })}</span></div>
          <div className="stat"><span className="label"><Term k="rmultiple">R-multiple</Term></span><span className={`value ${signClass(t.rMultiple)}`}>{t.rMultiple !== null ? rMult(t.rMultiple) : 'No stop'}</span></div>
          <div className="stat"><span className="label">Holding time</span><span className="value">{duration(t.holdingSeconds)}</span></div>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          Entry {price(t.entryPrice)} → exit {price(t.exitPrice)} ({EXIT_REASONS[t.exitReason] ?? t.exitReason}). Gross {points(t.grossPnl, { sign: true })}{t.brokerage ? `, brokerage ${points(-t.brokerage)}` : ''}.
          {t.riskPct !== null && ` Risked ${pct(t.riskPct)} of your account.`}
        </p>
      </div>

      <div className="grid md-two" style={{ marginTop: 12 }}>
        <div>
          <PriceChart candles={d.chart.candles} indicators={{ ...DEFAULT_INDICATORS, ema: { on: false, period: 21 }, volMa: { on: false, period: 20 } }} dark={dark} staticLines={lines} markers={markers} height={320} />
          <p className="tiny faint">{d.chart.interval} candles around the trade. Planned stop/target shown dashed.</p>

          <div className="card">
            <h2>Best and worst moments</h2>
            <dl className="kv">
              <dt><Term k="mfe">Max favourable (MFE)</Term></dt>
              <dd className="profit">{points(d.review.mfe, { sign: true })} <span className="tiny muted">at {price(d.review.mfePrice)}</span></dd>
              <dt>Max adverse (MAE)</dt>
              <dd className="loss">{points(d.review.mae, { sign: true })} <span className="tiny muted">at {price(d.review.maePrice)}</span></dd>
              <dt>Captured of the best move</dt>
              <dd>{d.review.mfe ? pct(Math.max(0, (t.grossPnl / d.review.mfe) * 100), { digits: 0 }) : '—'}</dd>
            </dl>
          </div>

          <div className="card">
            <div className="card-title">
              <h2>What if…</h2>
              {!d.review.whatIfComplete && <span className="badge">updating</span>}
            </div>
            {(Object.keys(WHATIF_LABELS) as Array<keyof typeof WHATIF_LABELS>).map((k) => {
              const w = d.review.whatIfs[k as keyof Detail['review']['whatIfs']];
              if (!w) return null;
              return (
                <div className="whatif" key={k}>
                  <div>
                    <div className="bold small">{WHATIF_LABELS[k]}</div>
                    <div className="tiny muted">{w.note}</div>
                  </div>
                  <div className={`num bold ${w.available ? signClass(w.pnl) : 'faint'}`}>{w.available ? points(w.pnl, { sign: true }) : '—'}</div>
                </div>
              );
            })}
            <p className="tiny faint">Gross P&amp;L before brokerage, using candle prices.</p>
          </div>
        </div>

        <div>
          <div className="card">
            <h2>Coaching</h2>
            {habits.length === 0 && <p className="small profit">✓ No bad habits spotted on this trade. Keep doing what you did.</p>}
            {habits.map((f) => (
              <div className="flag" key={f.code}>
                <div className="t">{f.title}</div>
                <div className="small">{f.detail}</div>
              </div>
            ))}
            {infos.map((f) => (
              <div className="flag info" key={f.code}>
                <div className="t">{f.title}</div>
                <div className="small">{f.detail}</div>
              </div>
            ))}
          </div>

          <div className="card">
            <h2>Your plan vs what happened</h2>
            <dl className="kv">
              <dt>Setup</dt><dd>{t.setupTag}</dd>
              <dt>Confidence</dt><dd>{t.confidence}/5</dd>
              <dt>Planned <Term k="rr">R:R</Term></dt><dd>{t.plannedRr !== null ? `1 : ${Number(t.plannedRr).toFixed(2)}` : '—'}</dd>
            </dl>
            {t.planNote && <blockquote className="plan-quote">“{t.planNote}”</blockquote>}
            <p className="small">{d.review.planVsOutcome}</p>
          </div>

          {(d.aiCoachEnabled || settings?.aiCoachEnabled) && (
            <div className="card">
              <h2>AI coach</h2>
              {d.review.aiCoach ? <p className="small">{d.review.aiCoach}</p> : <p className="small muted">Get a short coaching note. Only anonymized trade numbers are sent, never your name, email or notes.</p>}
              <button className="btn small" disabled={coachBusy} onClick={askCoach}>{coachBusy ? 'Thinking…' : d.review.aiCoach ? 'Ask again' : 'Ask the AI coach'}</button>
            </div>
          )}

          <div className="card stack">
            <h2>Reflection</h2>
            <label className="field">
              What did you learn? What will you do differently?
              <textarea value={reflection} maxLength={4000} onChange={(e) => setReflection(e.target.value)} placeholder="e.g. I moved my stop because I hoped it would come back. Next time I’ll leave it." />
            </label>
            <label className="field">
              Tags (comma separated)
              <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. fomo, followed-plan" />
            </label>
            <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save reflection'}</button>
          </div>

          <div className="card">
            <h2>Fills &amp; changes</h2>
            <ul className="plain-list small">
              {d.fills.map((f, i) => (
                <li key={`f${i}`} className="row between">
                  <span>{f.side} {grams(f.qty)} @ {price(f.price)} <span className="muted">· {EXIT_REASONS[f.reason] ?? (f.reason === 'entry' ? 'Entry' : f.reason)}{f.gap ? ' · gap' : ''}</span></span>
                  <span className="muted">{dateTime(f.ts)}</span>
                </li>
              ))}
              {d.events.map((e, i) => (
                <li key={`e${i}`} className="row between">
                  <span>{EVENT_LABELS[e.kind] ?? e.kind}: {price(e.oldValue)} → {e.newValue ? price(e.newValue) : 'none'}</span>
                  <span className="muted">{dateTime(e.ts)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
