CREATE TABLE ranking_decisions (
  query_id uuid PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES selection_interim_snapshots(snapshot_id) ON DELETE CASCADE,
  policy_version text NOT NULL,
  decision jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
