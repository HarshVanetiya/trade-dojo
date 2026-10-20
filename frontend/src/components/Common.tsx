import type { ReactNode } from 'react';
import { timeAgo } from '../lib/format';

export const DISCLAIMER =
  'TradeDojo is an educational simulator. Points have no monetary value and cannot be bought, sold, or redeemed. Prices come from MCX futures data via Upstox and may be delayed or interrupted. Simulated fills may differ from real execution. Nothing in this app is investment advice.';

export function Disclaimer() {
  return <p className="disclaimer">{DISCLAIMER}</p>;
}

export function Empty({ icon, title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="icon" aria-hidden="true">{icon}</div>}
      <h3>{title}</h3>
      {children && <p className="small">{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} />;
}

export function SourceNote({ ts, provider }: { ts?: number | string | null; provider?: string }) {
  return (
    <span className="tiny faint">
      {provider === 'replay' ? 'Historical MCX data via Upstox · replay clock shown above' : <>Market data: {provider === 'mock' ? 'simulated (mock provider)' : 'MCX via Upstox'} · updated {timeAgo(ts ?? null)}</>}
    </span>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="banner danger" role="alert">{error}</div>;
}
