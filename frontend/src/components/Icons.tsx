// Inline stroke icons (no icon font, nothing to download).
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const IconTrade = () => (
  <svg viewBox="0 0 24 24" {...P} aria-hidden="true"><path d="M7 4v16M7 8H5v8h2M17 4v16M17 6h-2v6h2M12 7v12M12 10h-2v5h2" /></svg>
);
export const IconPositions = () => (
  <svg viewBox="0 0 24 24" {...P} aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M8 15h3" /></svg>
);
export const IconJournal = () => (
  <svg viewBox="0 0 24 24" {...P} aria-hidden="true"><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4z" /><path d="M9 8h6M9 12h6M5 17a3 3 0 0 1 3-3h11" /></svg>
);
export const IconStats = () => (
  <svg viewBox="0 0 24 24" {...P} aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
);
export const IconAccount = () => (
  <svg viewBox="0 0 24 24" {...P} aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
);
export const IconAdmin = () => (
  <svg viewBox="0 0 24 24" {...P} aria-hidden="true"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z" /><path d="M9 12l2 2 4-4" /></svg>
);
export const IconClose = () => (
  <svg viewBox="0 0 24 24" {...P} width="22" height="22" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconInfo = () => (
  <svg viewBox="0 0 24 24" {...P} width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
);
export const IconPlay = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true"><path d="M7 5l12 7-12 7z" /></svg>
);
export const IconPause = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
);
export const IconStep = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true"><path d="M5 5l10 7-10 7zM16 5h3v14h-3z" /></svg>
);
