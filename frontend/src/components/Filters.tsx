import { SETUP_TAGS, type Mode } from '../lib/types';
import { useInstruments } from '../state/marketStore';

export interface TradeFilters {
  mode: Mode;
  season: string; // 'current' | 'all' | number
  instrument: string;
  setupTag: string;
  direction: string;
  result: string;
  from: string;
  to: string;
  tag: string;
}

export const DEFAULT_FILTERS: TradeFilters = { mode: 'live', season: 'current', instrument: '', setupTag: '', direction: '', result: '', from: '', to: '', tag: '' };

export function FilterBar({ value, onChange, seasons, show = ['mode', 'season', 'instrument', 'setupTag', 'direction', 'result', 'dates', 'tag'] }: {
  value: TradeFilters;
  onChange: (f: TradeFilters) => void;
  seasons?: number[];
  show?: string[];
}) {
  const instruments = useInstruments();
  const set = (patch: Partial<TradeFilters>) => onChange({ ...value, ...patch });
  return (
    <div className="filters">
      {show.includes('mode') && (
        <div className="segmented">
          {(['live', 'replay'] as Mode[]).map((m) => (
            <button key={m} className={value.mode === m ? 'active' : ''} onClick={() => set({ mode: m, season: 'current' })}>{m === 'live' ? 'Live' : 'Replay'}</button>
          ))}
        </div>
      )}
      <div className="filter-grid">
        {show.includes('season') && (
          <select aria-label="Season" value={value.season} onChange={(e) => set({ season: e.target.value })}>
            <option value="current">Current season</option>
            <option value="all">All seasons</option>
            {(seasons ?? []).map((s) => <option key={s} value={String(s)}>Season {s}</option>)}
          </select>
        )}
        {show.includes('instrument') && (
          <select aria-label="Instrument" value={value.instrument} onChange={(e) => set({ instrument: e.target.value })}>
            <option value="">All instruments</option>
            {instruments.map((i) => <option key={i.code} value={i.code}>{i.name}</option>)}
          </select>
        )}
        {show.includes('setupTag') && (
          <select aria-label="Setup" value={value.setupTag} onChange={(e) => set({ setupTag: e.target.value })}>
            <option value="">All setups</option>
            {SETUP_TAGS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        {show.includes('direction') && (
          <select aria-label="Direction" value={value.direction} onChange={(e) => set({ direction: e.target.value })}>
            <option value="">Long & short</option>
            <option value="LONG">Long only</option>
            <option value="SHORT">Short only</option>
          </select>
        )}
        {show.includes('result') && (
          <select aria-label="Result" value={value.result} onChange={(e) => set({ result: e.target.value })}>
            <option value="">Wins & losses</option>
            <option value="win">Wins</option>
            <option value="loss">Losses</option>
          </select>
        )}
        {show.includes('dates') && (
          <>
            <input type="date" aria-label="From date" value={value.from} onChange={(e) => set({ from: e.target.value })} />
            <input type="date" aria-label="To date" value={value.to} onChange={(e) => set({ to: e.target.value })} />
          </>
        )}
        {show.includes('tag') && <input aria-label="Your tag" placeholder="Your tag" value={value.tag} onChange={(e) => set({ tag: e.target.value.trim() })} />}
      </div>
    </div>
  );
}

export const filterQuery = (f: TradeFilters) => ({
  mode: f.mode,
  season: f.season,
  instrument: f.instrument || undefined,
  setupTag: f.setupTag || undefined,
  direction: f.direction || undefined,
  result: f.result || undefined,
  from: f.from || undefined,
  to: f.to || undefined,
  tag: f.tag || undefined,
});
