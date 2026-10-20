import { useMode } from '../state/app';

export function ModeSwitch() {
  const { mode, setMode } = useMode();
  return (
    <div className="page-header">
      <h1 className="sr-only">Trade</h1>
      <div className="segmented mode-switch" role="radiogroup" aria-label="Mode">
        <button className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')} aria-pressed={mode === 'live'}>Live</button>
        <button className={mode === 'replay' ? 'active' : ''} onClick={() => setMode('replay')} aria-pressed={mode === 'replay'}>Replay</button>
      </div>
    </div>
  );
}
