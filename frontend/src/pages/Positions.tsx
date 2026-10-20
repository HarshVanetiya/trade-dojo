import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, ErrorText } from '../components/Common';
import { Term } from '../components/Glossary';
import { ConfirmSheet, Sheet } from '../components/Sheet';
import { api } from '../lib/api';
import { dateTime, grams, parseRupees, points, price, signClass, toRupeeInput } from '../lib/format';
import { pnl } from '../lib/risk';
import { EXIT_REASONS, type Mode, type Order, type Position } from '../lib/types';
import { useMode, useToast, useTradingRefresh } from '../state/app';
import { useMarket } from '../state/marketStore';

function useLiveMark(p: Position) {
  const quote = useMarket((s) => s.quotes[p.instrument] ?? null);
  const inst = useMarket((s) => s.instruments.find((i) => i.code === p.instrument) ?? null);
  if (p.mode !== 'live' || !quote || !inst || p.contract?.symbol !== quote.contract) return { mark: p.markPrice, unrealized: p.unrealizedPnl };
  const mark = p.direction === 'LONG' ? quote.bid ?? quote.ltp - Math.floor(inst.spreadPaise / 2) : quote.ask ?? quote.ltp + Math.ceil(inst.spreadPaise / 2);
  return { mark, unrealized: pnl(p.direction, p.qtyOpen, p.avgEntry, mark, p.unitGrams) };
}

