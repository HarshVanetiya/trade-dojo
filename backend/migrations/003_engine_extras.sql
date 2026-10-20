-- Extra bookkeeping used by the trading engine and reviews.
ALTER TABLE positions ADD COLUMN equity_at_entry BIGINT;
ALTER TABLE positions ADD COLUMN both_touched BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE positions ADD COLUMN entry_gap BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE trades ADD COLUMN both_touched BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE trades ADD COLUMN gap_exit BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE trades ADD COLUMN equity_at_entry BIGINT;
ALTER TABLE trades ADD COLUMN contract_symbol TEXT;
