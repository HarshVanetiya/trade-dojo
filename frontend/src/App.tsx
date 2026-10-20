import { lazy, Suspense, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { GlossaryProvider } from './components/Glossary';
import { Layout } from './components/Layout';
import { AccountPage } from './pages/Account';
import { LoginPage, SignupPage } from './pages/Auth';
import { OnboardingPage } from './pages/Onboarding';
import { useOnline } from './pwa';
import { AuthProvider, MarketFeed, ModeProvider, ThemeProvider, ToastProvider, useAuth } from './state/app';

const TradePage = lazy(() => import('./pages/Trade').then((m) => ({ default: m.TradePage })));
const PositionsPage = lazy(() => import('./pages/Positions').then((m) => ({ default: m.PositionsPage })));
const JournalPage = lazy(() => import('./pages/Journal').then((m) => ({ default: m.JournalPage })));
const TradeReviewPage = lazy(() => import('./pages/TradeReview').then((m) => ({ default: m.TradeReviewPage })));
const StatsPage = lazy(() => import('./pages/Stats').then((m) => ({ default: m.StatsPage })));
const AdminPage = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminPage })));

function Loading() {
  return (
    <div className="page">
      <div className="skeleton" style={{ height: 28, width: 160, marginBottom: 16 }} />
      <div className="skeleton" style={{ height: 240 }} />
    </div>
  );
}

function OfflineScreen() {
  return (
    <div className="offline-screen">
      <div style={{ fontSize: 48 }} aria-hidden="true">📡</div>
      <h1>You’re offline</h1>
      <p className="muted">Prices and trading need a connection. Your journal is available.</p>
      <Link className="btn primary" to="/journal">Open journal</Link>
    </div>
  );
}

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  const online = useOnline();
  if (!online && !loc.pathname.startsWith('/journal')) return <OfflineScreen />;
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (!user.onboarded && loc.pathname !== '/welcome') return <Navigate to="/welcome" replace />;
  return <>{children}</>;
}

function Guest({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <ModeProvider>
            <GlossaryProvider>
              <MarketFeed />
              <Suspense fallback={<Loading />}>
                <Routes>
                  <Route path="/login" element={<Guest><LoginPage /></Guest>} />
                  <Route path="/signup" element={<Guest><SignupPage /></Guest>} />
                  <Route path="/welcome" element={<Protected><OnboardingPage /></Protected>} />
                  <Route element={<Protected><Layout /></Protected>}>
                    <Route index element={<TradePage />} />
                    <Route path="positions" element={<PositionsPage />} />
                    <Route path="journal" element={<JournalPage />} />
                    <Route path="trades/:id" element={<TradeReviewPage />} />
                    <Route path="stats" element={<StatsPage />} />
                    <Route path="account" element={<AccountPage />} />
                    <Route path="admin" element={<AdminPage />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            </GlossaryProvider>
          </ModeProvider>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
