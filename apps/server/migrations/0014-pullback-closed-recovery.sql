ALTER TABLE payer_pullback_gateway_failures
  ADD COLUMN closed_pocket boolean NOT NULL DEFAULT false;

ALTER TABLE payer_pullback_gateway_failures
  DROP CONSTRAINT payer_pullback_gateway_failures_state_check,
  ADD CONSTRAINT payer_pullback_gateway_failures_state_check
    CHECK (state IN ('pending','manual-return-required','returned-to-vault'));
