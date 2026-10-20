-- TradeDojo initial schema. All money and prices are BIGINT paise.

CREATE TABLE users (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  disabled          BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  verify_token      TEXT,
  onboarded         BOOLEAN NOT NULL DEFAULT FALSE,
  token_version     INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT REFERENCES users(id)
);

CREATE TABLE instruments (
  id                     SERIAL PRIMARY KEY,
  code                   TEXT NOT NULL UNIQUE,
  display_name           TEXT NOT NULL,
  underlying             TEXT NOT NULL CHECK (underlying IN ('GOLD', 'SILVER')),
  product_symbol         TEXT NOT NULL,
  price_unit_label       TEXT NOT NULL,
  unit_grams             INTEGER NOT NULL CHECK (unit_grams > 0),
  qty_unit               TEXT NOT NULL DEFAULT 'g',
  qty_step               INTEGER NOT NULL CHECK (qty_step > 0),
  qty_min                INTEGER NOT NULL CHECK (qty_min > 0),
  qty_max                INTEGER NOT NULL DEFAULT 100000 CHECK (qty_max > 0),
  fallback_spread_paise  BIGINT NOT NULL DEFAULT 0 CHECK (fallback_spread_paise >= 0),
  brokerage_paise        BIGINT NOT NULL DEFAULT 0 CHECK (brokerage_paise >= 0),
  tick_size_paise        BIGINT NOT NULL DEFAULT 100 CHECK (tick_size_paise > 0),
  enabled                BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order             INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE contracts (
  id              SERIAL PRIMARY KEY,
  instrument_id   INTEGER NOT NULL REFERENCES instruments(id),
  instrument_key  TEXT NOT NULL UNIQUE,
  product         TEXT NOT NULL,
  trading_symbol  TEXT NOT NULL,
  underlying_key  TEXT,
  expiry          DATE NOT NULL,
  lot_size        INTEGER,
  tick_size_paise BIGINT,
  is_active       BOOLEAN NOT NULL DEFAULT FALSE,
  is_expired      BOOLEAN NOT NULL DEFAULT FALSE,
  rollover_date   DATE NOT NULL,
  activated_at    TIMESTAMPTZ,
  deactivated_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contracts_one_active_idx ON contracts (instrument_id) WHERE is_active;
CREATE INDEX contracts_instrument_expiry_idx ON contracts (instrument_id, expiry);

CREATE TABLE market_holidays (
  id             SERIAL PRIMARY KEY,
  date           DATE NOT NULL UNIQUE,
  description    TEXT NOT NULL DEFAULT '',
  closed         BOOLEAN NOT NULL DEFAULT TRUE,
  special_open   TIME,
  special_close  TIME
);

CREATE TABLE price_ticks (
  id             BIGSERIAL PRIMARY KEY,
  instrument_id  INTEGER NOT NULL REFERENCES instruments(id),
  contract_id    INTEGER NOT NULL REFERENCES contracts(id),
  ltp            BIGINT NOT NULL,
  bid            BIGINT,
  ask            BIGINT,
  volume         BIGINT,
  oi             BIGINT,
  ts             TIMESTAMPTZ NOT NULL
);
CREATE INDEX price_ticks_instrument_ts_idx ON price_ticks (instrument_id, ts);
CREATE INDEX price_ticks_ts_idx ON price_ticks (ts);

CREATE TABLE candles (
  instrument_id  INTEGER NOT NULL REFERENCES instruments(id),
  contract_id    INTEGER NOT NULL REFERENCES contracts(id),
  interval       TEXT NOT NULL CHECK (interval IN ('1m', '1d')),
  open_time      TIMESTAMPTZ NOT NULL,
  o              BIGINT NOT NULL,
  h              BIGINT NOT NULL,
  l              BIGINT NOT NULL,
  c              BIGINT NOT NULL,
  volume         BIGINT NOT NULL DEFAULT 0,
  oi             BIGINT,
  source         TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'history', 'mock')),
  PRIMARY KEY (contract_id, interval, open_time),
  CHECK (h >= l)
);
CREATE INDEX candles_instrument_interval_time_idx ON candles (instrument_id, interval, open_time);

CREATE TABLE accounts (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id),
  mode             TEXT NOT NULL CHECK (mode IN ('live', 'replay')),
  season           INTEGER NOT NULL DEFAULT 1,
  starting_points  BIGINT NOT NULL CHECK (starting_points > 0),
  cash_available   BIGINT NOT NULL CHECK (cash_available >= 0),
  cash_reserved    BIGINT NOT NULL DEFAULT 0 CHECK (cash_reserved >= 0),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at        TIMESTAMPTZ,
  UNIQUE (user_id, mode, season)
);
CREATE UNIQUE INDEX accounts_one_active_idx ON accounts (user_id, mode) WHERE is_active;

