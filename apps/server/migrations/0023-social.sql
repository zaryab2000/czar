ALTER TABLE outbox_events ADD COLUMN txid xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE INDEX outbox_events_txid ON outbox_events(txid, event_id);

CREATE TABLE event_deliveries (
  event_id bigint NOT NULL REFERENCES outbox_events(event_id),
  consumer text NOT NULL CHECK (consumer IN ('social')),
  state text NOT NULL CHECK (state IN ('pending','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);
CREATE TABLE social_consumer_cursor (
  consumer text PRIMARY KEY CHECK (consumer IN ('social')),
  last_txid xid8 NOT NULL DEFAULT '0',
  last_event_id bigint NOT NULL DEFAULT 0
);

CREATE TABLE social_representatives (
  representative_id text PRIMARY KEY CHECK (representative_id ~ '^rep_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id text NOT NULL UNIQUE REFERENCES users(user_id),
  handle text NOT NULL CHECK (handle ~ '^Rep-[0-9A-HJKMNP-TV-Z]{4}$'),
  sharing text NOT NULL DEFAULT 'off' CHECK (sharing IN ('off','structured','discuss')),
  sharing_version integer NOT NULL DEFAULT 1,
  paused boolean NOT NULL DEFAULT false,
  controlled boolean NOT NULL DEFAULT false,
  consent_text_version text,
  consented_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE social_inbox (
  inbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  representative_id text NOT NULL REFERENCES social_representatives(representative_id),
  event_id bigint NOT NULL REFERENCES outbox_events(event_id),
  kind text NOT NULL CHECK (kind IN ('outcome-ready','outcome-updated','need-unmet','post-routed',
                                     'incident-changed','question-expired')),
  refs jsonb NOT NULL,          -- {objectiveId?, ratingId?, postId?, threadId?, incidentId?, routingReason?}
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','claimed','done','skipped','failed','retry')),
  due_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  lease_token text,
  lease_expires_at timestamptz,
  stop_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (representative_id, event_id)
);
CREATE INDEX social_inbox_due ON social_inbox(due_at) WHERE state IN ('queued','retry');

CREATE TABLE social_threads (
  thread_id text PRIMARY KEY CHECK (thread_id ~ '^thr_[0-9A-HJKMNP-TV-Z]{26}$'),
  kind text NOT NULL CHECK (kind IN ('service','question','incident')),
  network text NOT NULL,
  service_id text,              -- required for service and incident threads
  version_id text,              -- incident threads only
  task_class text,              -- question and incident threads
  capability_tag text,          -- question threads only
  subject_key text NOT NULL,    -- §3.7
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','expired')),
  opened_by text REFERENCES social_representatives(representative_id),
  contributions integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 1,
  expires_at timestamptz,
  incident_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX social_threads_service_subject ON social_threads(subject_key) WHERE kind = 'service';

CREATE TABLE social_posts (
  post_id text PRIMARY KEY CHECK (post_id ~ '^pst_[0-9A-HJKMNP-TV-Z]{26}$'),
  thread_id text NOT NULL REFERENCES social_threads(thread_id),
  parent_post_id text REFERENCES social_posts(post_id),
  author_id text REFERENCES social_representatives(representative_id),  -- NULL only for kind 'system'
  kind text NOT NULL CHECK (kind IN ('experience','question','reply','lead','system')),
  stance text CHECK (stance IN ('corroborates','contradicts','answers','neutral')),
  card jsonb,
  note text CHECK (char_length(note) <= 280),   -- always NULL in this iteration (§3.11)
  action_id text NOT NULL UNIQUE,               -- §3.10
  revision integer NOT NULL DEFAULT 1,
  superseded_by text REFERENCES social_posts(post_id),
  tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX social_posts_thread ON social_posts(thread_id, created_at);
CREATE INDEX social_posts_author ON social_posts(author_id, created_at DESC);

CREATE TABLE social_evidence_links (
  post_id text NOT NULL REFERENCES social_posts(post_id),
  obs_id text NOT NULL REFERENCES observations(obs_id),
  link_kind text NOT NULL CHECK (link_kind IN ('experience','reply','attach')),
  PRIMARY KEY (post_id, obs_id)
);
-- one experience post per evidence unit; any number of replies and attachments.
-- A revision moves its 'experience' links to the new row in the same commit (§3.7), so the index always points at the latest revision.
CREATE UNIQUE INDEX social_evidence_one_experience ON social_evidence_links(obs_id) WHERE link_kind = 'experience';

CREATE TABLE social_subscriptions (
  representative_id text NOT NULL REFERENCES social_representatives(representative_id),
  subject_key text NOT NULL,     -- service:<network>:<serviceId> | class:<network>:<taskClass> | tag:<network>:<tag>
  source text NOT NULL CHECK (source IN ('purchase','objective')),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (representative_id, subject_key)
);

CREATE TABLE social_runs (
  run_id text PRIMARY KEY CHECK (run_id ~ '^run_[0-9A-HJKMNP-TV-Z]{26}$'),
  inbox_id bigint NOT NULL REFERENCES social_inbox(inbox_id),
  representative_id text NOT NULL REFERENCES social_representatives(representative_id),
  sharing_version integer NOT NULL,
  policy_version text NOT NULL,
  action text NOT NULL,
  stop_reason text NOT NULL,
  post_id text REFERENCES social_posts(post_id),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL
);

CREATE TABLE social_lessons (
  lesson_id text PRIMARY KEY CHECK (lesson_id ~ '^les_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id text NOT NULL REFERENCES users(user_id),
  network text NOT NULL,
  service_id text NOT NULL,
  version_id text,
  task_class text NOT NULL,
  proposition text NOT NULL CHECK (proposition IN ('prefer','avoid')),
  strength numeric(4,3) NOT NULL CHECK (strength > 0 AND strength <= 1),
  source_post_id text NOT NULL REFERENCES social_posts(post_id),
  source_obs_id text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','expired','dismissed','superseded')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, network, service_id, task_class, source_obs_id)
);
CREATE INDEX social_lessons_lookup ON social_lessons(user_id, network, task_class) WHERE state = 'active';

CREATE TABLE social_incidents (
  incident_id text PRIMARY KEY CHECK (incident_id ~ '^inc_[0-9A-HJKMNP-TV-Z]{26}$'),
  network text NOT NULL,
  service_id text NOT NULL,
  version_id text NOT NULL,     -- a ver_ id, or 'ver_unknown' (§3.13.1: covers every version)
  task_class text NOT NULL,
  state text NOT NULL CHECK (state IN ('open','closed')),
  distinct_owners integer NOT NULL,
  negative_units integer NOT NULL,
  positive_units_since integer NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  close_reason text CHECK (close_reason IN ('recovered','window-cleared','new-version')),
  thread_id text REFERENCES social_threads(thread_id),
  UNIQUE (network, service_id, version_id, task_class, opened_at)
);
CREATE UNIQUE INDEX social_incidents_one_open
  ON social_incidents(network, service_id, version_id, task_class) WHERE state = 'open';

CREATE TABLE social_leads (
  lead_id text PRIMARY KEY CHECK (lead_id ~ '^led_[0-9A-HJKMNP-TV-Z]{26}$'),
  post_id text NOT NULL REFERENCES social_posts(post_id),
  network text NOT NULL,
  origin text NOT NULL,          -- https origin only
  path_hint text,
  capability_tag text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','probing','probed-ok','rejected','duplicate')),
  reject_reason text CHECK (reject_reason IN ('not-402','wrong-network','unsafe-origin','probe-failed')),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (network, origin, path_hint)   -- PostgreSQL 16: an origin-only lead is a duplicate too
);

CREATE TABLE social_budgets (
  representative_id text NOT NULL REFERENCES social_representatives(representative_id),
  day date NOT NULL,
  posts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (representative_id, day)
);

CREATE VIEW social_objective_projection AS
SELECT o.objective_id, o.user_id, o.state, o.plan_id, o.created_at, o.updated_at,
       o.submission->'taskSpec'->>'kind' AS task_kind,
       o.submission->'taskSpec'->'output'->>'format' AS output_format,
       o.submission->'capabilities' AS capabilities
FROM objectives o;

CREATE VIEW social_observation_projection AS
SELECT obs_id, user_id, network, rail, service_id, version_id, task_class,
       objective_id, step_index, call_index, delivered, job_state, controlled,
       settled_at, released_at, created_at
FROM observations;

CREATE VIEW social_user_projection AS
SELECT user_id, controlled FROM users;

CREATE FUNCTION social_objective_subject_labels(p_objective_id text) RETURNS text[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(array_agg(s->>'label'), '{}')
  FROM objectives o, jsonb_array_elements(coalesce(o.submission->'taskSpec'->'subjects', '[]'::jsonb)) s
  WHERE o.objective_id = p_objective_id
$$;
REVOKE ALL ON FUNCTION social_objective_subject_labels(text) FROM PUBLIC;

CREATE VIEW social_step_projection AS
SELECT s.plan_id, s.step_index,
       s.step->>'capability' AS capability,
       s.step->>'kind' AS step_kind,
       s.step->>'serviceId' AS service_id,
       s.step->>'unitAmount' AS unit_amount
FROM steps s;

DO $$ BEGIN
  CREATE ROLE czar_social NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END $$;
DO $$ BEGIN
  EXECUTE format('GRANT czar_social TO %I', current_user);
END $$;

CREATE FUNCTION social_outbox_insert_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'czar_social' AND NEW.name NOT LIKE 'social.%' THEN
    RAISE EXCEPTION 'czar_social may insert only social events' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER social_outbox_insert_guard BEFORE INSERT ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION social_outbox_insert_guard();

GRANT USAGE ON SCHEMA public TO czar_social;
GRANT SELECT, INSERT, UPDATE ON event_deliveries, social_consumer_cursor,
  social_representatives, social_inbox, social_threads, social_posts,
  social_evidence_links, social_subscriptions, social_runs, social_lessons,
  social_incidents, social_leads, social_budgets TO czar_social;
GRANT DELETE ON social_subscriptions TO czar_social;
GRANT SELECT, INSERT ON outbox_events TO czar_social;
GRANT SELECT ON social_objective_projection, social_step_projection,
  social_observation_projection, social_user_projection,
  ratings, rating_receipts, ratings_effective, supplier_health, service_versions
  TO czar_social;
GRANT EXECUTE ON FUNCTION social_objective_subject_labels(text) TO czar_social;
GRANT USAGE, SELECT ON SEQUENCE social_inbox_inbox_id_seq, outbox_events_event_id_seq
  TO czar_social;
