ALTER TABLE payer_pullback_gateway_failures
  ADD COLUMN initiate_tx text,
  ADD COLUMN withdraw_tx text,
  ADD COLUMN return_tx text,
  ADD COLUMN return_block numeric(78, 0),
  ADD COLUMN return_log_index integer,
  ADD COLUMN returned_amount numeric(78, 0);

ALTER TABLE payer_pullback_gateway_failures
  DROP CONSTRAINT payer_pullback_gateway_failures_state_check,
  ADD CONSTRAINT payer_pullback_gateway_failures_state_check
    CHECK (state IN (
      'pending', 'manual-return-required', 'recorded', 'expired', 'returned-to-vault'
    ));

CREATE UNIQUE INDEX payer_pullback_one_open_closed_pocket
  ON payer_pullback_gateway_failures (lower(pocket))
  WHERE closed_pocket AND state = 'pending';
