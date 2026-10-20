import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { grams, parseRupees, pct, points, price, rupees, toRupeeInput } from '../lib/format';
import { riskSummary, suggestQty } from '../lib/risk';
import { SETUP_TAGS, type Direction, type Instrument, type Mode, type Quote } from '../lib/types';
import { useToast } from '../state/app';
import { Term } from './Glossary';

export interface Draft {
  direction: Direction;
  orderType: 'MARKET' | 'LIMIT' | 'STOP';
  qty: number;
  trigger: string;
  sl: string;
  tp: string;
  useTrail: boolean;
  trail: string;
  setupTag: string;
  planNote: string;
  confidence: number;
}

export function newDraft(inst: Instrument, direction: Direction, ref: number | null): Draft {
  // Starting suggestion: stop 0.4% away, target 0.8% away (R:R 1:2), rounded to the tick size.
  const tick = inst.tickSizePaise || 100;
  const round = (x: number) => Math.round(x / tick) * tick;
  const sl = ref ? round(ref * (direction === 'LONG' ? 0.996 : 1.004)) : null;
  const tp = ref ? round(ref * (direction === 'LONG' ? 1.008 : 0.992)) : null;
  return {
    direction,
    orderType: 'MARKET',
    qty: inst.qtyMin,
    trigger: '',
    sl: toRupeeInput(sl),
    tp: toRupeeInput(tp),
    useTrail: false,
    trail: '',
    setupTag: '',
    planNote: '',
    confidence: 3,
  };
}

/** Executable price for a market order in the given direction (ask to buy, bid to sell). */
export function marketRef(direction: Direction, quote: Quote | null, inst: Instrument): number | null {
  if (!quote) return null;
  const lo = Math.floor(inst.spreadPaise / 2);
  const hi = inst.spreadPaise - lo;
  if (direction === 'LONG') return quote.ask ?? quote.ltp + hi;
  return quote.bid ?? quote.ltp - lo;
}

export function draftEntry(d: Draft, quote: Quote | null, inst: Instrument): number | null {
  return d.orderType === 'MARKET' ? marketRef(d.direction, quote, inst) : parseRupees(d.trigger);
}

interface Props {
  inst: Instrument;
  quote: Quote | null;
  equity: number;
  free: number;
  riskWarnPct: number;
  mode: Mode;
  replaySessionId?: number | null;
  draft: Draft;
  setDraft: (d: Draft) => void;
  canTrade: { ok: boolean; reason?: string };
  onPlaced: () => void;
  onCancel?: () => void;
  /** Phones: hide the sheet so the user can drag the lines on the chart. */
  onSetOnChart?: () => void;
}

