CREATE TABLE users (
  user_id text PRIMARY KEY CHECK (user_id ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
  msca text,
  vault text,
  network text NOT NULL DEFAULT 'eip155:5042002',
  user_secret bytea,
  demand_salt bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_secret IS NULL OR octet_length(user_secret) = 32),
  CHECK (demand_salt IS NULL OR octet_length(demand_salt) = 32)
);

CREATE TABLE devices (
  device_id text PRIMARY KEY CHECK (device_id ~ '^dev_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id text NOT NULL REFERENCES users(user_id),
  device_name text NOT NULL CHECK (char_length(device_name) <= 64),
  platform text NOT NULL CHECK (platform IN ('macos','linux','windows')),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pairing_codes (
  code_digest bytea PRIMARY KEY CHECK (octet_length(code_digest) = 32),
  user_id text NOT NULL REFERENCES users(user_id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pairing_codes_expiry ON pairing_codes(expires_at);

CREATE TABLE objectives (
  objective_id text PRIMARY KEY CHECK (objective_id ~ '^obj_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id text NOT NULL REFERENCES users(user_id),
  device_id text NOT NULL REFERENCES devices(device_id),
  submission jsonb NOT NULL,
  objective_hash text NOT NULL CHECK (objective_hash ~ '^0x[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN (
    'received','planning','no-supplier','awaiting-approval','opening',
    'executing','replanning','delivered','failed','expired','dismissed')),
  plan_id text,
  envelope_ref text,
  result_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX objectives_device_page ON objectives(device_id, created_at DESC, objective_id DESC);
CREATE INDEX objectives_device_state_page ON objectives(device_id, state, created_at DESC, objective_id DESC);

CREATE TABLE plans (
  plan_id text PRIMARY KEY CHECK (plan_id ~ '^pln_[0-9A-HJKMNP-TV-Z]{26}$'),
  objective_id text NOT NULL REFERENCES objectives(objective_id),
  plan jsonb NOT NULL,
  plan_hash text NOT NULL CHECK (plan_hash ~ '^0x[0-9a-f]{64}$'),
  payee_root text NOT NULL CHECK (payee_root ~ '^0x[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('draft','offered','approved','superseded','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plans_objective ON plans(objective_id);

CREATE TABLE steps (
  plan_id text NOT NULL REFERENCES plans(plan_id),
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 63),
  step jsonb NOT NULL,
  state text NOT NULL,
  calls_used integer NOT NULL DEFAULT 0 CHECK (calls_used >= 0),
  reservation_id text,
  job_key text,
  pocket text,
  PRIMARY KEY (plan_id, step_index)
);

CREATE TABLE step_executions (
  execution_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id text NOT NULL,
  step_index integer NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 0),
  phase text NOT NULL,
  payload jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (plan_id, step_index) REFERENCES steps(plan_id, step_index)
);
CREATE INDEX step_executions_step ON step_executions(plan_id, step_index, execution_id);

CREATE TABLE results (
  result_id text PRIMARY KEY CHECK (result_id ~ '^res_[0-9A-HJKMNP-TV-Z]{26}$'),
  objective_id text NOT NULL UNIQUE REFERENCES objectives(objective_id),
  rendered_body text NOT NULL,
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pay_requests (
  pay_request_id text PRIMARY KEY CHECK (pay_request_id ~ '^prq_[0-9a-f]{32}$'),
  device_id text NOT NULL REFERENCES devices(device_id),
  plan_id text NOT NULL REFERENCES plans(plan_id),
  step_index integer NOT NULL,
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  status text NOT NULL,
  payment_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  user_id text NOT NULL REFERENCES users(user_id),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE idempotency (
  scope text NOT NULL,
  key uuid NOT NULL,
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  status smallint,
  response_body jsonb,
  response_hash bytea,
  replay_stored boolean NOT NULL DEFAULT true,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key),
  CHECK (status IS NULL OR status BETWEEN 100 AND 599)
);
CREATE INDEX idempotency_expiry ON idempotency(expires_at);

CREATE TABLE outbox_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  objective_id text REFERENCES objectives(objective_id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX outbox_pending ON outbox_events(event_id) WHERE delivered_at IS NULL;

CREATE TABLE rate_limit_buckets (
  surface text NOT NULL,
  principal_hash bytea NOT NULL CHECK (octet_length(principal_hash) = 32),
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (surface, principal_hash, window_start)
);

CREATE TABLE audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_key_id text,
  action text NOT NULL,
  object_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount_atomic text,
  tx_hash text,
  outcome text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE objective_cursors (
  cursor_hash bytea PRIMARY KEY CHECK (octet_length(cursor_hash) = 32),
  device_id text NOT NULL REFERENCES devices(device_id),
  state_filter text,
  last_created_at timestamptz NOT NULL,
  last_objective_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX objective_cursors_expiry ON objective_cursors(expires_at);
