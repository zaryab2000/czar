CREATE TABLE payer_freeze_autolimit_events (
  vault text NOT NULL,
  block_number numeric(78, 0) NOT NULL CHECK (block_number >= 0),
  log_index integer NOT NULL CHECK (log_index >= 0),
  transaction_hash text NOT NULL,
  processed_at timestamptz,
  PRIMARY KEY (vault, block_number, log_index)
);

CREATE TABLE payer_freeze_autolimit_cursors (
  vault text PRIMARY KEY,
  last_scanned_block numeric(78, 0) NOT NULL CHECK (last_scanned_block >= 0)
);