function PositionCard({ p, onEdit, onClose }: { p: Position; onEdit: () => void; onClose: () => void }) {
  const { mark, unrealized } = useLiveMark(p);
  const pctOfUsed = p.pointsUsed ? (unrealized / p.pointsUsed) * 100 : 0;
  return (
    <div className="card position-card">
      <div className="row between">
        <div className="row">
          <span className={`badge ${p.direction === 'LONG' ? 'long' : 'short'}`}>{p.direction === 'LONG' ? 'LONG' : 'SHORT'}</span>
          <b>{p.instrumentName}</b>
          <span className="small muted num">{grams(p.qtyOpen)}{p.qtyOpen !== p.qtyInitial ? ` of ${grams(p.qtyInitial)}` : ''}</span>
        </div>
        <div className={`num bold ${signClass(unrealized)}`} style={{ fontSize: 18 }}>{points(unrealized, { sign: true })}</div>
      </div>
      {p.rolloverNotice && <div className="banner warn small" style={{ marginTop: 8 }}>{p.rolloverNotice}</div>}
      <dl className="kv" style={{ marginTop: 8 }}>
        <dt>Entry · now</dt>
        <dd>{price(p.avgEntry)} · {price(mark)} <span className={`tiny ${signClass(unrealized)}`}>({pctOfUsed > 0 ? '+' : ''}{pctOfUsed.toFixed(2)}%)</span></dd>
        <dt><Term k="stoploss">Stop-loss</Term></dt>
        <dd className={p.slPrice ? '' : 'warn-text'}>{p.slPrice ? price(p.slPrice) : 'None set'}{p.trailPaise ? ` (trailing ${price(p.trailPaise)})` : ''}</dd>
        <dt><Term k="target">Target</Term></dt>
        <dd>{p.tpPrice ? price(p.tpPrice) : '—'}</dd>
        <dt>Points used</dt>
        <dd>{points(p.pointsUsed)}</dd>
        {p.realizedPnl !== 0 && (
          <>
            <dt>Realized so far</dt>
            <dd className={signClass(p.realizedPnl)}>{points(p.realizedPnl, { sign: true })}</dd>
          </>
        )}
        <dt>Contract</dt>
        <dd className="small">{p.contract?.symbol ?? '—'}</dd>
        <dt>Opened</dt>
        <dd className="small">{dateTime(p.openedAt)}</dd>
      </dl>
      {p.planNote && <p className="small muted" style={{ marginTop: 8 }}>“{p.planNote}” · {p.setupTag} · confidence {p.confidence}/5</p>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn grow" onClick={onEdit}>Edit SL / target</button>
        <button className="btn grow danger" onClick={onClose}>Close…</button>
      </div>
    </div>
  );
}

function EditSheet({ p, onDone }: { p: Position | null; onDone: () => void }) {
  const toast = useToast();
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [trail, setTrail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!p) return;
    setSl(toRupeeInput(p.slPrice));
    setTp(toRupeeInput(p.tpPrice));
    setTrail(toRupeeInput(p.trailPaise));
    setError(null);
  }, [p]);
  const save = async () => {
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/positions/${p.id}`, { method: 'PATCH', body: { slPrice: parseRupees(sl), tpPrice: parseRupees(tp), trailPaise: parseRupees(trail) } });
      toast({ title: 'Position updated' });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const widening = p && p.slPrice && parseRupees(sl) !== null && (p.direction === 'LONG' ? parseRupees(sl)! < p.slPrice : parseRupees(sl)! > p.slPrice);
  return (
    <Sheet open={!!p} onClose={onDone} title="Edit stop-loss & target">
      <div className="stack">
        <ErrorText error={error} />
        <label className="field">Stop-loss (₹)<input inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} placeholder="none" /></label>
        {(widening || (p?.slPrice && !sl)) && <div className="banner warn small">You are moving your stop further away. That increases the loss you agreed to; reviews flag this habit.</div>}
        <label className="field">Target (₹)<input inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="none" /></label>
        <label className="field"><span><Term k="trailing">Trailing distance</Term> (₹, optional)</span><input inputMode="decimal" value={trail} onChange={(e) => setTrail(e.target.value)} placeholder="off" /></label>
        <button className="btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Sheet>
  );
}

function CloseSheet({ p, onDone }: { p: Position | null; onDone: (tradeId?: number | null) => void }) {
  const toast = useToast();
  const step = useMarket((s) => s.instruments.find((i) => i.code === p?.instrument)?.qtyStep ?? (p?.instrument === 'SILVER' ? 100 : 1));
  const [qty, setQty] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (p) {
      setQty(p.qtyOpen);
      setConfirm(false);
      setError(null);
    }
  }, [p]);
  if (!p) return null;
  const doClose = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api(`/positions/${p.id}/close`, { body: { qty } });
      toast({ title: qty === p.qtyOpen ? 'Position closed' : `Closed ${grams(qty)}` });
      onDone(r.tradeId);
    } catch (e) {
      setError((e as Error).message);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Sheet open={!confirm} onClose={() => onDone()} title={`Close ${p.instrumentName} ${p.direction === 'LONG' ? 'long' : 'short'}`}>
        <div className="stack">
          <ErrorText error={error} />
          <label className="field">
            Quantity to close
            <div className="stepper">
              <button className="btn" onClick={() => setQty(Math.max(step, qty - step))}>−</button>
              <input inputMode="numeric" value={qty} onChange={(e) => setQty(Number(e.target.value.replace(/\D/g, '')) || 0)} />
              <button className="btn" onClick={() => setQty(Math.min(p.qtyOpen, qty + step))}>+</button>
            </div>
          </label>
          <div className="chips">
            {[0.25, 0.5, 1].map((f) => {
              const q = Math.max(step, Math.round((p.qtyOpen * f) / step) * step);
              return <button key={f} className={`chip ${qty === q ? 'active' : ''}`} onClick={() => setQty(Math.min(q, p.qtyOpen))}>{f === 1 ? 'All' : `${f * 100}%`}</button>;
            })}
          </div>
          <p className="small muted">{p.mode === 'live' ? 'Closes at the current market price (sell at the bid for longs, buy at the ask for shorts).' : 'Closes at the current replay candle price.'}</p>
          <button className="btn sell block" onClick={() => setConfirm(true)} disabled={qty <= 0 || qty > p.qtyOpen}>Close {grams(qty)}</button>
        </div>
      </Sheet>
      <ConfirmSheet open={confirm} title="Confirm close" body={<p>Close <b>{grams(qty)}</b> of your {p.instrumentName} {p.direction.toLowerCase()} at market?</p>} confirmLabel="Close now" danger busy={busy} onConfirm={doClose} onClose={() => setConfirm(false)} />
    </>
  );
}

export function PositionsPage() {
  const { mode, setMode, replaySessionId } = useMode();
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [closed, setClosed] = useState<Position[]>([]);
  const [editing, setEditing] = useState<Position | null>(null);
  const [closing, setClosing] = useState<Position | null>(null);
  const toast = useToast();
  const sessionQ = mode === 'replay' ? replaySessionId ?? undefined : undefined;
  const load = useCallback(() => {
    if (mode === 'replay' && !replaySessionId) {
      setPositions([]);
      setOrders([]);
      setClosed([]);
      return;
    }
    Promise.all([
      api('/positions', { query: { mode, sessionId: sessionQ } }),
      api('/orders', { query: { mode, status: 'pending', sessionId: sessionQ } }),
      api('/positions', { query: { mode, status: 'closed', sessionId: sessionQ } }),
    ])
      .then(([p, o, c]) => {
        setPositions(p.positions);
        setOrders(o.orders);
        setClosed(c.positions.slice(0, 10));
      })
      .catch(() => setPositions((x) => x ?? []));
  }, [mode, replaySessionId, sessionQ]);
  useEffect(() => {
    load();
    const t = setInterval(load, mode === 'replay' ? 3000 : 15000);
    return () => clearInterval(t);
  }, [load, mode]);
  useTradingRefresh(load);

  const cancel = async (o: Order) => {
    try {
      await api(`/orders/${o.id}/cancel`, { method: 'POST' });
      toast({ title: 'Order cancelled', body: 'Reserved points released.' });
      load();
    } catch (e) {
      toast({ title: 'Could not cancel', body: (e as Error).message, kind: 'error' });
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Positions</h1>
        <div className="segmented" style={{ width: 200 }}>
          {(['live', 'replay'] as Mode[]).map((m) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>{m === 'live' ? 'Live' : 'Replay'}</button>
          ))}
        </div>
      </div>
      {mode === 'replay' && !replaySessionId && <div className="banner info">No replay session running. Start one from the Trade tab in Replay mode.</div>}
      <div className="grid md-two">
        <section>
          <h2>Open</h2>
          {positions === null ? (
            <div className="skeleton" style={{ height: 160 }} />
          ) : positions.length === 0 ? (
            <div className="card">
              <Empty icon="🧭" title="No open positions">
                Good traders spend most of their time waiting. When you see a setup, open a trade from the Trade tab with a stop-loss and a target.
              </Empty>
              <div className="center"><Link className="btn primary" to="/">Go to Trade</Link></div>
            </div>
          ) : (
            positions.map((p) => <PositionCard key={p.id} p={p} onEdit={() => setEditing(p)} onClose={() => setClosing(p)} />)
          )}
        </section>
        <section>
          <h2>Pending orders</h2>
          <div className="card">
            {orders.length === 0 ? (
              <p className="small muted">No pending orders. <Term k="limit">Limit</Term> and <Term k="stoporder">stop</Term> orders wait here until price reaches them. They stay pending while the market is closed.</p>
            ) : (
              <ul className="plain-list">
                {orders.map((o) => (
                  <li key={o.id} className="row between">
                    <span className="small">
                      <span className={`badge ${o.direction === 'LONG' ? 'long' : 'short'}`}>{o.direction === 'LONG' ? 'Buy' : 'Sell'} {o.orderType.toLowerCase()}</span>{' '}
                      <b>{o.instrument}</b> <span className="num">{grams(o.qty)} @ {price(o.triggerPrice)}</span>
                      <div className="tiny muted">Reserved {points(o.pointsReserved)} · {dateTime(o.createdAt)}</div>
                    </span>
                    <button className="btn small danger" onClick={() => cancel(o)}>Cancel</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <h2 style={{ marginTop: 16 }}>Recently closed</h2>
          <div className="card">
            {closed.length === 0 ? (
              <p className="small muted">Closed trades and their reviews appear here and in your Journal.</p>
            ) : (
              <ul className="plain-list">
                {closed.map((p) => (
                  <li key={p.id} className="row between">
                    <span className="small">
                      <b>{p.instrumentName}</b> {p.direction === 'LONG' ? 'long' : 'short'} {grams(p.qtyInitial)}
                      <div className="tiny muted">{EXIT_REASONS[p.exitReason ?? ''] ?? p.exitReason} · {dateTime(p.closedAt)}</div>
                    </span>
                    <span className={`num bold ${signClass(p.realizedPnl - p.brokerage)}`}>{points(p.realizedPnl - p.brokerage, { sign: true })}</span>
                  </li>
                ))}
              </ul>
            )}
            <Link className="small" to="/journal">Open journal →</Link>
          </div>
        </section>
      </div>
      <EditSheet p={editing} onDone={() => { setEditing(null); load(); }} />
      <CloseSheet p={closing} onDone={(tradeId) => {
        setClosing(null);
        load();
        if (tradeId) toast({ title: 'Trade review ready', kind: 'info', action: { label: 'Open review', href: `/trades/${tradeId}` } });
      }} />
    </div>
  );
}
