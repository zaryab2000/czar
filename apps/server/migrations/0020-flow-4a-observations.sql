ALTER TABLE users ADD COLUMN controlled boolean NOT NULL DEFAULT false;

CREATE TABLE observations (
  obs_id text PRIMARY KEY CHECK (obs_id ~ '^obs_[0-9a-f]{32}$'),
  user_id text NOT NULL REFERENCES users(user_id),
  vault text NOT NULL CHECK (vault ~ '^0x[0-9a-f]{40}$'),
  network text NOT NULL CHECK (network ~ '^eip155:[0-9]+$'),
  rail text NOT NULL CHECK (rail IN ('x402-exact','gateway-batched','erc8183-job')),
  service_id text NOT NULL,
  version_id text NOT NULL DEFAULT 'ver_unknown',
  task_class text NOT NULL,
  objective_id text NOT NULL REFERENCES objectives(objective_id),
  envelope_ref text NOT NULL CHECK (envelope_ref ~ '^eip155:[0-9]+:0x[0-9a-f]{40}:[0-9]+$'),
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 63),
  call_index integer NOT NULL CHECK (call_index BETWEEN 0 AND 4095),
  payment_ref_hash text NOT NULL CHECK (payment_ref_hash ~ '^0x[0-9a-f]{64}$'),
  payment_id text NOT NULL,
  dedup_key text NOT NULL UNIQUE,
  delivered smallint CHECK (delivered IN (0,1)),
  job_state text CHECK (job_state IS NULL OR job_state IN ('Opened','Funded','Submitted','Completed','Refunded','Released','Expired')),
  controlled boolean NOT NULL DEFAULT false,
  settlement_tx text CHECK (settlement_tx IS NULL OR settlement_tx ~ '^0x[0-9a-f]{64}$'),
  responded_at timestamptz,
  settled_at timestamptz,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (envelope_ref, step_index, call_index),
  CHECK (settled_at IS NULL OR released_at IS NULL)
);
CREATE INDEX observations_service ON observations(network, service_id, version_id, task_class, created_at DESC) WHERE settled_at IS NOT NULL;
CREATE INDEX observations_objective ON observations(objective_id, step_index, call_index);
CREATE INDEX observations_user ON observations(user_id, created_at DESC);

CREATE TABLE supplier_health (
  fact text NOT NULL CHECK (fact IN ('settled-not-delivered','repeated-unsettled-failure','job-failed','injection-blocked')),
  obs_id text NOT NULL REFERENCES observations(obs_id),
  user_id text NOT NULL REFERENCES users(user_id),
  network text NOT NULL,
  service_id text NOT NULL,
  version_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  cleared_by_obs_id text REFERENCES observations(obs_id),
  PRIMARY KEY (fact, obs_id)
);
CREATE INDEX supplier_health_open ON supplier_health(network, service_id, user_id) WHERE cleared_at IS NULL;

CREATE TABLE ratings (
  rating_id text PRIMARY KEY CHECK (rating_id ~ '^rtg_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id text NOT NULL REFERENCES users(user_id),
  vault text NOT NULL CHECK (vault ~ '^0x[0-9a-f]{40}$'),
  objective_id text NOT NULL REFERENCES objectives(objective_id),
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 63),
  network text NOT NULL,
  service_id text NOT NULL,
  version_id text NOT NULL,
  task_class text NOT NULL,
  value text NOT NULL CHECK (value IN ('good','bad')),
  surface text NOT NULL CHECK (surface IN ('cli','web')),
  supersedes text REFERENCES ratings(rating_id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ratings_supplier ON ratings(network, service_id, version_id, task_class, created_at DESC);
CREATE INDEX ratings_objective ON ratings(objective_id, step_index, created_at DESC);
CREATE UNIQUE INDEX ratings_supersedes ON ratings(supersedes) WHERE supersedes IS NOT NULL;

CREATE TABLE rating_receipts (
  obs_id text PRIMARY KEY REFERENCES observations(obs_id),
  rating_id text NOT NULL REFERENCES ratings(rating_id)
);

CREATE VIEW ratings_effective AS
  SELECT DISTINCT ON (r.objective_id, r.step_index) r.*
  FROM ratings r
  WHERE NOT EXISTS (SELECT 1 FROM ratings n WHERE n.supersedes = r.rating_id)
  ORDER BY r.objective_id, r.step_index, r.created_at DESC, r.rating_id DESC;

CREATE TABLE supplier_counts (
  network text NOT NULL,
  service_id text NOT NULL,
  version_id text NOT NULL,
  task_class text NOT NULL,
  good integer NOT NULL,
  bad integer NOT NULL,
  owners_rated integer NOT NULL,
  owners_bad integer NOT NULL,
  lower_bound double precision,
  lineage_root text,
  policy_version text NOT NULL,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (network, service_id, version_id, task_class)
);
