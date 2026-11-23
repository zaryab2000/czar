#!/bin/sh
# Czar cloud database roles (PM-014; SCR-170 §4, §5). Run by the one-shot `postgres-init` service at
# every `docker compose up`, after Postgres is healthy and before any app connects.
#
#   1. creates database `czar` if it does not exist
#   2. creates the five service roles if they do not exist: czar_api, czar_signer, czar_indexer,
#      czar_merchants and czar_backup (read-only), each LOGIN and nothing more
#   3. sets each role's password from its credential file (so a rotated secret takes effect on the
#      next `up`)
#   4. applies ops/cloud/postgres/grants.sql to database `czar`
#
# Every step is idempotent.
#
# Credentials: each role's password is a file under the postgres-init credential folder, named
# after the role, written by czar-secrets.service from the same Secret Manager secret that role's
# service reads (secrets.list). The superuser has no password: this script connects over the unix
# socket as the image's postgres user (peer).
#
# A password never reaches the server as text. psql's \password computes the SCRAM-SHA-256
# verifier on the client and sends only that, so the password cannot appear in a server log line,
# in pg_stat_activity or in a STATEMENT line. It reads the new password from stdin when there is no
# terminal, and the password reaches stdin through `printf`, a shell builtin, so it is never an
# argument of any process and never in any environment.
#
# Pointers (all optional; defaults are the container layout):
#   PGHOST, PGPORT                   libpq's own: the socket folder and port
#   CZAR_PG_INIT_CREDENTIALS         the credential folder
#   CZAR_PG_INIT_GRANTS              grants.sql
set -eu

readonly CREDENTIALS="${CZAR_PG_INIT_CREDENTIALS:-/run/czar/secrets/postgres-init}"
readonly GRANTS="${CZAR_PG_INIT_GRANTS:-/etc/czar/postgres/grants.sql}"
readonly DATABASE=czar
readonly ROLES="czar_api czar_signer czar_indexer czar_merchants czar_backup"

log() { printf 'postgres-init: %s\n' "$*" >&2; }
fail() {
  log "error: $*"
  exit 1
}

psql_admin() {
  psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --username postgres "$@"
}

[ -f "$GRANTS" ] || fail "no grants file"
for role in $ROLES; do
  [ -s "$CREDENTIALS/$role" ] || fail "no credential file for $role"
done

# Wait for the socket: compose starts this after the healthcheck passes, but a restart of postgres
# alone can race it.
attempt=0
until pg_isready --quiet --username postgres --dbname postgres; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || fail "postgres did not become ready"
  sleep 1
done

psql_admin --dbname postgres <<'SQL'
SELECT 'CREATE DATABASE czar ENCODING ''UTF8'' TEMPLATE template0'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'czar')
\gexec
SQL

for role in $ROLES; do
  # czar_api runs the server migrations, and migration 0023 (the social network) creates the role
  # czar_social and makes the migrator a member of it. Postgres checks CREATEROLE before it checks
  # whether the role exists, so pre-creating czar_social here would not help. On Postgres 16 a
  # CREATEROLE role cannot create or alter a superuser, cannot hand out CREATEDB, REPLICATION or
  # BYPASSRLS, cannot grant predefined roles, and administers only the roles it created; and no role
  # it creates can log in, because pg_hba.conf admits only the five roles named there.
  createrole=NOCREATEROLE
  [ "$role" = czar_api ] && createrole=CREATEROLE
  psql_admin --dbname postgres --set role="$role" --set createrole="$createrole" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'role')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role')
\gexec
SELECT format(
  'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB %s NOREPLICATION NOBYPASSRLS INHERIT',
  :'role', :'createrole')
\gexec
SQL

  # A password file with a trailing newline is the same password, as the apps' readers trim it.
  password="$(cat "$CREDENTIALS/$role")"
  [ -n "$password" ] || fail "empty credential file for $role"
  printf '%s\n%s\n' "$password" "$password" |
    psql_admin --dbname postgres --command "\\password $role" >/dev/null 2>&1 ||
    fail "could not set the password for $role"
  password=""
done

psql_admin --dbname "$DATABASE" --file "$GRANTS" >/dev/null
log "roles and grants applied"
