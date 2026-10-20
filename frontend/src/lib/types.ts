export type Mode = 'live' | 'replay';
export type Direction = 'LONG' | 'SHORT';

export interface User {
  id: number;
  name: string;
  email: string;
  role: 'user' | 'admin';
  onboarded: boolean;
}

export interface Account {
  id: number;
  mode: Mode;
  season: number;
  startingPoints: number;
  pointsFree: number;
  pointsUsed: number;
  unrealized: number;
  equity: number;
}

export interface MarketStatus {
  open: boolean;
  reason: string;
  opensAt: string | null;
  closesAt: string | null;
  stale: boolean;
  lastTickAt: string | null;
  liveAvailable: boolean;
  alwaysOpen: boolean;
  provider: string;
  holiday?: string;
}

export interface Quote {
  instrument: string;
  contract: string | null;
  ltp: number;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  oi: number | null;
  ts: number;
}

export interface Instrument {
  id: number;
  code: string;
  name: string;
  underlying: string;
  product: string;
  priceUnitLabel: string;
  unitGrams: number;
  qtyUnit?: string;
  qtyStep: number;
  qtyMin: number;
  qtyMax: number;
  spreadPaise: number;
  brokeragePaise: number;
  tickSizePaise: number;
  contract: { id: number; symbol: string; key: string; expiry: string; rolloverDate: string; daysToExpiry: number } | null;
  market: MarketStatus;
  quote: Quote | null;
}

export interface Depth {
  instrument: string;
  bids: Array<{ price: number; qty: number }>;
  asks: Array<{ price: number; qty: number }>;
  spread: number | null;
  ts: number;
}

export interface Candle {
  openTime: number;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
  oi: number | null;
  contract?: string;
  stitch?: boolean;
}

export interface Position {
  id: number;
  mode: Mode;
  replaySessionId: number | null;
  instrument: string;
  instrumentName: string;
  priceUnitLabel: string;
  unitGrams: number;
  contract: { symbol: string; expiry: string; rolloverDate: string } | null;
  direction: Direction;
  status: 'open' | 'closed';
  qtyInitial: number;
  qtyOpen: number;
  avgEntry: number;
  slPrice: number | null;
  tpPrice: number | null;
  trailPaise: number | null;
  pointsUsed: number;
  realizedPnl: number;
  brokerage: number;
  markPrice: number | null;
  unrealizedPnl: number;
  setupTag: string | null;
  planNote: string | null;
  confidence: number | null;
  openedAt: string;
  closedAt: string | null;
  exitReason: string | null;
  rolloverNotice: string | null;
}

export interface Order {
  id: number;
  mode: Mode;
  instrument?: string;
  direction: Direction;
  orderType: 'MARKET' | 'LIMIT' | 'STOP';
  qty: number;
  triggerPrice: number | null;
  slPrice: number | null;
  tpPrice: number | null;
  status: string;
  cancelReason: string | null;
  createdAt: string;
  pointsReserved: number;
}

export interface Trade {
  id: number;
  mode: Mode;
  season: number;
  instrument: string;
  instrumentName: string;
  priceUnitLabel: string;
  unitGrams: number;
  contract: string | null;
  direction: Direction;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryTs: string;
  exitTs: string;
  holdingSeconds: number;
  grossPnl: number;
  brokerage: number;
  netPnl: number;
  pnlPct: number;
  initialSl: number | null;
  initialTp: number | null;
  initialRisk: number | null;
  rMultiple: number | null;
  plannedRr: number | null;
  riskPct: number | null;
  exitReason: string;
  setupTag: string | null;
  planNote: string | null;
  confidence: number | null;
  gapExit: boolean;
  bothTouched: boolean;
  flags: Array<{ code: string; title: string }>;
  reflection: string;
  tags: string[];
}

export const SETUP_TAGS = ['Breakout', 'Pullback', 'Trend-follow', 'Reversal', 'News', 'Other'] as const;

export const EXIT_REASONS: Record<string, string> = {
  manual: 'Closed by you',
  stop_loss: 'Stop-loss',
  trailing_stop: 'Trailing stop',
  target: 'Target',
  rollover: 'Contract rollover',
  session_end: 'Replay ended',
};
