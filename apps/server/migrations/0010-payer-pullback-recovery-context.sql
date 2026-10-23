ALTER TABLE payer_pullback_gateway_failures
  ADD COLUMN pullback_id numeric(78,0) CHECK (pullback_id IS NULL OR pullback_id >= 0),
  ADD COLUMN vault_address text CHECK (
    vault_address IS NULL OR vault_address ~ '^0x[0-9a-fA-F]{40}$'
  ),
  ADD COLUMN gateway_minter text CHECK (
    gateway_minter IS NULL OR gateway_minter ~ '^0x[0-9a-fA-F]{40}$'
  ),
  ADD COLUMN attempt integer CHECK (attempt IS NULL OR attempt >= 0);