CREATE TABLE replay_sessions (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  account_id     BIGINT NOT NULL REFERENCES accounts(id),
  instrument_id  INTEGER NOT NULL REFERENCES instruments(id),
  from_ts        TIMESTAMPTZ NOT NULL,
  to_ts          TIMESTAMPTZ NOT NULL,
  current_ts     TIMESTAMPTZ NOT NULL,
  step_interval  TEXT NOT NULL CHECK (step_interval IN ('1m', '5m', '15m', '1h', '1d')),
  speed          INTEGER NOT NULL DEFAULT 1 CHECK (speed IN (1, 5, 20, 100)),
  status         TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('paused', 'playing', 'ended')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at       TIMESTAMPTZ,
  CHECK (to_ts > from_ts),
  CHECK (current_ts >= from_ts AND current_ts <= to_ts)
);
CREATE INDEX replay_sessions_user_idx ON replay_sessions (user_id, created_at DESC);

CREATE TABLE positions (
  id                 BIGSERIAL PRIMARY KEY,
  account_id         BIGINT NOT NULL REFERENCES accounts(id),
  user_id            BIGINT NOT NULL REFERENCES users(id),
  mode               TEXT NOT NULL CHECK (mode IN ('live', 'replay')),
  replay_session_id  BIGINT REFERENCES replay_sessions(id),
  instrument_id      INTEGER NOT NULL REFERENCES instruments(id),
  contract_id        INTEGER REFERENCES contracts(id),
  direction          TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  qty_initial_g      BIGINT NOT NULL CHECK (qty_initial_g > 0),
  qty_open_g         BIGINT NOT NULL CHECK (qty_open_g >= 0),
  avg_entry_price    BIGINT NOT NULL CHECK (avg_entry_price > 0),
  reserved_paise     BIGINT NOT NULL DEFAULT 0 CHECK (reserved_paise >= 0),
  sl_price           BIGINT,
  tp_price           BIGINT,
  initial_sl_price   BIGINT,
  initial_tp_price   BIGINT,
  trail_paise        BIGINT CHECK (trail_paise IS NULL OR trail_paise > 0),
  best_price         BIGINT NOT NULL,
  worst_price        BIGINT NOT NULL,
  realized_pnl       BIGINT NOT NULL DEFAULT 0,
  brokerage_total    BIGINT NOT NULL DEFAULT 0,
  exit_qty_g         BIGINT NOT NULL DEFAULT 0,
  exit_value         BIGINT NOT NULL DEFAULT 0,
  setup_tag          TEXT,
  plan_note          TEXT,
  confidence         SMALLINT CHECK (confidence BETWEEN 1 AND 5),
  order_id           BIGINT,
  opened_at          TIMESTAMPTZ NOT NULL,
  closed_at          TIMESTAMPTZ,
  exit_reason        TEXT,
  had_gap_exit       BOOLEAN NOT NULL DEFAULT FALSE,
  rollover_notified  BOOLEAN NOT NULL DEFAULT FALSE,
  last_price         BIGINT,
  last_price_at      TIMESTAMPTZ
);
CREATE INDEX positions_user_status_idx ON positions (user_id, status, opened_at DESC);
CREATE INDEX positions_open_instrument_idx ON positions (instrument_id, mode) WHERE status = 'open';

CREATE TABLE position_events (
  id           BIGSERIAL PRIMARY KEY,
  position_id  BIGINT NOT NULL REFERENCES positions(id),
  kind         TEXT NOT NULL,
  old_value    BIGINT,
  new_value    BIGINT,
  note         TEXT,
  ts           TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX position_events_position_idx ON position_events (position_id, ts);

CREATE TABLE orders (
  id                 BIGSERIAL PRIMARY KEY,
  account_id         BIGINT NOT NULL REFERENCES accounts(id),
  user_id            BIGINT NOT NULL REFERENCES users(id),
  mode               TEXT NOT NULL CHECK (mode IN ('live', 'replay')),
  replay_session_id  BIGINT REFERENCES replay_sessions(id),
  instrument_id      INTEGER NOT NULL REFERENCES instruments(id),
  contract_id        INTEGER REFERENCES contracts(id),
  direction          TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  order_type         TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT', 'STOP')),
  qty_g              BIGINT NOT NULL CHECK (qty_g > 0),
  trigger_price      BIGINT CHECK (trigger_price IS NULL OR trigger_price > 0),
  sl_price           BIGINT,
  tp_price           BIGINT,
  trail_paise        BIGINT,
  reserved_paise     BIGINT NOT NULL DEFAULT 0 CHECK (reserved_paise >= 0),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'filled', 'cancelled', 'rejected')),
  setup_tag          TEXT,
  plan_note          TEXT,
  confidence         SMALLINT CHECK (confidence BETWEEN 1 AND 5),
  position_id        BIGINT REFERENCES positions(id),
  cancel_reason      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  market_ts          TIMESTAMPTZ NOT NULL,
  filled_at          TIMESTAMPTZ,
  cancelled_at       TIMESTAMPTZ
);
CREATE INDEX orders_user_status_idx ON orders (user_id, status, created_at DESC);
CREATE INDEX orders_pending_idx ON orders (instrument_id, mode) WHERE status = 'pending';

