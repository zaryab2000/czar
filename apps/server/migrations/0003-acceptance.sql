CREATE TABLE profiles (
  profile_id text PRIMARY KEY CHECK (profile_id ~ '^prof_[0-9a-f]{32}$'),
  task_class text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  "json" jsonb NOT NULL,
  code_hash text NOT NULL CHECK (code_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_class, version, code_hash)
);

CREATE TABLE acceptance_reports (
  report_hash text PRIMARY KEY CHECK (report_hash ~ '^0x[0-9a-f]{64}$'),
  envelope_ref text NOT NULL CHECK (envelope_ref ~ '^eip155:[0-9]+:0x[0-9a-f]{40}:[0-9]+$'),
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 63),
  job_key text CHECK (job_key IS NULL OR job_key ~ '^0x[0-9a-f]{64}$'),
  obs_id text NOT NULL CHECK (obs_id ~ '^obs_[0-9a-f]{32}$'),
  profile_id text NOT NULL REFERENCES profiles(profile_id),
  method_version text NOT NULL CHECK (method_version ~ '^0x[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('pass', 'fail', 'inconclusive')),
  checks jsonb NOT NULL,
  flags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  body_ref text,
  report jsonb NOT NULL
);

CREATE INDEX acceptance_reports_envelope_step ON acceptance_reports(envelope_ref, step_index);
CREATE INDEX profiles_task_class ON profiles(task_class, version DESC);
