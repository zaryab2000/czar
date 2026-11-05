#!/usr/bin/env bash
# czar-backup: dump the czar database to Cloud Storage (SCR-170 §5, PM-052).
#
# What it does, in order:
#   1. Opens ONE session as the read-only role czar_backup, starts a REPEATABLE READ transaction
#      and calls pg_export_snapshot(). That session stays open until the dump has finished.
#   2. Inside that same snapshot, counts the rows of every table in every non-system schema.
#   3. Runs `pg_dump --format=custom --snapshot=<id>` from a second connection, so the dump and
#      the counts describe exactly the same instant. A write that lands while the dump runs can
#      therefore never make the restore drill report a false mismatch.
#   4. Uploads <date>.counts.json and then <date>.dump to gs://<bucket>/czar/ through the Storage
#      JSON API with a short-lived metadata-server token. The dump goes last, so a dump object
#      always has its counts beside it.
#
# It prints sizes in bytes and nothing else about the data: no table names, no row values, no
# token, no password. The password comes from the credential file czar-secrets.service wrote
# (backup/db-password); it is copied into a 0600 .pgpass line in a private work folder that the
# EXIT trap removes. It is never an environment variable or a command-line argument (D70, D78).
#
# Run by czar-backup.service as root, which is one of the two UIDs the metadata guard lets through.
set -euo pipefail
umask 077

readonly PROGRAM="czar-backup"
LIB_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"
readonly LIB_DIR
# shellcheck source=ops/cloud/backup/lib.sh
source "$LIB_DIR/lib.sh"

# Pointers, not values. The bucket has no default: create.sh names it per project.
readonly BUCKET="${CZAR_BACKUP_BUCKET:-}"
readonly PGHOST_VALUE="${CZAR_BACKUP_PGHOST:-127.0.0.1}" # SCR-170 §5: loopback only
readonly PGPORT_VALUE="${CZAR_BACKUP_PGPORT:-5432}"
readonly PGUSER_VALUE="${CZAR_BACKUP_PGUSER:-czar_backup}" # SCR-170 §5: the read-only role
readonly PGDATABASE_VALUE="${CZAR_BACKUP_PGDATABASE:-czar}"
readonly PASSWORD_FILE="$CREDENTIAL_FILES_DIR/backup/db-password" # secrets.list: backup db-password
readonly WORK_ROOT="${CZAR_BACKUP_WORK_ROOT:-${STATE_DIRECTORY:-${TMPDIR:-/tmp}}}"

readonly CONNECT_TIMEOUT_SECONDS=15 # libpq connect timeout; the database is on this machine

work=""
snapshot_pid=""
snapshot_in=""
AUTHORIZATION_FILE=""

cleanup() {
  # Stop the snapshot session if it is still alive, then remove everything that held a token or
  # a password. Both steps are safe to repeat.
  if [[ -n "$snapshot_pid" ]] && kill -0 "$snapshot_pid" 2>/dev/null; then
    kill "$snapshot_pid" 2>/dev/null || true
  fi
  [[ -n "$work" && -d "$work" ]] && rm -rf -- "$work"
  return 0
}
trap cleanup EXIT

file_size() {
  stat --format='%s' -- "$1"
}

# The snapshot session. psql reads commands from a coprocess pipe, so the transaction that owns
# the exported snapshot stays open while pg_dump runs in another connection.
#   SNAP[0] reads psql's output, SNAP[1] writes to its input.
snapshot=""
counts_json=""

open_snapshot_session() {
  coproc SNAP {
    psql --no-psqlrc --quiet --no-align --tuples-only --no-password \
      --set ON_ERROR_STOP=1 \
      --host "$PGHOST_VALUE" --port "$PGPORT_VALUE" \
      --username "$PGUSER_VALUE" --dbname "$PGDATABASE_VALUE"
  }
  snapshot_pid="$SNAP_PID"
  snapshot_in="${SNAP[1]}"
}

# Sends one batch of SQL, then reads output lines until the end marker. psql exiting early (a
# failed statement under ON_ERROR_STOP) shows up as EOF or a timeout and stops the backup.
session_ask() {
  local sql="$1" marker="CZAR_SESSION_DONE" line
  session_reply=""
  printf '%s\n\\echo %s\n' "$sql" "$marker" >&"$snapshot_in" ||
    fail "the snapshot session closed before it was asked"
  while IFS= read -r -t "$SESSION_TIMEOUT_SECONDS" -u "${SNAP[0]}" line; do
    [[ "$line" == "$marker" ]] && return 0
    session_reply+="$line"$'\n'
  done
  fail "the snapshot session ended or timed out"
}

