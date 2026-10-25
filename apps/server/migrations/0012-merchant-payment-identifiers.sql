CREATE TABLE merchant_payment_identifiers (
  route text NOT NULL,
  payment_identifier text NOT NULL,
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  state text NOT NULL CHECK (state IN ('pending', 'complete')),
  stored_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  response_status integer,
  response_body text,
  payment_response text,
  PRIMARY KEY (route, payment_identifier),
  CHECK (
    (response_status IS NULL AND response_body IS NULL AND payment_response IS NULL)
    OR
    (response_status IS NOT NULL AND response_body IS NOT NULL AND payment_response IS NOT NULL)
  ),
  CHECK (state <> 'pending' OR response_status IS NULL)
);

CREATE INDEX merchant_payment_identifiers_expires_at_idx
  ON merchant_payment_identifiers (expires_at);
