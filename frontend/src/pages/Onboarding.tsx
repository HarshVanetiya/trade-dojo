import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../state/app';

const SCREENS = [
  {
    art: '🪙',
    title: 'Points, not money',
    body: [
      'You get a fixed 1,00,000 points. One point behaves like ₹1 of buying power, so the numbers feel real.',
      'Points can’t be bought, topped up or cashed out. If you lose most of them you can start a new season, but only once a week, so treat them with care.',
    ],
  },
  {
    art: '↕️',
    title: 'Long and short',
    body: [
      'Going LONG means buy first, sell later: you profit when the price rises.',
      'Going SHORT means sell first, buy back later: you profit when the price falls. MCX futures let you do either with one tap.',
    ],
  },
  {
    art: '🛡️',
    title: 'Stop-loss and target',
    body: [
      'Before every trade, decide where you are wrong (stop-loss) and where you take profit (target).',
      'The order ticket shows how many points you risk and your reward-to-risk. A good habit: risk 1-2% of your account per trade.',
    ],
  },
  {
    art: '🔍',
    title: 'Every trade gets a review',
    body: [
      'When a trade closes you get a review: R-multiple, best and worst moments, what-ifs, and coaching flags like “moved stop further away”.',
      'Your Stats page shows your top habits to fix. Practise live during MCX hours or replay past days anytime.',
    ],
  },
];

export function OnboardingPage() {
  const [i, setI] = useState(0);
  const nav = useNavigate();
  const { setUser, user } = useAuth();
  const finish = async (guided: boolean) => {
    try {
      const r = await api('/me', { method: 'PATCH', body: { onboarded: true } });
      setUser(r.user);
    } catch {
      if (user) setUser({ ...user, onboarded: true });
    }
    nav(guided ? '/?guide=1' : '/');
  };
  const s = SCREENS[i];
  const last = i === SCREENS.length - 1;
  return (
    <div className="onboard">
      <div className="row between">
        <span className="small muted">{i + 1} of {SCREENS.length}</span>
        <button className="btn ghost small" onClick={() => finish(false)}>Skip</button>
      </div>
      <div className="body">
        <div className="art" aria-hidden="true">{s.art}</div>
        <h1 className="center">{s.title}</h1>
        {s.body.map((p) => (
          <p key={p} className="muted" style={{ fontSize: 16 }}>{p}</p>
        ))}
      </div>
      <div className="dots" aria-hidden="true">
        {SCREENS.map((_, k) => (
          <span key={k} className={k === i ? 'on' : ''} />
        ))}
      </div>
      {last ? (
        <div className="col">
          <button className="btn primary block" onClick={() => finish(true)}>Guide me through my first trade</button>
          <button className="btn block" onClick={() => finish(false)}>I’ll explore on my own</button>
        </div>
      ) : (
        <div className="row">
          {i > 0 && <button className="btn grow" onClick={() => setI(i - 1)}>Back</button>}
          <button className="btn primary grow" onClick={() => setI(i + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
