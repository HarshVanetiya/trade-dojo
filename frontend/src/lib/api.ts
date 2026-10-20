// API client. The backend runs on port 4000 of the same host by default so phones on the
// same Wi-Fi work without configuration; VITE_API_URL overrides it (e.g. in production).

export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || `${location.protocol}//${location.hostname}:4000`;
export const WS_URL = `${API_URL.replace(/^http/, 'ws')}/ws`;

const TOKEN_KEY = 'td-token';

// sessionStorage (not localStorage) so each browser tab can be logged in as a different user during demos.
export const tokenStore = {
  get: (): string | null => {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; query?: Query; raw?: boolean } = {}): Promise<T> {
  const url = new URL(`${API_URL}/api${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'network', navigator.onLine ? 'Cannot reach the TradeDojo server. Is the backend running?' : 'You are offline.');
  }
  if (opts.raw) {
    if (!res.ok) throw new ApiError(res.status, 'http_error', `Request failed (${res.status})`);
    return res as unknown as T;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = data?.error ?? {};
    if (res.status === 401 && token) {
      tokenStore.clear();
      window.dispatchEvent(new Event('td-logout'));
    }
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `Request failed (${res.status})`, err.details);
  }
  return data as T;
}

export async function downloadFile(path: string, query: Query, filename: string) {
  const res = await api<Response>(path, { query, raw: true });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
