CREATE TABLE service_versions (
  network text NOT NULL,
  service_id text NOT NULL,
  version_id text NOT NULL CHECK (version_id ~ '^ver_[0-9a-f]{32}$'),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, service_id, version_id)
);
