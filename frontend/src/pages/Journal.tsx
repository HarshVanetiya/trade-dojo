import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty } from '../components/Common';
import { DEFAULT_FILTERS, FilterBar, filterQuery, type TradeFilters } from '../components/Filters';
import { api, downloadFile } from '../lib/api';
import { dateTime, duration, grams, points, price, rMult, signClass } from '../lib/format';
import { useDesktop } from '../lib/hooks';
import { EXIT_REASONS, type Trade } from '../lib/types';
import { useOnline } from '../pwa';
import { useAuth, useToast } from '../state/app';

const cacheKey = (uid?: number) => `td-journal-cache-${uid ?? 'anon'}`;

export function JournalPage() {
  const { user } = useAuth();
  const online = useOnline();
  const desktop = useDesktop();
  const toast = useToast();
  const [filters, setFilters] = useState<TradeFilters>(DEFAULT_FILTERS);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [seasons, setSeasons] = useState<number[]>([]);
  const [cachedAt, setCachedAt] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fromCache = () => {
      try {
        const raw = localStorage.getItem(cacheKey(user?.id));
        if (raw) {
          const c = JSON.parse(raw);
          setTrades(c.trades);
          setCachedAt(c.at);
          return;
        }
      } catch {
        /* ignore */
      }
      setTrades([]);
    };
    if (!online) return fromCache();
    setTrades(null);
    api<{ trades: Trade[] }>('/trades', { query: { ...filterQuery(filters), limit: 200 } })
      .then((r) => {
        if (!alive) return;
        setTrades(r.trades);
        setCachedAt(null);
        // Keep a read-only copy for offline use (default filters only).
        if (JSON.stringify(filters) === JSON.stringify(DEFAULT_FILTERS)) {
          try {
            localStorage.setItem(cacheKey(user?.id), JSON.stringify({ at: new Date().toISOString(), trades: r.trades.slice(0, 100) }));
          } catch {
            /* storage full: offline copy is best effort */
          }
        }
      })
      .catch(() => alive && fromCache());
    return () => {
      alive = false;
    };
  }, [filters, online, user?.id]);

  useEffect(() => {
    if (!online) return;
    api('/stats', { query: { mode: filters.mode, season: 'all' } })
      .then((r) => setSeasons(r.seasons.map((s: { season: number }) => s.season)))
      .catch(() => {});
  }, [filters.mode, online]);

  const exportCsv = async () => {
    try {
      await downloadFile('/journal/export.csv', filterQuery(filters), `tradedojo-journal-${filters.mode}.csv`);
    } catch (e) {
      toast({ title: 'Export failed', body: (e as Error).message, kind: 'error' });
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Journal</h1>
        <button className="btn small" onClick={exportCsv} disabled={!online}>Export CSV</button>
      </div>
      {!online && <div className="banner warn">You’re offline. Showing your journal as last saved{cachedAt ? ` (${dateTime(cachedAt)})` : ''}, read-only.</div>}
      {online && <FilterBar value={filters} onChange={setFilters} seasons={seasons} />}
      {trades === null ? (
        <div className="stack">{[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 72 }} />)}</div>
      ) : trades.length === 0 ? (
        <div className="card">
          <Empty icon="📓" title="No trades here yet">
            Every closed trade lands in your journal with its plan, result and a review. Over time you’ll see which setups work for you.
          </Empty>
        </div>
      ) : desktop ? (
        <div className="card table-wrap">
          <table className="data">
            <thead>
              <tr><th>Closed</th><th>Instrument</th><th>Side</th><th className="r">Qty</th><th className="r">Entry</th><th className="r">Exit</th><th className="r">Net P&amp;L</th><th className="r">R</th><th>Exit</th><th>Setup</th><th>Flags</th><th /></tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id}>
                  <td>{dateTime(t.exitTs)}</td>
                  <td>{t.instrumentName}{t.mode === 'replay' ? ' (replay)' : ''}</td>
                  <td><span className={`badge ${t.direction === 'LONG' ? 'long' : 'short'}`}>{t.direction === 'LONG' ? 'Long' : 'Short'}</span></td>
                  <td className="r">{grams(t.qty)}</td>
                  <td className="r">{price(t.entryPrice)}</td>
                  <td className="r">{price(t.exitPrice)}</td>
                  <td className={`r bold ${signClass(t.netPnl)}`}>{points(t.netPnl, { sign: true })}</td>
                  <td className={`r ${signClass(t.rMultiple)}`}>{rMult(t.rMultiple)}</td>
                  <td>{EXIT_REASONS[t.exitReason] ?? t.exitReason}</td>
                  <td>{t.setupTag}</td>
                  <td>{t.flags.length ? <span className="badge warn">{t.flags.length}</span> : <span className="badge open">✓</span>}</td>
                  <td>{online && <Link to={`/trades/${t.id}`}>Review</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="stack">
          {trades.map((t) => (
            <Link key={t.id} to={online ? `/trades/${t.id}` : '#'} className="card trade-row">
              <div className="row between">
                <span className="row">
                  <span className={`badge ${t.direction === 'LONG' ? 'long' : 'short'}`}>{t.direction === 'LONG' ? 'Long' : 'Short'}</span>
                  <b>{t.instrumentName}</b>
                  <span className="small muted num">{grams(t.qty)}</span>
                </span>
                <span className={`num bold ${signClass(t.netPnl)}`}>{points(t.netPnl, { sign: true })}</span>
              </div>
              <div className="row between small muted" style={{ marginTop: 4 }}>
                <span>{dateTime(t.exitTs)} · {duration(t.holdingSeconds)} · {EXIT_REASONS[t.exitReason] ?? t.exitReason}</span>
                <span className={`num ${signClass(t.rMultiple)}`}>{rMult(t.rMultiple)}</span>
              </div>
              <div className="row wrap" style={{ marginTop: 6 }}>
                {t.setupTag && <span className="badge">{t.setupTag}</span>}
                {t.flags.slice(0, 2).map((f) => <span key={f.code} className="badge warn">{f.title}</span>)}
                {t.flags.length > 2 && <span className="badge warn">+{t.flags.length - 2}</span>}
                {t.tags.map((tag) => <span key={tag} className="badge">#{tag}</span>)}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
