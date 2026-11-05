#!/usr/bin/env bash
# shellcheck disable=SC2034
# (every name below is read by the scripts that source this file)
# Shared pieces of the nightly backup and the restore drill (SCR-170 §5, PM-052).
#
# Sourced by pg-backup.sh and pg-restore-drill.sh, never run. It holds the rules both scripts
# must agree on: how a Google access token is fetched, how the database password reaches libpq,
# which Storage endpoints are acceptable, and the one query that counts every table, so the
# backup and the drill count rows the same way.
#
# Nothing here prints a value that came from a credential file or the metadata server.

# Pointers, not values. Each default is the registry default for the config key named beside it;
# the base URLs are overridden by the unit test only.
# deploy.credentialFilesDir
readonly CREDENTIAL_FILES_DIR="${CZAR_CREDENTIAL_FILES_DIR:-/run/czar/secrets}"
# deploy.metadataTokenUrl
readonly METADATA_TOKEN_URL="${CZAR_METADATA_TOKEN_URL:-http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token}"
readonly STORAGE_BASE_URL="${CZAR_STORAGE_BASE_URL:-https://storage.googleapis.com}"
readonly OBJECT_PREFIX="czar" # objects are gs://<bucket>/czar/<UTC date>.dump and .counts.json

# Named limits and modes, so nothing here is a bare number.
readonly HTTP_TIMEOUT_SECONDS=15       # metadata token and small JSON calls
readonly TRANSFER_TIMEOUT_SECONDS=3600 # one dump upload or download; the alpha database is small
readonly TRANSFER_RETRIES=3            # curl retries transient (5xx, timeout) failures only
readonly TRANSFER_RETRY_DELAY_SECONDS=5
readonly PRIVATE_FILE_MODE=0600 # the token header file and the password file: root only
readonly SESSION_TIMEOUT_SECONDS=300 # longest wait for the snapshot session to answer

log() {
  printf '%s: %s\n' "$PROGRAM" "$1" >&2
}

fail() {
  log "$1"
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed"
}

# The Storage endpoint is Google's, or a loopback fake in the unit test. Anything else would
# send an access token to a host the VM's service account was never meant to talk to.
check_storage_base_url() {
  [[ "$STORAGE_BASE_URL" =~ ^https://storage\.googleapis\.com$ ||
    "$STORAGE_BASE_URL" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] ||
    fail "the storage endpoint must be https://storage.googleapis.com (or loopback in tests)"
}

check_bucket() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]] || fail "CZAR_BACKUP_BUCKET is not a bucket name"
}

# Postgres connection pointers. All of them are written into a pgpass line or passed to libpq
# as flags; none of them is a secret.
check_pg_pointers() {
  local host="$1" port="$2" user="$3"
  [[ "$host" =~ ^[A-Za-z0-9._-]+$ ]] || fail "the database host is not a plain host name"
  [[ "$port" =~ ^[0-9]{1,5}$ ]] || fail "the database port is not a number"
  [[ "$user" =~ ^[a-z_][a-z0-9_]*$ ]] || fail "the database user is not a plain role name"
}

# Writes a libpq password file (`host:port:database:user:password`) in a private folder.
#
# The password goes from the credential file straight into the .pgpass line through a pipe. It
# is never a variable, an argument or an environment value. `\` and `:` are escaped as libpq
# requires. The file is mode 0600 and lives in the work folder, which the EXIT trap removes.
write_pgpass() {
  local target="$1" host="$2" port="$3" database="$4" user="$5" password_file="$6"
  [[ -r "$password_file" ]] || fail "the database password file is not readable"
  [[ -s "$password_file" ]] || fail "the database password file is empty"
  : >"$target"
  chmod "$PRIVATE_FILE_MODE" "$target"
  {
    printf '%s:%s:%s:%s:' "$host" "$port" "$database" "$user"
    tr -d '\r\n' <"$password_file" | sed -e 's/[\\:]/\\&/g'
    printf '\n'
  } >>"$target"
}

# Fetches an access token from deploy.metadataTokenUrl and leaves it as an `Authorization`
# header line in a 0600 file. curl reads it with `-H @<file>`, so the token never appears in `ps`.
# Sets AUTHORIZATION_FILE.
authorize() {
  local work="$1"
  local token_body="$work/token.json"
  curl --silent --show-error --fail --max-time "$HTTP_TIMEOUT_SECONDS" \
    --header 'Metadata-Flavor: Google' "$METADATA_TOKEN_URL" >"$token_body" ||
    fail "the metadata server did not return an access token"

  # Checked BEFORE it is written: `jq -r '.access_token'` prints the literal `null` for a body
  # without the field, and a header of "Bearer null" would reach Storage as if it were a token.
  # `jq -e` exits non-zero instead.
  AUTHORIZATION_FILE="$work/authorization"
  : >"$AUTHORIZATION_FILE"
  chmod "$PRIVATE_FILE_MODE" "$AUTHORIZATION_FILE"
  {
    printf 'Authorization: Bearer '
    jq -e -j '.access_token | select(type == "string" and length > 0)' "$token_body"
  } >"$AUTHORIZATION_FILE" || fail "the metadata server returned a body with no access token"
  rm -f -- "$token_body"
}

# The object name in a URL path or query value: only `/` needs encoding, because the names are
# built here from a fixed prefix, a validated UTC date and a fixed suffix.
encode_object_name() {
  local name="$1"
  printf '%s' "${name//\//%2F}"
}

# One row of JSON: {"<schema>.<table>": <row count>, ...} for every ordinary and partitioned
# table in every non-system schema. Run inside the exported snapshot by the backup, and against
# the restored database by the drill, so both sides count the same set of tables the same way.
#
# query_to_xml runs a count(*) per table inside the caller's own transaction, so in the backup
# it sees exactly the snapshot and nothing a live write added afterwards.
count_tables_sql() {
  cat <<'SQL'
SELECT coalesce(
  jsonb_object_agg(
    n.nspname || '.' || c.relname,
    (xpath('/row/c/text()',
           query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                        false, true, '')))[1]::text::bigint
    ORDER BY n.nspname, c.relname),
  '{}'::jsonb)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\_toast%'
  AND n.nspname NOT LIKE 'pg\_temp\_%';
SQL
}
