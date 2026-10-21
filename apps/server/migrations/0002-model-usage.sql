ALTER TABLE idempotency
  ADD COLUMN model_input_tokens bigint,
  ADD COLUMN model_output_tokens bigint,
  ADD CONSTRAINT idempotency_model_tokens_nonnegative CHECK (
    (model_input_tokens IS NULL AND model_output_tokens IS NULL) OR
    (model_input_tokens >= 0 AND model_output_tokens >= 0)
  );

CREATE TABLE model_usage (
  user_id text NOT NULL REFERENCES users(user_id),
  month_start date NOT NULL CHECK (month_start = date_trunc('month', month_start)::date),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  source_extractor_tokens bigint NOT NULL DEFAULT 0 CHECK (source_extractor_tokens >= 0),
  PRIMARY KEY (user_id, month_start)
);
