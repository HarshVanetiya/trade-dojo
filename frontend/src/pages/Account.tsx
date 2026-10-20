import { useEffect, useState, type FormEvent } from 'react';
import { Disclaimer, ErrorText } from '../components/Common';
import { useGlossary, Term } from '../components/Glossary';
import { ConfirmSheet } from '../components/Sheet';
import { api, tokenStore } from '../lib/api';
import { dateTime, points } from '../lib/format';
import type { Account, Mode } from '../lib/types';
import { useAuth, useTheme, useToast, type ThemePref } from '../state/app';
import { useInstallPrompt } from '../pwa';

interface Reset {
  eligible: boolean;
  reason?: string;
  nextEligibleAt?: string;
}

function AccountCard({ mode }: { mode: Mode }) {
  const toast = useToast();
  const [acc, setAcc] = useState<Account | null>(null);
  const [reset, setReset] = useState<Reset | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api('/account', { query: { mode } })
      .then((r) => {
        setAcc(r.account);
        setReset(r.reset);
      })
      .catch(() => {});
  useEffect(() => {
    void load();
  }, [mode]);
  const doReset = async () => {
    setBusy(true);
    try {
      const r = await api('/account/reset', { body: { mode } });
      toast({ title: `Season ${r.season} started`, body: 'Your old trades are kept in the journal under the previous season.', kind: 'info' });
      setConfirm(false);
      await load();
    } catch (err) {
      toast({ title: 'Reset not possible', body: (err as Error).message, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  if (!acc) return <div className="card"><div className="skeleton" style={{ height: 80 }} /></div>;
  return (
    <div className="card">
      <div className="card-title">
        <h2>{mode === 'live' ? 'Live account' : 'Replay balance'}</h2>
        <span className="badge">Season {acc.season}</span>
      </div>
      <div className="grid two">
        <div className="stat"><span className="label">Equity</span><span className="value">{points(acc.equity)}</span></div>
        <div className="stat"><span className="label">Starting <Term k="points">points</Term></span><span className="value">{points(acc.startingPoints)}</span></div>
        <div className="stat"><span className="label">Points free</span><span className="value">{points(acc.pointsFree)}</span></div>
        <div className="stat"><span className="label">Points used</span><span className="value">{points(acc.pointsUsed)}</span></div>
      </div>
      <hr className="divider" />
      {mode === 'live' ? (
        <p className="small muted">
          Points can’t be added. If your balance falls below 10% of your starting points you may start a new season (once every 7 days). History is kept.
        </p>
      ) : (
        <p className="small muted">Replay uses its own balance, so practice never touches your live account. You can reset it any time no replay is running.</p>
      )}
      {reset && !reset.eligible && reset.reason && <p className="small faint">{reset.reason}{reset.nextEligibleAt ? ` Next possible: ${dateTime(reset.nextEligibleAt)}.` : ''}</p>}
      <button className="btn" disabled={!reset?.eligible} onClick={() => setConfirm(true)}>Start a new season</button>
      <ConfirmSheet
        open={confirm}
        title="Start a new season?"
        body={<p>Your current season is closed and kept in history. You get a fresh {points(acc.startingPoints)}.{mode === 'live' ? ' You can do this once every 7 days.' : ''}</p>}
        confirmLabel="Start new season"
        busy={busy}
        onConfirm={doReset}
        onClose={() => setConfirm(false)}
      />
    </div>
  );
}

function ChangePassword() {
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next.length < 8) return setError('New password must be at least 8 characters.');
    setBusy(true);
    try {
      const r = await api('/auth/change-password', { body: { currentPassword: cur, newPassword: next } });
      tokenStore.set(r.token);
      setCur('');
      setNext('');
      toast({ title: 'Password changed', body: 'Other sessions have been logged out.' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Change password</h2>
      <ErrorText error={error} />
      <label className="field">Current password<input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>
      <label className="field">New password<input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} /></label>
      <button className="btn" disabled={busy}>Update password</button>
    </form>
  );
}

function Ledger() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open && !rows) api('/me/ledger').then((r) => setRows(r.entries)).catch(() => setRows([]));
  }, [open, rows]);
  return (
    <div className="card">
      <div className="card-title">
        <h2>Points ledger</h2>
        <button className="btn small" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>
      </div>
      <p className="small muted">Every change to your points, in order. Entries can never be edited.</p>
      {open && (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Time</th><th>What</th><th className="r">Change</th><th className="r">Free after</th></tr></thead>
            <tbody>
              {(rows ?? []).map((r) => (
                <tr key={r.id}>
                  <td>{dateTime(r.created_at)}</td>
                  <td>{r.note ?? r.kind}</td>
                  <td className={`r ${r.amount > 0 ? 'profit' : r.amount < 0 ? 'loss' : ''}`}>{points(r.amount, { sign: true })}</td>
                  <td className="r">{points(r.balance_after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AccountPage() {
  const { user, logout } = useAuth();
  const { pref, setPref } = useTheme();
  const openGlossary = useGlossary();
  const install = useInstallPrompt();
  return (
    <div className="page">
      <div className="page-header">
        <h1>Account</h1>
        <button className="btn small" onClick={logout}>Log out</button>
      </div>
      <div className="grid md-two">
        <div>
          <div className="card">
            <h2>{user?.name}</h2>
            <p className="muted small">{user?.email}{user?.role === 'admin' ? ' · admin' : ''}</p>
            <label className="field">
              Theme
              <div className="segmented" role="radiogroup" aria-label="Theme">
                {(['system', 'light', 'dark'] as ThemePref[]).map((t) => (
                  <button key={t} type="button" className={pref === t ? 'active' : ''} onClick={() => setPref(t)} aria-pressed={pref === t}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </label>
            <div className="row wrap" style={{ marginTop: 12 }}>
              <button className="btn small" onClick={() => openGlossary()}>Glossary</button>
              {install.canInstall && <button className="btn small primary" onClick={install.prompt}>Install app</button>}
            </div>
            {!install.canInstall && !install.installed && (
              <p className="tiny faint" style={{ marginTop: 8 }}>To install, use your browser’s “Add to Home screen”. Installing needs https or localhost.</p>
            )}
          </div>
          <AccountCard mode="live" />
          <AccountCard mode="replay" />
        </div>
        <div>
          <ChangePassword />
          <Ledger />
          <div className="card">
            <h2>About TradeDojo</h2>
            <Disclaimer />
            <p className="small muted">Market data: MCX via Upstox. Times shown in IST.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
