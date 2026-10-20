import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, tokenStore } from '../lib/api';
import { points } from '../lib/format';
import type { Account, Mode, User } from '../lib/types';
import { socket } from '../lib/ws';
import { marketStore } from './marketStore';

// ---------------- theme ----------------
export type ThemePref = 'system' | 'light' | 'dark';
const ThemeCtx = createContext<{ pref: ThemePref; setPref: (p: ThemePref) => void }>({ pref: 'system', setPref: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => {
    try {
      return (localStorage.getItem('td-theme') as ThemePref) || 'system';
    } catch {
      return 'system';
    }
  });
  const setPref = (p: ThemePref) => {
    setPrefState(p);
    try {
      if (p === 'system') localStorage.removeItem('td-theme');
      else localStorage.setItem('td-theme', p);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    const root = document.documentElement;
    if (pref === 'system') delete root.dataset.theme;
    else root.dataset.theme = pref;
    const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d121b' : '#f6f7f9');
  }, [pref]);
  return <ThemeCtx.Provider value={{ pref, setPref }}>{children}</ThemeCtx.Provider>;
}
export const useTheme = () => useContext(ThemeCtx);

/** Resolved dark/light (for the chart, which needs concrete colours). */
export function useIsDark() {
  const { pref } = useTheme();
  const [sysDark, setSysDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const fn = () => setSysDark(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return pref === 'dark' || (pref === 'system' && sysDark);
}

// ---------------- toasts ----------------
export interface Toast {
  id: number;
  title: string;
  body?: string;
  kind?: 'info' | 'profit' | 'loss' | 'warn' | 'error';
  action?: { label: string; href: string };
}
const ToastCtx = createContext<{ push: (t: Omit<Toast, 'id'>) => void }>({ push: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++idRef.current;
    setToasts((xs) => [...xs.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.kind === 'error' ? 6000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind ?? 'info'}`} onClick={() => setToasts((xs) => xs.filter((x) => x.id !== t.id))}>
            <div className="t-title">{t.title}</div>
            {t.body && <div className="small muted">{t.body}</div>}
            {t.action && (
              <a className="small bold" href={t.action.href}>
                {t.action.label} →
              </a>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx).push;

// ---------------- auth ----------------
export interface PublicSettings {
  startingPoints: number;
  riskWarnPct: number;
  resetThresholdPct: number;
  resetCooldownDays: number;
  leaderboardEnabled: boolean;
  leaderboardMinTrades: number;
  aiCoachEnabled: boolean;
  setupTags: string[];
}

interface AuthState {
  user: User | null;
  account: Account | null;
  settings: PublicSettings | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  setUser: (u: User) => void;
}
const AuthCtx = createContext<AuthState>(null as unknown as AuthState);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [loading, setLoading] = useState(!!tokenStore.get());

  const refresh = useCallback(async () => {
    if (!tokenStore.get()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const [me, s] = await Promise.all([api<{ user: User; account: Account }>('/me'), api<PublicSettings>('/settings/public')]);
      setUser(me.user);
      setAccount(me.account);
      setSettings(s);
    } catch {
      /* 401 handled via td-logout; offline keeps the old state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onLogout = () => {
      setUser(null);
      setAccount(null);
      socket.stop();
    };
    window.addEventListener('td-logout', onLogout);
    return () => window.removeEventListener('td-logout', onLogout);
  }, [refresh]);

  useEffect(() => {
    if (!user) return;
    socket.start();
    const offs = [
      socket.on('account', (a: Account) => {
        if (a.mode === 'live') setAccount(a);
        window.dispatchEvent(new CustomEvent('td-account', { detail: a }));
      }),
    ];
    return () => {
      offs.forEach((f) => f());
      socket.stop();
    };
  }, [user]);

  const login = async (email: string, password: string) => {
    const res = await api<{ token: string; user: User }>('/auth/login', { body: { email, password } });
    tokenStore.set(res.token);
    setLoading(true);
    await refresh();
  };
  const signup = async (name: string, email: string, password: string) => {
    const res = await api<{ token: string; user: User }>('/auth/signup', { body: { name, email, password, acceptTerms: true } });
    tokenStore.set(res.token);
    setLoading(true);
    await refresh();
  };
  const logout = () => {
    void api('/auth/logout', { method: 'POST' }).catch(() => {});
    tokenStore.clear();
    setUser(null);
    setAccount(null);
    socket.stop();
  };

  return <AuthCtx.Provider value={{ user, account, settings, loading, login, signup, logout, refresh, setUser }}>{children}</AuthCtx.Provider>;
}
export const useAuth = () => useContext(AuthCtx);

// ---------------- mode (live / replay) ----------------
interface ModeState {
  mode: Mode;
  setMode: (m: Mode) => void;
  replaySessionId: number | null;
  setReplaySessionId: (id: number | null) => void;
}
const ModeCtx = createContext<ModeState>(null as unknown as ModeState);

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(() => (sessionStorage.getItem('td-mode') as Mode) || 'live');
  const [replaySessionId, setRid] = useState<number | null>(() => Number(sessionStorage.getItem('td-replay')) || null);
  const setMode = (m: Mode) => {
    setModeState(m);
    sessionStorage.setItem('td-mode', m);
  };
  const setReplaySessionId = (id: number | null) => {
    setRid(id);
    if (id) sessionStorage.setItem('td-replay', String(id));
    else sessionStorage.removeItem('td-replay');
  };
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
  }, [mode]);
  const value = useMemo(() => ({ mode, setMode, replaySessionId, setReplaySessionId }), [mode, replaySessionId]);
  return <ModeCtx.Provider value={value}>{children}</ModeCtx.Provider>;
}
export const useMode = () => useContext(ModeCtx);

// ---------------- live market feed + event toasts ----------------
export function MarketFeed() {
  const { user } = useAuth();
  const toast = useToast();
  useEffect(() => {
    if (!user) return;
    let alive = true;
    const load = () =>
      api('/instruments')
        .then((r) => alive && marketStore.setInstruments(r.instruments))
        .catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    const offs = [
      socket.on('tick', (q) => marketStore.setQuote(q)),
      socket.on('depth', (d) => marketStore.setDepth(d)),
      socket.on('market_status', (s) => marketStore.setStatus(s.instrument, s)),
      socket.on('fill', (f) => {
        const pnlText = f.realizedPnl !== null && f.realizedPnl !== undefined ? ` · ${points(f.realizedPnl, { sign: true })}` : '';
        const kind = f.reason === 'entry' ? 'info' : f.realizedPnl > 0 ? 'profit' : f.realizedPnl < 0 ? 'loss' : 'info';
        toast({ title: `${f.title}: ${f.instrument} ${f.direction === 'LONG' ? 'long' : 'short'}${f.mode === 'replay' ? ' (replay)' : ''}`, body: `Price ₹${(f.price / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}${pnlText}`, kind });
        window.dispatchEvent(new CustomEvent('td-trading'));
      }),
      socket.on('order', (o) => {
        if (o.status === 'rejected' || (o.status === 'cancelled' && o.cancelReason && !o.cancelReason.startsWith('Cancelled by you'))) {
          toast({ title: `Order ${o.status}`, body: o.cancelReason ?? undefined, kind: 'warn' });
        }
        window.dispatchEvent(new CustomEvent('td-trading'));
      }),
      socket.on('position', () => window.dispatchEvent(new CustomEvent('td-trading'))),
      socket.on('rollover', (r) => {
        if (r.message) toast({ title: r.notice ? 'Contract rollover coming up' : 'Contract rolled over', body: r.message, kind: 'warn' });
        else toast({ title: `${r.instrument} now tracks ${r.to}`, body: `Rolled over from ${r.from}.`, kind: 'info' });
        void load();
        window.dispatchEvent(new CustomEvent('td-trading'));
      }),
      socket.on('review_ready', (r) => {
        toast({ title: 'Trade review ready', body: r.flags?.length ? `${r.flags.length} thing(s) to look at` : 'Clean trade. See how it went.', kind: 'info', action: { label: 'Open review', href: `/trades/${r.tradeId}` } });
      }),
    ];
    return () => {
      alive = false;
      clearInterval(t);
      offs.forEach((f) => f());
    };
  }, [user, toast]);
  return null;
}

/** Re-run a callback when trading events arrive (fills, orders, positions). */
export function useTradingRefresh(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = () => ref.current();
    window.addEventListener('td-trading', h);
    return () => window.removeEventListener('td-trading', h);
  }, []);
}
