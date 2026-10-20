import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ErrorText } from '../components/Common';
import { Sheet } from '../components/Sheet';
import { api } from '../lib/api';
import { useDesktop } from '../lib/hooks';
import { dateTime, pct, points, rupees, signClass, timeAgo } from '../lib/format';
import { useAuth, useToast } from '../state/app';

type Tab = 'users' | 'settings' | 'feed';

function UsersTab() {
  const toast = useToast();
  const desktop = useDesktop();
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<any[] | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [grant, setGrant] = useState({ points: '', note: '' });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api('/admin/users', { query: { q } }).then((r) => setUsers(r.users)).catch(() => setUsers([]));
  }, [q]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => {
    setDetail(null);
    setError(null);
    setGrant({ points: '', note: '' });
    if (sel) api(`/admin/users/${sel}`).then(setDetail).catch((e) => setError(e.message));
  }, [sel]);
  const doGrant = async () => {
    setError(null);
    const n = Number(grant.points.replace(/,/g, ''));
    if (!n) return setError('Enter a number of points (negative to remove).');
    try {
      await api(`/admin/users/${sel}/grant`, { body: { points: n, note: grant.note } });
      toast({ title: 'Points granted', body: `${n > 0 ? '+' : ''}${n.toLocaleString('en-IN')} points` });
      setSel(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const toggleDisabled = async () => {
    try {
      await api(`/admin/users/${sel}`, { method: 'PATCH', body: { disabled: !detail.user.disabled } });
      toast({ title: detail.user.disabled ? 'User enabled' : 'User disabled' });
      setSel(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="stack">
      <input placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />
      {!users ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : !desktop ? (
        <div className="stack">
          {users.map((u) => (
            <button key={u.id} className="card user-card" onClick={() => setSel(u.id)}>
              <div className="row between">
                <b>{u.name}</b>
                <span className={`num ${signClass(Number(u.season_pnl))}`}>{points(Number(u.season_pnl), { sign: true })}</span>
              </div>
              <div className="row between tiny muted">
                <span>{u.email}</span>
                <span>{u.live_trades} trades{u.disabled ? ' · disabled' : ''}{u.role === 'admin' ? ' · admin' : ''}</span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="data">
            <thead><tr><th>User</th><th className="r">Equity</th><th className="r">Season P&amp;L</th><th className="r">Live trades</th><th>Last login</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <b>{u.name}</b> {u.role === 'admin' && <span className="badge">admin</span>} {u.disabled && <span className="badge closed">disabled</span>}
                    <div className="tiny muted">{u.email}</div>
                  </td>
                  <td className="r">{u.cash_available !== null ? points(u.cash_available + u.cash_reserved) : '-'}<div className="tiny muted">season {u.season ?? '-'}</div></td>
                  <td className={`r ${signClass(Number(u.season_pnl))}`}>{points(Number(u.season_pnl), { sign: true })}</td>
                  <td className="r">{u.live_trades}</td>
                  <td className="small">{u.last_login_at ? dateTime(u.last_login_at) : 'never'}</td>
                  <td><button className="btn small" onClick={() => setSel(u.id)}>View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Sheet open={!!sel} onClose={() => setSel(null)} title={detail?.user?.name ?? 'User'}>
        <ErrorText error={error} />
        {!detail ? (
          <div className="skeleton" style={{ height: 200 }} />
        ) : (
          <div className="stack">
            <p className="small muted">{detail.user.email} · joined {dateTime(detail.user.created_at)}</p>
            <div className="grid two">
              <div className="stat"><span className="label">Equity</span><span className="value">{points(detail.account.cash_available + detail.account.cash_reserved)}</span></div>
              <div className="stat"><span className="label">Trades (season {detail.account.season})</span><span className="value">{detail.stats.trades}</span></div>
              <div className="stat"><span className="label">Win rate</span><span className="value">{detail.stats.winRate.toFixed(0)}%</span></div>
              <div className="stat"><span className="label">Max drawdown</span><span className="value">{pct(detail.stats.maxDrawdownPct)}</span></div>
            </div>
            {detail.stats.topHabits.length > 0 && <p className="small">Top habits: {detail.stats.topHabits.map((h: any) => `${h.title} (${h.count})`).join(', ')}</p>}
            <div className="card flat stack">
              <h3>Grant points</h3>
              <div className="grid two">
                <label className="field">Points<input inputMode="decimal" value={grant.points} onChange={(e) => setGrant({ ...grant, points: e.target.value })} placeholder="e.g. 5000" /></label>
                <label className="field">Note (required)<input value={grant.note} onChange={(e) => setGrant({ ...grant, note: e.target.value })} placeholder="Reason" /></label>
              </div>
              <button className="btn primary" onClick={doGrant}>Grant</button>
            </div>
            <button className={`btn ${detail.user.disabled ? '' : 'danger'}`} onClick={toggleDisabled}>{detail.user.disabled ? 'Enable account' : 'Disable account'}</button>
            <h3>Recent ledger</h3>
            <ul className="plain-list small">
              {detail.ledger.map((l: any, i: number) => (
                <li key={i} className="row between"><span>{l.note ?? l.kind}<div className="tiny muted">{dateTime(l.created_at)}</div></span><span className={signClass(l.amount)}>{points(l.amount, { sign: true })}</span></li>
              ))}
            </ul>
          </div>
        )}
      </Sheet>
    </div>
  );
}

const NUM_FIELDS: Array<{ key: string; label: string; help?: string; scale?: number }> = [
  { key: 'starting_points', label: 'Starting points (new accounts and seasons)', scale: 100 },
  { key: 'rollover_days', label: 'Roll over this many days before expiry' },
  { key: 'rollover_notice_days', label: 'Warn users this many days before rollover' },
  { key: 'reset_cooldown_days', label: 'Days between season resets' },
  { key: 'reset_threshold_pct', label: 'Reset allowed below this % of starting points' },
  { key: 'overtrading_limit', label: 'Overtrading flag after N trades a day' },
  { key: 'risk_warn_pct', label: 'Warn when risk exceeds % of account' },
  { key: 'stale_after_seconds', label: '“Prices delayed” after N seconds without a tick' },
  { key: 'leaderboard_min_trades', label: 'Leaderboard minimum trades' },
  { key: 'tick_retention_days', label: 'Keep raw ticks for N days' },
];

function SettingsTab() {
  const toast = useToast();
  const [data, setData] = useState<any | null>(null);
  const [form, setForm] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hol, setHol] = useState({ date: '', description: '', special_open: '', special_close: '' });
  const load = useCallback(() => {
    api('/admin/settings').then((r) => {
      setData(r);
      setForm(JSON.parse(JSON.stringify(r.settings)));
    });
  }, []);
  useEffect(load, [load]);
  if (!data || !form) return <div className="skeleton" style={{ height: 300 }} />;
  const save = async () => {
    setError(null);
    try {
      await api('/admin/settings', { method: 'PUT', body: form });
      toast({ title: 'Settings saved' });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const saveInst = async (inst: any) => {
    try {
      await api(`/admin/instruments/${inst.id}`, {
        method: 'PATCH',
        body: { product_symbol: inst.product_symbol, fallback_spread_paise: Math.round(Number(inst.spread) * 100), brokerage_paise: Math.round(Number(inst.brokerage) * 100), qty_step: Number(inst.qty_step), qty_min: Number(inst.qty_min), enabled: inst.enabled },
      });
      toast({ title: `${inst.display_name} updated` });
      load();
    } catch (e) {
      toast({ title: 'Update failed', body: (e as Error).message, kind: 'error' });
    }
  };
  const addHoliday = async () => {
    try {
      await api('/admin/holidays', { body: { date: hol.date, description: hol.description, closed: true, special_open: hol.special_open || null, special_close: hol.special_close || null } });
      setHol({ date: '', description: '', special_open: '', special_close: '' });
      load();
    } catch (e) {
      toast({ title: 'Could not add holiday', body: (e as Error).message, kind: 'error' });
    }
  };
  const mh = form.market_hours;
  return (
    <div className="grid md-two">
      <div className="card stack">
        <h2>General</h2>
        <ErrorText error={error} />
        {NUM_FIELDS.map((f) => (
          <label className="field" key={f.key}>
            {f.label}
            <input inputMode="decimal" value={f.scale ? form[f.key] / f.scale : form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value || 0) * (f.scale ?? 1) })} />
          </label>
        ))}
        <label className="checkbox"><input type="checkbox" checked={form.leaderboard_enabled} onChange={(e) => setForm({ ...form, leaderboard_enabled: e.target.checked })} /><span>Show the leaderboard (risk-adjusted)</span></label>
        <h3>Market hours (IST)</h3>
        <div className="grid two">
          <label className="field">Open<input type="time" value={mh.open} onChange={(e) => setForm({ ...form, market_hours: { ...mh, open: e.target.value } })} /></label>
          <label className="field">Close (US summer time)<input type="time" value={mh.closeUsDst} onChange={(e) => setForm({ ...form, market_hours: { ...mh, closeUsDst: e.target.value } })} /></label>
          <label className="field">Close (US winter time)<input type="time" value={mh.closeUsStd} onChange={(e) => setForm({ ...form, market_hours: { ...mh, closeUsStd: e.target.value } })} /></label>
        </div>
        <div className="row wrap">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
            <label key={d} className="checkbox"><input type="checkbox" checked={mh.weekdays.includes(i)} onChange={(e) => setForm({ ...form, market_hours: { ...mh, weekdays: e.target.checked ? [...mh.weekdays, i].sort() : mh.weekdays.filter((x: number) => x !== i) } })} /><span>{d}</span></label>
          ))}
        </div>
        <label className="checkbox"><input type="checkbox" checked={mh.useProviderTimings} onChange={(e) => setForm({ ...form, market_hours: { ...mh, useProviderTimings: e.target.checked } })} /><span>Use exchange timings from Upstox when available</span></label>
        <button className="btn primary" onClick={save}>Save settings</button>
      </div>
      <div>
        <div className="card stack">
          <h2>Instruments</h2>
          {data.instruments.map((inst: any) => (
            <InstrumentForm key={inst.id} inst={inst} onSave={saveInst} />
          ))}
        </div>
        <div className="card stack">
          <h2>Holidays &amp; special sessions</h2>
          <ul className="plain-list small">
            {data.holidays.map((h: any) => (
              <li key={h.id} className="row between">
                <span>{h.date} · {h.description}{h.special_open ? ` · open ${h.special_open}-${h.special_close}` : ' · closed'}</span>
                <button className="btn small ghost danger" onClick={() => api(`/admin/holidays/${h.id}`, { method: 'DELETE' }).then(load)}>Remove</button>
              </li>
            ))}
          </ul>
          <div className="grid two">
            <input type="date" aria-label="Holiday date" value={hol.date} onChange={(e) => setHol({ ...hol, date: e.target.value })} />
            <input placeholder="Description" value={hol.description} onChange={(e) => setHol({ ...hol, description: e.target.value })} />
            <input type="time" aria-label="Special session open" value={hol.special_open} onChange={(e) => setHol({ ...hol, special_open: e.target.value })} />
            <input type="time" aria-label="Special session close" value={hol.special_close} onChange={(e) => setHol({ ...hol, special_close: e.target.value })} />
          </div>
          <p className="tiny faint">Leave the times empty for a full-day closure, or set both for a special session (e.g. Muhurat trading).</p>
          <button className="btn" disabled={!hol.date} onClick={addHoliday}>Add</button>
        </div>
      </div>
    </div>
  );
}

function InstrumentForm({ inst, onSave }: { inst: any; onSave: (i: any) => void }) {
  const [f, setF] = useState({ ...inst, spread: inst.fallback_spread_paise / 100, brokerage: inst.brokerage_paise / 100 });
  return (
    <div className="card flat stack">
      <div className="row between"><b>{inst.display_name}</b><label className="checkbox"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /><span>Enabled</span></label></div>
      <div className="grid two">
        <label className="field">MCX product<input value={f.product_symbol} onChange={(e) => setF({ ...f, product_symbol: e.target.value.toUpperCase() })} /></label>
        <label className="field">Fallback spread (₹)<input inputMode="decimal" value={f.spread} onChange={(e) => setF({ ...f, spread: e.target.value })} /></label>
        <label className="field">Brokerage per order (₹)<input inputMode="decimal" value={f.brokerage} onChange={(e) => setF({ ...f, brokerage: e.target.value })} /></label>
        <label className="field">Qty step / min (g)<div className="row"><input inputMode="numeric" value={f.qty_step} onChange={(e) => setF({ ...f, qty_step: e.target.value })} /><input inputMode="numeric" value={f.qty_min} onChange={(e) => setF({ ...f, qty_min: e.target.value })} /></div></label>
      </div>
      <p className="tiny faint">{inst.price_unit_label}. Changing the product (e.g. GOLDM → GOLD or GOLDPETAL) closes open live positions on the old contract, like a rollover.</p>
      <button className="btn small" onClick={() => onSave(f)}>Save {inst.display_name}</button>
    </div>
  );
}

function FeedTab() {
  const toast = useToast();
  const [d, setD] = useState<any | null>(null);
  const load = useCallback(() => {
    api('/admin/feed-health').then(setD).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  if (!d) return <div className="skeleton" style={{ height: 300 }} />;
  const h = d.health;
  const run = async (path: string, label: string) => {
    try {
      await api(path, { method: 'POST' });
      toast({ title: label });
      load();
    } catch (e) {
      toast({ title: 'Failed', body: (e as Error).message, kind: 'error' });
    }
  };
  const tokenDays = h.tokenExpiresAt ? Math.round((new Date(h.tokenExpiresAt).getTime() - Date.now()) / 86_400_000) : null;
  return (
    <div className="grid md-two">
      <div>
        <div className="card">
          <h2>Data feed</h2>
          <dl className="kv">
            <dt>Provider</dt><dd>{h.provider}</dd>
            <dt>WebSocket</dt><dd><span className={`badge ${h.wsStatus === 'connected' ? 'open' : h.wsStatus === 'disabled' ? 'closed' : 'warn'}`}>{h.wsStatus}</span></dd>
            <dt>Token</dt><dd>{h.tokenValid === true ? 'valid' : h.tokenValid === false ? <span className="loss">invalid / expired</span> : 'unknown'}</dd>
            <dt>Token expires</dt><dd>{h.tokenExpiresAt ? `${dateTime(h.tokenExpiresAt)} (${tokenDays} days)` : 'n/a'}</dd>
            <dt>Last message</dt><dd>{timeAgo(h.lastMessageAt)}</dd>
            <dt>Reconnects</dt><dd>{h.reconnects}</dd>
            <dt>Market</dt><dd>{h.market.open ? 'open' : `closed (${h.market.reason})`}</dd>
            <dt>App users online</dt><dd>{d.connectedUsers}</dd>
            <dt>Contracts synced</dt><dd>{h.lastContractSync ? dateTime(h.lastContractSync) : 'never'}</dd>
          </dl>
          {h.note && <p className="small muted" style={{ marginTop: 8 }}>{h.note}</p>}
          {tokenDays !== null && tokenDays < 30 && <div className="banner warn small">The Analytics Token expires soon. Generate a new one in Upstox Developer Apps → Analytics and update UPSTOX_ANALYTICS_TOKEN.</div>}
          <div className="row wrap" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={() => run('/admin/contracts/refresh', 'Contracts refreshed')}>Refresh contracts</button>
            <button className="btn small" disabled={d.backfill.running} onClick={() => run('/admin/backfill', 'Backfill started')}>Run backfill</button>
          </div>
        </div>
        <div className="card table-wrap">
          <h2>Active contracts</h2>
          <table className="data">
            <thead><tr><th>Instrument</th><th>Contract</th><th>Expiry</th><th>Rollover</th><th>Last tick</th></tr></thead>
            <tbody>
              {h.instruments.map((i: any) => (
                <tr key={i.code}>
                  <td>{i.code} <span className="tiny muted">{i.product}</span></td>
                  <td className="small">{i.contract ?? '—'}<div className="tiny faint">{i.instrumentKey}</div></td>
                  <td>{i.expiry ?? '—'}</td>
                  <td>{i.rolloverDate ?? '—'}</td>
                  <td>{timeAgo(i.lastTickAt)} {i.stale && <span className="badge warn">stale</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <div className="card">
          <h2>Backfill</h2>
          <dl className="kv">
            <dt>Status</dt><dd>{d.backfill.running ? 'running' : 'idle'}</dd>
            <dt>Progress</dt><dd>{d.backfill.chunksDone}/{d.backfill.chunksTotal} chunks</dd>
            <dt>Candles saved</dt><dd>{d.backfill.candlesSaved.toLocaleString('en-IN')}</dd>
            <dt>Current</dt><dd className="small">{d.backfill.current ?? '—'}</dd>
            <dt>Finished</dt><dd>{d.backfill.finishedAt ? dateTime(d.backfill.finishedAt) : '—'}</dd>
          </dl>
          <h3 style={{ marginTop: 12 }}>Stored data</h3>
          <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Instrument</th><th>Interval</th><th className="r">Candles</th><th>From</th><th>To</th></tr></thead>
            <tbody>
              {d.storage.candles.map((c: any, i: number) => (
                <tr key={i}><td>{c.code}</td><td>{c.interval}</td><td className="r">{c.n.toLocaleString('en-IN')}</td><td className="small">{dateTime(c.first)}</td><td className="small">{dateTime(c.last)}</td></tr>
              ))}
            </tbody>
          </table>
          </div>
          <p className="tiny faint">Raw ticks stored: {d.storage.ticks?.n?.toLocaleString('en-IN') ?? 0} (pruned after the retention period).</p>
        </div>
        <div className="card">
          <h2>Recent errors</h2>
          {h.errors.length === 0 ? <p className="small profit">No recent errors.</p> : (
            <ul className="plain-list small">
              {h.errors.map((e: any, i: number) => <li key={i}><span className="tiny muted">{dateTime(e.at)}</span><div>{e.message}</div></li>)}
            </ul>
          )}
          {d.backfill.errors.length > 0 && (
            <>
              <h3>Backfill errors</h3>
              <ul className="plain-list small">{d.backfill.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function AdminPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('users');
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return (
    <div className="page">
      <div className="page-header"><h1>Admin</h1></div>
      <div className="tabs" role="tablist" style={{ marginTop: 0, marginBottom: 14 }}>
        {(['users', 'settings', 'feed'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'users' ? 'Users' : t === 'settings' ? 'Settings' : 'Feed health'}
          </button>
        ))}
      </div>
      {tab === 'users' && <UsersTab />}
      {tab === 'settings' && <SettingsTab />}
      {tab === 'feed' && <FeedTab />}
      <p className="tiny faint" style={{ marginTop: 16 }}>Spreads and brokerage are in ₹ ({rupees(100)} = 100 paise). All changes apply immediately.</p>
    </div>
  );
}
