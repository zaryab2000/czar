CREATE TABLE auth_challenges (
  challenge_id text PRIMARY KEY CHECK (char_length(challenge_id) <= 64),
  challenge_hash bytea NOT NULL CHECK (octet_length(challenge_hash) = 32),
  purpose text NOT NULL CHECK (purpose IN ('register', 'session')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);

ALTER TABLE users
  ADD COLUMN mode text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'live')),
  ADD COLUMN shadow_ends_at timestamptz;

CREATE TABLE passkey_credentials (
  credential_id text PRIMARY KEY CHECK (char_length(credential_id) <= 1024),
  user_id text NOT NULL UNIQUE REFERENCES users(user_id),
  qx bytea NOT NULL CHECK (octet_length(qx) = 32),
  qy bytea NOT NULL CHECK (octet_length(qy) = 32),
  sign_count bigint NOT NULL CHECK (sign_count >= 0 AND sign_count <= 4294967295),
  rp_id text NOT NULL CHECK (rp_id = 'localhost'),
  created_at timestamptz NOT NULL DEFAULT now()
);
