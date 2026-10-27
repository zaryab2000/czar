ALTER TABLE idempotency
  ADD COLUMN model_input_tokens bigint,
  ADD COLUMN model_output_tokens bigint,
  ADD CONSTRAINT idempotency_model_tokens_nonnegative CHECK (
    (model_input_tokens IS NULL AND model_output_tokens IS NULL) OR
    (model_input_tokens >= 0 AND model_output_tokens >= 0)
  );

-- Settled token counts per user, month and prompt (cross-cutting §6.2). Never bodies.
CREATE TABLE model_usage (
  user_id text NOT NULL REFERENCES users(user_id),
  month_start date NOT NULL CHECK (month_start = date_trunc('month', month_start)::date),
  prompt text NOT NULL CHECK (prompt IN ('P-01','P-04','P-05','P-06','P-07')),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  PRIMARY KEY (user_id, month_start, prompt)
);

-- Budget held while a provider call is in flight (SCR-117). Deleted on settle;
-- an orphan left by a crash stops counting once expires_at passes.
CREATE TABLE model_reservations (
  reservation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(user_id),
  month_start date NOT NULL,
  prompt text NOT NULL CHECK (prompt IN ('P-01','P-04','P-05','P-06','P-07')),
  tokens bigint NOT NULL CHECK (tokens > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX model_reservations_user_month ON model_reservations(user_id, month_start);