take_snapshot_and_counts() {
  open_snapshot_session

  # The first statement of a REPEATABLE READ transaction fixes its snapshot, so
  # pg_export_snapshot() must be that statement.
  session_ask "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;"
  session_ask "SELECT pg_export_snapshot();"
  snapshot="${session_reply%$'\n'}"
  # 00000003-0000001B-1: transaction id, virtual id, counter — hex and dashes only.
  [[ "$snapshot" =~ ^[0-9A-F]{8}-[0-9A-F]{8}-[0-9]+$ ]] ||
    fail "the database did not return a snapshot id"

  session_ask "$(count_tables_sql)"
  counts_json="${session_reply%$'\n'}"
  jq -e 'type == "object" and length > 0 and ([.[]] | all(type == "number" and . >= 0))' \
    <<<"$counts_json" >/dev/null ||
    fail "the snapshot counts are not a non-empty object of row counts"
}

close_snapshot_session() {
  # EOF on psql's input ends the read-only transaction, which releases the snapshot.
  exec {snapshot_in}>&-
  wait "$snapshot_pid" || true
  snapshot_pid=""
}

# POSTs one file to the Storage JSON API as a simple media upload and checks the object
# resource Storage answers with. A 200 with a body that does not name this object, or a size that
# is not the local file's size, is a failed upload, not a success.
upload_object() {
  local file="$1" object="$2"
  local size response status
  size="$(file_size "$file")"
  response="$work/upload-response.json"

  status="$(curl --silent --show-error --output "$response" --write-out '%{http_code}' \
    --max-time "$TRANSFER_TIMEOUT_SECONDS" --retry "$TRANSFER_RETRIES" \
    --retry-delay "$TRANSFER_RETRY_DELAY_SECONDS" \
    -H @"$AUTHORIZATION_FILE" --header 'Content-Type: application/octet-stream' \
    --request POST --upload-file "$file" \
    "$STORAGE_BASE_URL/upload/storage/v1/b/$BUCKET/o?uploadType=media&name=$(encode_object_name "$object")")" ||
    fail "could not reach Cloud Storage"
  [[ "$status" == "200" ]] || fail "Cloud Storage answered HTTP $status to an upload"

  jq -e --arg name "$object" --arg bucket "$BUCKET" --argjson size "$size" \
    '.name == $name and .bucket == $bucket and ((.size | tostring | tonumber) == $size)' \
    "$response" >/dev/null ||
    fail "Cloud Storage did not confirm the uploaded object"
  rm -f -- "$response"
  log "uploaded ${object##*.}: $size bytes"
}

main() {
  require curl
  require jq
  require psql
  require pg_dump
  require sed
  require tr

  [[ -n "$BUCKET" ]] || fail "CZAR_BACKUP_BUCKET is not set"
  check_bucket "$BUCKET"
  check_storage_base_url
  check_pg_pointers "$PGHOST_VALUE" "$PGPORT_VALUE" "$PGUSER_VALUE"
  [[ "$PGDATABASE_VALUE" =~ ^[a-z_][a-z0-9_]*$ ]] || fail "the database name is not plain"
  [[ -d "$WORK_ROOT" ]] || fail "the work folder root does not exist"

  local date_utc
  date_utc="$(date -u +%Y-%m-%d)"
  local dump_object="$OBJECT_PREFIX/$date_utc.dump"
  local counts_object="$OBJECT_PREFIX/$date_utc.counts.json"

  work="$(mktemp -d -p "$WORK_ROOT" czar-backup.XXXXXXXX)"
  write_pgpass "$work/pgpass" "$PGHOST_VALUE" "$PGPORT_VALUE" "$PGDATABASE_VALUE" \
    "$PGUSER_VALUE" "$PASSWORD_FILE"
  export PGPASSFILE="$work/pgpass" # a path, not the password
  export PGCONNECT_TIMEOUT="$CONNECT_TIMEOUT_SECONDS"

  take_snapshot_and_counts

  local dump_file="$work/dump.custom" counts_file="$work/counts.json"
  pg_dump --format=custom --snapshot="$snapshot" --no-password \
    --host "$PGHOST_VALUE" --port "$PGPORT_VALUE" \
    --username "$PGUSER_VALUE" --dbname "$PGDATABASE_VALUE" \
    --file "$dump_file" || fail "pg_dump failed"
  [[ -s "$dump_file" ]] || fail "pg_dump wrote an empty file"

  jq -n --arg snapshot "$snapshot" --arg takenAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg database "$PGDATABASE_VALUE" --argjson tables "$counts_json" \
    '{snapshot: $snapshot, takenAt: $takenAt, database: $database, tables: $tables}' \
    >"$counts_file" || fail "could not write the counts file"

  # The snapshot has done its job once pg_dump has read it.
  close_snapshot_session

  log "dump: $(file_size "$dump_file") bytes"
  authorize "$work"
  upload_object "$counts_file" "$counts_object"
  upload_object "$dump_file" "$dump_object"
  log "done"
}

main "$@"
