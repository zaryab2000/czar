CREATE TABLE plan_pocket_keys (
  plan_id text PRIMARY KEY REFERENCES plans(plan_id),
  pocket_address text NOT NULL CHECK (pocket_address ~ '^0x[0-9a-fA-F]{40}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION link_plan_pocket_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan ? 'pocket' AND NEW.plan->>'pocket' IS NOT NULL THEN
    INSERT INTO plan_pocket_keys (plan_id,pocket_address)
    VALUES (NEW.plan_id,NEW.plan->>'pocket');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER plans_link_pocket_key
AFTER INSERT ON plans FOR EACH ROW EXECUTE FUNCTION link_plan_pocket_key();

CREATE TABLE payer_job_briefs (
  job_key text PRIMARY KEY CHECK (job_key ~ '^0x[0-9a-f]{64}$'),
  plan_id text NOT NULL REFERENCES plans(plan_id),
  step_index integer NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^0x[0-9a-fA-F]{40}$'),
  brief jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payer_job_deliverables (
  job_key text NOT NULL REFERENCES payer_job_briefs(job_key),
  content_hash text NOT NULL CHECK (content_hash ~ '^0x[0-9a-f]{64}$'),
  body_ref text NOT NULL,
  bytes integer NOT NULL CHECK (bytes >= 0),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_key, content_hash)
);
CREATE INDEX payer_job_deliverables_purge ON payer_job_deliverables(uploaded_at);