CREATE TABLE fills (
  id                 BIGSERIAL PRIMARY KEY,
  account_id         BIGINT NOT NULL REFERENCES accounts(id),
  user_id            BIGINT NOT NULL REFERENCES users(id),
  position_id        BIGINT NOT NULL REFERENCES positions(id),
  order_id           BIGINT REFERENCES orders(id),
  mode               TEXT NOT NULL CHECK (mode IN ('live', 'replay')),
  instrument_id      INTEGER NOT NULL REFERENCES instruments(id),
  contract_id        INTEGER REFERENCES contracts(id),
  side               TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty_g              BIGINT NOT NULL CHECK (qty_g > 0),
  price              BIGINT NOT NULL CHECK (price > 0),
  notional           BIGINT NOT NULL,
  brokerage          BIGINT NOT NULL DEFAULT 0,
  realized_pnl       BIGINT NOT NULL DEFAULT 0,
  reason             TEXT NOT NULL,
  gap                BOOLEAN NOT NULL DEFAULT FALSE,
  ts                 TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fills_user_ts_idx ON fills (user_id, ts);
CREATE INDEX fills_position_idx ON fills (position_id);

CREATE TABLE trades (
  id                 BIGSERIAL PRIMARY KEY,
  position_id        BIGINT NOT NULL UNIQUE REFERENCES positions(id),
  account_id         BIGINT NOT NULL REFERENCES accounts(id),
  user_id            BIGINT NOT NULL REFERENCES users(id),
  mode               TEXT NOT NULL CHECK (mode IN ('live', 'replay')),
  season             INTEGER NOT NULL,
  replay_session_id  BIGINT REFERENCES replay_sessions(id),
  instrument_id      INTEGER NOT NULL REFERENCES instruments(id),
  contract_id        INTEGER REFERENCES contracts(id),
  direction          TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  qty_g              BIGINT NOT NULL,
  entry_price        BIGINT NOT NULL,
  exit_price         BIGINT NOT NULL,
  entry_ts           TIMESTAMPTZ NOT NULL,
  exit_ts            TIMESTAMPTZ NOT NULL,
  holding_seconds    BIGINT NOT NULL,
  entry_notional     BIGINT NOT NULL,
  gross_pnl          BIGINT NOT NULL,
  brokerage          BIGINT NOT NULL,
  net_pnl            BIGINT NOT NULL,
  pnl_pct            NUMERIC(12, 4) NOT NULL,
  initial_sl_price   BIGINT,
  initial_tp_price   BIGINT,
  initial_risk       BIGINT,
  r_multiple         NUMERIC(12, 4),
  planned_rr         NUMERIC(12, 4),
  risk_pct           NUMERIC(12, 4),
  exit_reason        TEXT NOT NULL,
  setup_tag          TEXT,
  plan_note          TEXT,
  confidence         SMALLINT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trades_user_exit_idx ON trades (user_id, mode, exit_ts DESC);

CREATE TABLE trade_reviews (
  trade_id          BIGINT PRIMARY KEY REFERENCES trades(id),
  flags             JSONB NOT NULL DEFAULT '[]',
  mfe_price         BIGINT,
  mae_price         BIGINT,
  mfe_paise         BIGINT,
  mae_paise         BIGINT,
  whatifs           JSONB NOT NULL DEFAULT '{}',
  whatif_complete   BOOLEAN NOT NULL DEFAULT FALSE,
  ai_coach          TEXT,
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trade_notes (
  trade_id    BIGINT PRIMARY KEY REFERENCES trades(id),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  reflection  TEXT NOT NULL DEFAULT '',
  tags        TEXT[] NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE drawings (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  instrument_id  INTEGER NOT NULL REFERENCES instruments(id),
  kind           TEXT NOT NULL CHECK (kind IN ('hline', 'trend')),
  data           JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX drawings_user_instrument_idx ON drawings (user_id, instrument_id);

CREATE TABLE points_ledger (
  id              BIGSERIAL PRIMARY KEY,
  account_id      BIGINT NOT NULL REFERENCES accounts(id),
  user_id         BIGINT NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL,
  amount          BIGINT NOT NULL,
  balance_after   BIGINT NOT NULL CHECK (balance_after >= 0),
  reserved_after  BIGINT NOT NULL CHECK (reserved_after >= 0),
  ref_type        TEXT,
  ref_id          BIGINT,
  note            TEXT,
  created_by      BIGINT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX points_ledger_account_idx ON points_ledger (account_id, id);
CREATE INDEX points_ledger_user_idx ON points_ledger (user_id, created_at);

CREATE TABLE backfill_jobs (
  id              SERIAL PRIMARY KEY,
  contract_id     INTEGER NOT NULL REFERENCES contracts(id),
  interval        TEXT NOT NULL,
  from_date       DATE NOT NULL,
  to_date         DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  chunks_total    INTEGER NOT NULL DEFAULT 0,
  chunks_done     INTEGER NOT NULL DEFAULT 0,
  candles_saved   INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contract_id, interval, from_date, to_date)
);

-- Fills and ledger rows are immutable.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fills_immutable BEFORE UPDATE OR DELETE ON fills
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER points_ledger_immutable BEFORE UPDATE OR DELETE ON points_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