export function OrderTicket({ inst, quote, equity, free, riskWarnPct, mode, replaySessionId, draft, setDraft, canTrade, onPlaced, onCancel, onSetOnChart }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmWarnings, setConfirmWarnings] = useState(false);
  const [riskPctInput, setRiskPctInput] = useState('1');
  const [shortExplained, setShortExplained] = useState(() => localStorage.getItem('td-short-explained') === '1');
  const set = (patch: Partial<Draft>) => {
    setConfirmWarnings(false);
    setDraft({ ...draft, ...patch });
  };

  const entry = draftEntry(draft, quote, inst);
  const sl = parseRupees(draft.sl);
  const tp = parseRupees(draft.tp);
  const risk = useMemo(
    () => (entry ? riskSummary({ direction: draft.direction, qtyG: draft.qty, entry, sl, tp, unitGrams: inst.unitGrams, equity, riskWarnPct }) : null),
    [entry, sl, tp, draft.qty, draft.direction, inst.unitGrams, equity, riskWarnPct],
  );
  const needed = (risk?.notional ?? 0) + inst.brokeragePaise;
  const affordable = entry ? Math.floor(((free - inst.brokeragePaise) * inst.unitGrams) / entry) : 0;

  // Bracket sanity hints (the server validates too).
  const bracketError = (() => {
    if (!entry) return null;
    if (draft.direction === 'LONG') {
      if (sl && sl >= entry) return 'For a buy, the stop-loss must be below the entry price.';
      if (tp && tp <= entry) return 'For a buy, the target must be above the entry price.';
    } else {
      if (sl && sl <= entry) return 'For a sell, the stop-loss must be above the entry price.';
      if (tp && tp >= entry) return 'For a sell, the target must be below the entry price.';
    }
    return null;
  })();

  useEffect(() => setError(null), [draft]);

  const step = (dir: 1 | -1) => {
    const q = Math.max(inst.qtyMin, Math.min(inst.qtyMax, draft.qty + dir * inst.qtyStep));
    set({ qty: q });
  };

  const sizeHelper = () => {
    if (!entry || !sl) return;
    const q = suggestQty({ entry, sl, equity, riskPct: Number(riskPctInput) || 1, unitGrams: inst.unitGrams, step: inst.qtyStep, min: inst.qtyMin, maxAffordable: affordable });
    if (q > 0) set({ qty: q });
    else toast({ title: 'Stop too wide for that risk', body: `Even ${grams(inst.qtyMin)} would risk more than ${riskPctInput}% of your account.`, kind: 'warn' });
  };

  const submit = async () => {
    setError(null);
    if (!canTrade.ok) return setError(canTrade.reason ?? 'Trading is not available right now.');
    if (!draft.setupTag) return setError('Pick a setup tag for your trade plan.');
    if (draft.planNote.trim().length < 3) return setError('Write a short plan: why this trade, and what would prove you wrong?');
    if (draft.orderType !== 'MARKET' && !parseRupees(draft.trigger)) return setError('Enter the price for your limit/stop order.');
    if (bracketError) return setError(bracketError);
    if (risk && risk.warnings.length && !confirmWarnings) {
      setConfirmWarnings(true);
      return;
    }
    setBusy(true);
    try {
      const trail = draft.useTrail ? parseRupees(draft.trail) : null;
      await api('/orders', {
        body: {
          mode,
          replaySessionId: mode === 'replay' ? replaySessionId : undefined,
          instrument: inst.code,
          direction: draft.direction,
          orderType: draft.orderType,
          qty: draft.qty,
          triggerPrice: draft.orderType === 'MARKET' ? null : parseRupees(draft.trigger),
          slPrice: sl,
          tpPrice: tp,
          trailPaise: trail,
          setupTag: draft.setupTag,
          planNote: draft.planNote.trim(),
          confidence: draft.confidence,
        },
      });
      if (draft.orderType !== 'MARKET') toast({ title: `${draft.orderType === 'LIMIT' ? 'Limit' : 'Stop'} order placed`, body: `Waits for ${price(parseRupees(draft.trigger))}. Points are reserved until it fills or you cancel.` });
      onPlaced();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setConfirmWarnings(false);
    }
  };

  const isLong = draft.direction === 'LONG';
  return (
    <div className="ticket stack">
      <div className="segmented" role="radiogroup" aria-label="Direction">
        <button type="button" className={`long ${isLong ? 'active' : ''}`} onClick={() => set({ direction: 'LONG' })} aria-pressed={isLong}>
          Buy / Long
        </button>
        <button type="button" className={`short ${!isLong ? 'active' : ''}`} onClick={() => set({ direction: 'SHORT' })} aria-pressed={!isLong}>
          Sell / Short
        </button>
      </div>
      {!isLong && !shortExplained && (
        <div className="banner info">
          <div className="grow small">
            <b>Shorting, simply:</b> you sell first and buy back later. If the price falls you keep the difference; if it rises you lose. Your stop-loss goes <b>above</b> the entry.
          </div>
          <button
            className="btn small"
            onClick={() => {
              localStorage.setItem('td-short-explained', '1');
              setShortExplained(true);
            }}
          >
            Got it
          </button>
        </div>
      )}

      <div className="chips" role="radiogroup" aria-label="Order type">
        {(['MARKET', 'LIMIT', 'STOP'] as const).map((t) => (
          <button key={t} type="button" className={`chip ${draft.orderType === t ? 'active' : ''}`} onClick={() => set({ orderType: t, trigger: t === 'MARKET' ? '' : draft.trigger || toRupeeInput(entry) })}>
            {t === 'MARKET' ? 'Market' : t === 'LIMIT' ? 'Limit' : 'Stop'}
          </button>
        ))}
        <span className="tiny muted" style={{ alignSelf: 'center' }}>
          <Term k={draft.orderType === 'MARKET' ? 'market' : draft.orderType === 'LIMIT' ? 'limit' : 'stoporder'}>What’s this?</Term>
        </span>
      </div>

      <div className="grid two">
        <label className="field">
          Quantity ({inst.qtyUnit ?? 'g'})
          <div className="stepper">
            <button type="button" className="btn" onClick={() => step(-1)} aria-label="Less">−</button>
            <input
              inputMode="numeric"
              value={draft.qty}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, '')) || 0;
                set({ qty: n });
              }}
              onBlur={() => set({ qty: Math.max(inst.qtyMin, Math.round(draft.qty / inst.qtyStep) * inst.qtyStep) })}
            />
            <button type="button" className="btn" onClick={() => step(1)} aria-label="More">+</button>
          </div>
          <span className="tiny faint">Step {grams(inst.qtyStep)} · min {grams(inst.qtyMin)}</span>
        </label>
        <label className="field">
          {draft.orderType === 'MARKET' ? `Price (${isLong ? 'ask' : 'bid'})` : draft.orderType === 'LIMIT' ? 'Limit price (₹)' : 'Stop price (₹)'}
          {draft.orderType === 'MARKET' ? (
            <input value={entry ? price(entry) : '—'} readOnly aria-readonly className="num" />
          ) : (
            <input inputMode="decimal" value={draft.trigger} onChange={(e) => set({ trigger: e.target.value })} placeholder="e.g. 120500" />
          )}
          <span className="tiny faint">{inst.priceUnitLabel}</span>
        </label>
        <label className="field">
          <span><Term k="stoploss">Stop-loss</Term> (₹)</span>
          <input inputMode="decimal" value={draft.sl} onChange={(e) => set({ sl: e.target.value })} placeholder="optional, recommended" />
        </label>
        <label className="field">
          <span><Term k="target">Target</Term> (₹)</span>
          <input inputMode="decimal" value={draft.tp} onChange={(e) => set({ tp: e.target.value })} placeholder="optional" />
        </label>
      </div>
      {onSetOnChart ? (
        <button type="button" className="btn small" onClick={onSetOnChart}>Set stop &amp; target on the chart</button>
      ) : (
        <p className="tiny faint">Tip: drag the Entry ⇕, Stop and Target lines on the chart to adjust.</p>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={draft.useTrail} onChange={(e) => set({ useTrail: e.target.checked })} />
        <span><Term k="trailing">Trailing stop</Term></span>
      </label>
      {draft.useTrail && (
        <label className="field">
          Trail distance (₹ per {inst.priceUnitLabel.replace('₹ per ', '')})
          <input inputMode="decimal" value={draft.trail} onChange={(e) => set({ trail: e.target.value })} placeholder="e.g. 300" />
        </label>
      )}

      {risk && (
        <div className="risk-box">
          <div className="grid two">
            <div className="stat"><span className="label">Points at risk</span><span className="value loss">{risk.risk !== null ? points(risk.risk) : 'No stop'}</span></div>
            <div className="stat"><span className="label">% of account</span><span className={`value ${risk.riskPct !== null && risk.riskPct > riskWarnPct ? 'warn-text' : ''}`}>{risk.riskPct !== null ? pct(risk.riskPct) : '—'}</span></div>
            <div className="stat"><span className="label">Potential reward</span><span className="value profit">{risk.reward !== null ? points(risk.reward) : '—'}</span></div>
            <div className="stat"><span className="label"><Term k="rr">Risk : reward</Term></span><span className="value">{risk.rr !== null ? `1 : ${risk.rr.toFixed(2)}` : '—'}</span></div>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>
            Points used: <b className="num">{points(needed)}</b> of {points(free)} free{inst.brokeragePaise ? ` (incl. ${rupees(inst.brokeragePaise)} brokerage)` : ''}. No leverage: the full value is set aside.
          </p>
          <div className="row wrap small">
            <span className="muted">Size helper: risk</span>
            <input className="ind-param" inputMode="decimal" value={riskPctInput} onChange={(e) => setRiskPctInput(e.target.value)} aria-label="Risk percent" />
            <span className="muted">% of account →</span>
            <button type="button" className="btn small" disabled={!sl || !entry} onClick={sizeHelper}>Suggest quantity</button>
          </div>
          {risk.warnings.length > 0 && (
            <ul className="warn-list">
              {risk.warnings.map((w) => (
                <li key={w.code}>⚠️ {w.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <fieldset className="plan">
        <legend>Your trade plan</legend>
        <div className="chips wrap-chips" role="radiogroup" aria-label="Setup">
          {SETUP_TAGS.map((t) => (
            <button key={t} type="button" className={`chip ${draft.setupTag === t ? 'active' : ''}`} onClick={() => set({ setupTag: t })}>
              {t}
            </button>
          ))}
        </div>
        <label className="field">
          Why this trade? What would prove you wrong?
          <textarea value={draft.planNote} maxLength={1000} onChange={(e) => set({ planNote: e.target.value })} placeholder="e.g. Pullback to EMA in an uptrend; wrong if it closes below yesterday's low." />
        </label>
        <label className="field">
          Confidence: <b>{draft.confidence} / 5</b>
          <input type="range" min={1} max={5} step={1} value={draft.confidence} onChange={(e) => set({ confidence: Number(e.target.value) })} />
        </label>
      </fieldset>

      {error && <div className="banner danger" role="alert">{error}</div>}
      {!canTrade.ok && !error && <div className="banner warn">{canTrade.reason}</div>}
      {confirmWarnings && <div className="banner warn">These warnings are about your risk, not errors. Tap again to place the order anyway.</div>}
      <div className="row">
        {onCancel && <button type="button" className="btn grow" onClick={onCancel}>Cancel</button>}
        <button type="button" className={`btn grow ${isLong ? 'buy' : 'sell'}`} disabled={busy || !canTrade.ok} onClick={submit}>
          {busy ? 'Placing…' : confirmWarnings ? 'Place anyway' : `${isLong ? 'Buy' : 'Sell'} ${grams(draft.qty)}${draft.orderType === 'MARKET' ? '' : ` @ ${draft.trigger || '…'}`}`}
        </button>
      </div>
      <p className="tiny faint center">Simulated order{mode === 'replay' ? ' in Replay' : ''}: no real order is ever placed.</p>
    </div>
  );
}
