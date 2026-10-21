CREATE TABLE executor_leases (
  envelope_ref text PRIMARY KEY,
  worker_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX executor_leases_expiry ON executor_leases(expires_at);
