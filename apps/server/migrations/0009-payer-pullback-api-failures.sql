CREATE TABLE payer_pullback_gateway_failures (
  plan_id text NOT NULL REFERENCES plans(plan_id),
  step_index integer NOT NULL CHECK (step_index >= 0),
  envelope_ref text NOT NULL,
  pocket text NOT NULL CHECK (pocket ~ '^0x[0-9a-fA-F]{40}$'),
  value numeric(78,0) NOT NULL CHECK (value > 0),
  unavailable_since timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','manual-return-required')),
  PRIMARY KEY (plan_id,step_index)
);
CREATE INDEX payer_pullback_gateway_failures_pending
  ON payer_pullback_gateway_failures(unavailable_since,plan_id,step_index)
  WHERE state='pending';
