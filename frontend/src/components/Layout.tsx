import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../state/app';
import { IconAccount, IconAdmin, IconJournal, IconPositions, IconStats, IconTrade } from './Icons';

const NAV = [
  { to: '/', label: 'Trade', icon: <IconTrade />, end: true },
  { to: '/positions', label: 'Positions', icon: <IconPositions /> },
  { to: '/journal', label: 'Journal', icon: <IconJournal /> },
  { to: '/stats', label: 'Stats', icon: <IconStats /> },
  { to: '/account', label: 'Account', icon: <IconAccount /> },
];

export function Layout() {
  const { user } = useAuth();
  const items = user?.role === 'admin' ? [...NAV, { to: '/admin', label: 'Admin', icon: <IconAdmin /> }] : NAV;
  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <img src="/favicon.svg" alt="" width="28" height="28" /> TradeDojo
        </div>
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>
            {n.icon}
            {n.label}
          </NavLink>
        ))}
        <div className="spacer" />
        <div className="tiny faint" style={{ padding: '0 10px' }}>Practice only. Points have no cash value.</div>
      </nav>
      <main>
        <Outlet />
      </main>
      <nav className="bottom-nav" aria-label="Main">
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>
            {n.icon}
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
