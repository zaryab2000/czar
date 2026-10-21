CREATE TABLE evidence_receipts (
  obs_id text PRIMARY KEY CHECK (obs_id ~ '^obs_[0-9a-f]{32}$'),
  envelope_ref text NOT NULL,
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 63),
  reservation_id bigint NOT NULL CHECK (reservation_id >= 0),
  authorization_index integer NOT NULL CHECK (authorization_index BETWEEN 0 AND 127),
  payment_ref_hash text NOT NULL CHECK (payment_ref_hash ~ '^0x[0-9a-f]{64}$'),
  receipt jsonb NOT NULL,
  report_hashes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  body_ref text
);
CREATE INDEX evidence_receipts_envelope_step ON evidence_receipts(envelope_ref,step_index);
CREATE INDEX evidence_receipts_reports ON evidence_receipts USING gin(report_hashes);
