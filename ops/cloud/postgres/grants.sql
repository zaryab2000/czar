-- Czar cloud database: privileges per role (PM-014; SCR-170 §5; grants from PM-024, PR #213).
--
-- Run by ops/cloud/postgres/init-roles.sh as the superuser, on database czar, at every
-- `docker compose up`. Every statement is idempotent, so a re-run applies a changed list to an
-- existing database and changes nothing otherwise.
--
-- Schema: every table lives in `public` (SCR-170 §5). The server's migrations create theirs as
-- czar_api; Ponder (`ponder start --schema public`) creates the indexer's as czar_indexer. Both
-- happen after this file runs, so the table-level grants cannot be plain GRANT statements here:
-- czar_admin.apply_grants() holds the list and applies whatever part of it already exists, and
-- the event trigger at the bottom calls it after every CREATE TABLE or ALTER TABLE. A grant is
-- therefore in place the moment its table (or column) exists, including after Ponder drops and
-- recreates its tables.
--
-- A grant missing for any reason fails closed: the signer's query raises a permission error,
-- which it records as `backend-error` with nothing signed (PR #213).
\set ON_ERROR_STOP on

-- ── Database and schema ──────────────────────────────────────────────────────────
REVOKE ALL ON DATABASE czar FROM PUBLIC;
GRANT CONNECT ON DATABASE czar TO czar_api, czar_signer, czar_indexer, czar_merchants, czar_backup;
-- Ponder 0.18 begins every start with `CREATE SCHEMA IF NOT EXISTS "public"`
-- (ponder/dist/esm/database/index.js:390), and Postgres checks CREATE on the database before it
-- checks whether the schema exists, so without this the indexer cannot start ("permission denied
-- for database czar"; found by ops/cloud/smoke/native-smoke.test.ts). It lets czar_indexer create
-- schemas of its own; it gives no access to any other role's objects.
GRANT CREATE ON DATABASE czar TO czar_indexer;

-- Postgres 15+ already withholds CREATE on public from PUBLIC; USAGE is withdrawn too, so a role
-- not named below sees nothing.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO czar_api, czar_signer, czar_indexer, czar_merchants, czar_backup;
-- czar_api runs the server migrations (apps/server/src/main.ts). czar_indexer is Ponder, which
-- creates its tables, enums, sequences, triggers and functions in public. czar_merchants runs
-- `CREATE TABLE IF NOT EXISTS schema_migrations` at start (apps/merchants/src/migrate.ts), and
-- Postgres checks CREATE on the schema before it checks whether the table exists.
GRANT CREATE ON SCHEMA public TO czar_api, czar_indexer, czar_merchants;

-- ── Per-role settings ────────────────────────────────────────────────────────────
-- Every role resolves unqualified names in public only, so the signer projection's and the
-- server's unqualified indexer reads (PM-024 F8) can never be shadowed by a schema named after
-- the role ("$user" is the default first entry).
ALTER ROLE czar_api SET search_path = public;
ALTER ROLE czar_signer SET search_path = public;
ALTER ROLE czar_indexer SET search_path = public;
ALTER ROLE czar_merchants SET search_path = public;
ALTER ROLE czar_backup SET search_path = public;

-- PM-024 F7: the signer's pg.Pool sets no query timeout, so a hung database would hold a signing
-- request open forever. The bound is set on the role, not in source. 2000 ms is kms.signTimeoutMs,
-- the whole signing budget including the Cloud KMS round trip: one projection query that takes
-- longer has already failed the request, so cancelling it turns a hang into a refusal
-- (`backend-error`, nothing signed). Every signer query is a single indexed SELECT or one audit
-- INSERT. ops/cloud/test/compose.test.ts keeps this equal to the registry default.
ALTER ROLE czar_signer SET statement_timeout = '2000ms';
-- The signer opens no transactions (postgres-audit.ts, postgres-projection.ts), so a session idle
-- inside one is a fault; end it rather than let it hold locks. Same bound, same reason.
ALTER ROLE czar_signer SET idle_in_transaction_session_timeout = '2000ms';

-- czar_backup is read-only (SCR-170 §5; PM-052's pg-backup.sh): it reads every table, present and
-- future, and can write nothing.
GRANT pg_read_all_data TO czar_backup;
ALTER ROLE czar_backup SET default_transaction_read_only = on;

-- ── The grant list ───────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS czar_admin AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA czar_admin FROM PUBLIC;

-- Owned by the superuser and SECURITY DEFINER, so it may grant on tables any role owns; it applies
-- this fixed list and nothing else. A listed column that does not exist yet is skipped and granted
-- by the ALTER TABLE that adds it. NULL columns means the whole table.
CREATE OR REPLACE FUNCTION czar_admin.apply_grants() RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  grant_row record;
  present text[];
BEGIN
  FOR grant_row IN
    SELECT * FROM (VALUES
      -- czar_signer: indexer tables, SELECT only (PR #213).
      ('czar_signer', 'envelopes',         'SELECT', NULL::text[]),
      ('czar_signer', 'reservations',      'SELECT', NULL),
      ('czar_signer', 'authorizations',    'SELECT', NULL),
      ('czar_signer', 'pullbacks',         'SELECT', NULL),
      ('czar_signer', 'pockets',           'SELECT', NULL),
      ('czar_signer', 'pocket_balances',   'SELECT', NULL),
      ('czar_signer', 'gateway_transfers', 'SELECT', NULL),
      ('czar_signer', 'jobs',              'SELECT', NULL),
      ('czar_signer', 'anchors',           'SELECT', NULL),
      ('czar_signer', 'manual_returns',    'SELECT', NULL),
      -- czar_signer: server tables, SELECT on named columns only. These tables also hold secrets
      -- and personal data (users.user_secret, demand_salt, msca) the signer must not read.
      ('czar_signer', 'plans',              'SELECT',
        ARRAY['plan_hash', 'plan', 'state', 'objective_id']),
      ('czar_signer', 'objectives',         'SELECT', ARRAY['objective_id', 'state']),
      ('czar_signer', 'users',              'SELECT', ARRAY['user_id', 'vault']),
      ('czar_signer', 'acceptance_reports', 'SELECT', ARRAY['report_hash']),
      ('czar_signer', 'evidence_receipts',  'SELECT', ARRAY['receipt']),
      ('czar_signer', 'payer_pullback_gateway_failures', 'SELECT',
        ARRAY['pocket', 'vault_address', 'state', 'closed_pocket', 'return_tx', 'return_block',
              'return_log_index', 'returned_amount', 'manual_return_required_at',
              'unavailable_since']),
      -- czar_signer: the shared audit log. audit_id is GENERATED ALWAYS AS IDENTITY, so INSERT
      -- needs no sequence grant.
      ('czar_signer', 'audit', 'INSERT', ARRAY['actor_key_id', 'action', 'object_ids', 'outcome', 'at']),
      ('czar_signer', 'audit', 'SELECT', ARRAY['action', 'outcome', 'object_ids', 'at']),
      -- czar_merchants: its one table (created by the server's migration 0012), and the shared
      -- migration ledger. UPDATE is needed because migrate.ts reads its row `FOR UPDATE`.
      ('czar_merchants', 'merchant_payment_identifiers', 'SELECT, INSERT, UPDATE, DELETE', NULL),
      ('czar_merchants', 'schema_migrations',            'SELECT, INSERT, UPDATE', NULL)
    ) AS list(grantee, table_name, privileges, columns)
  LOOP
    CONTINUE WHEN to_regclass(format('public.%I', grant_row.table_name)) IS NULL;
    IF grant_row.columns IS NULL THEN
      EXECUTE format('GRANT %s ON TABLE public.%I TO %I',
        grant_row.privileges, grant_row.table_name, grant_row.grantee);
    ELSE
      SELECT array_agg(quote_ident(attname) ORDER BY attnum) INTO present
        FROM pg_attribute
       WHERE attrelid = format('public.%I', grant_row.table_name)::regclass
         AND attname = ANY (grant_row.columns)
         AND attnum > 0
         AND NOT attisdropped;
      CONTINUE WHEN present IS NULL;
      EXECUTE format('GRANT %s (%s) ON TABLE public.%I TO %I',
        grant_row.privileges, array_to_string(present, ', '), grant_row.table_name,
        grant_row.grantee);
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION czar_admin.apply_grants() FROM PUBLIC;

CREATE OR REPLACE FUNCTION czar_admin.apply_grants_after_ddl() RETURNS event_trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM czar_admin.apply_grants();
END;
$$;
REVOKE ALL ON FUNCTION czar_admin.apply_grants_after_ddl() FROM PUBLIC;

DROP EVENT TRIGGER IF EXISTS czar_apply_grants;
CREATE EVENT TRIGGER czar_apply_grants ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'ALTER TABLE')
  EXECUTE FUNCTION czar_admin.apply_grants_after_ddl();

-- Whatever already exists (a re-run on a live database).
SELECT czar_admin.apply_grants();
