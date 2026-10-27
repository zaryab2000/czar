CREATE TABLE selection_interim_snapshots (
  snapshot_id text PRIMARY KEY CHECK (snapshot_id ~ '^0x[0-9a-f]{64}$'),
  body_jcs text NOT NULL,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL
);

CREATE INDEX selection_interim_snapshots_last_used_at_idx
  ON selection_interim_snapshots (last_used_at);
