import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Disclaimer, ErrorText } from '../components/Common';
import { useAuth } from '../state/app';

function Brand() {
  return (
    <div className="brand-row">
      <img src="/favicon.svg" alt="" />
      TradeDojo
    </div>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      nav('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap">
      <form className="card auth-card stack" onSubmit={submit}>
        <Brand />
        <h1>Welcome back</h1>
        <p className="muted">Practise trading MCX gold and silver with virtual points.</p>
        <ErrorText error={error} />
        <label className="field">
          Email
          <input type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button className="btn primary block" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
        <p className="small center">
          New here? <Link to="/signup">Create a free practice account</Link>
        </p>
        <p className="tiny faint center">Each browser tab keeps its own login, so you can demo several users side by side.</p>
      </form>
    </div>
  );
}

export function SignupPage() {
  const { signup } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (!accept) return setError('Please read and accept the terms below.');
    setBusy(true);
    setError(null);
    try {
      await signup(name, email, password);
      nav('/welcome');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap">
      <form className="card auth-card stack" onSubmit={submit}>
        <Brand />
        <h1>Create your practice account</h1>
        <p className="muted">You start with <b>1,00,000 points</b> of simulated buying power. No real money, ever.</p>
        <ErrorText error={error} />
        <label className="field">
          Name
          <input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </label>
        <label className="field">
          Email
          <input type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          Password (at least 8 characters)
          <input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <Disclaimer />
        <label className="checkbox">
          <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          <span>I understand points are not money: they can’t be bought, sold or redeemed, and the starting balance is fixed.</span>
        </label>
        <button className="btn primary block" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        <p className="small center">
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </form>
    </div>
  );
}
