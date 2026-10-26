ALTER TABLE payer_pullback_gateway_failures
  ADD COLUMN manual_return_required_at timestamptz,
  ADD COLUMN recorded_credit numeric(78, 0),
  ADD COLUMN recorded_tx text,
  ADD COLUMN recorded_at timestamptz;

UPDATE payer_pullback_gateway_failures
SET manual_return_required_at = CURRENT_TIMESTAMP
WHERE state = 'manual-return-required'
  AND manual_return_required_at IS NULL;
