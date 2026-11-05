#!/usr/bin/env bash
# czar-restore-drill: prove a named dump restores to the row counts recorded when it was taken
# (SCR-170 §5, PM-052).
#
# Usage: pg-restore-drill.sh --date <YYYY-MM-DD>
#
# What it does, in order:
#   1. Downloads gs://<bucket>/czar/<date>.dump and <date>.counts.json with a metadata-server token.
#   2. Creates a NEW database <prefix><date with underscores> (default czar_drill_2026_11_05).
#      It refuses to touch a database that already exists.
#   3. Restores the dump into it, then counts every table in every non-system schema with the same
#      query the backup used inside its exported snapshot.
#   4. Prints one row per table (recorded, restored, result) and a verdict, then drops the drill
#      database whatever the verdict was. Exit status 0 means every table matched.
#
# The drill role needs CREATEDB (the read-only czar_backup role cannot restore). Its password is
# optional: with CZAR_DRILL_PASSWORD_FILE set, it is copied into a 0600 .pgpass line that is removed
# on exit; without it libpq falls back to local trust or peer authentication. A password is never
# an environment variable or a command-line argument (D70, D78).
set -euo pipefail
umask 077

readonly PROGRAM="czar-restore-drill"
LIB_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"
readonly LIB_DIR
# shellcheck source=ops/cloud/backup/lib.sh
source "$LIB_DIR/lib.sh"

readonly BUCKET="${CZAR_BACKUP_BUCKET:-}"
readonly PGHOST_VALUE="${CZAR_DRILL_PGHOST:-127.0.0.1}"
readonly PGPORT_VALUE="${CZAR_DRILL_PGPORT:-5432}"
readonly PGUSER_VALUE="${CZAR_DRILL_PGUSER:-postgres}"
readonly DRILL_PASSWORD_FILE="${CZAR_DRILL_PASSWORD_FILE:-}"
readonly DRILL_DB_PREFIX="${CZAR_DRILL_DB_PREFIX:-czar_drill_}"
readonly WORK_ROOT="${CZAR_BACKUP_WORK_ROOT:-${STATE_DIRECTORY:-${TMPDIR:-/tmp}}}"

readonly CONNECT_TIMEOUT_SECONDS=15
readonly MAX_DATABASE_NAME_LENGTH=63 # Postgres identifier limit

work=""
drill_db=""
drill_db_created="no"
AUTHORIZATION_FILE=""

psql_admin() {
  psql --no-psqlrc --quiet --no-align --tuples-only --no-password \
    --set ON_ERROR_STOP=1 \
    --host "$PGHOST_VALUE" --port "$PGPORT_VALUE" --username "$PGUSER_VALUE" "$@"
}

drop_drill_database() {
  [[ "$drill_db_created" == "yes" ]] || return 0
  # WITH (FORCE) ends any session still connected, so the drill cannot leave a database behind.
  psql_admin --dbname postgres --command "DROP DATABASE IF EXISTS \"$drill_db\" WITH (FORCE)"
  drill_db_created="no"
}

cleanup() {
  local status=$?
  if [[ "$drill_db_created" == "yes" ]]; then
    drop_drill_database || log "could not drop the drill database $drill_db; drop it by hand"
  fi
  [[ -n "$work" && -d "$work" ]] && rm -rf -- "$work"
  return "$status"
}
trap cleanup EXIT

# GETs one object (alt=media) into a file. 404 is reported as "no such backup", anything but
# 200 is a failure, and an empty body is a failure.
download_object() {
  local object="$1" target="$2" status
  status="$(curl --silent --show-error --output "$target" --write-out '%{http_code}' \
    --max-time "$TRANSFER_TIMEOUT_SECONDS" --retry "$TRANSFER_RETRIES" \
    --retry-delay "$TRANSFER_RETRY_DELAY_SECONDS" -H @"$AUTHORIZATION_FILE" \
    "$STORAGE_BASE_URL/storage/v1/b/$BUCKET/o/$(encode_object_name "$object")?alt=media")" ||
    fail "could not reach Cloud Storage"
  case "$status" in
    200) ;;
    404) fail "there is no backup object $object" ;;
    *) fail "Cloud Storage answered HTTP $status to a download" ;;
  esac
  [[ -s "$target" ]] || fail "the downloaded object $object is empty"
  log "downloaded ${object##*.}: $(stat --format='%s' -- "$target") bytes"
}

main() {
  require curl
  require jq
  require psql
  require pg_restore
  require sed
  require tr

  local date_utc=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --date)
        date_utc="${2:-}"
        shift 2 || fail "--date needs a value"
        ;;
      *) fail "usage: pg-restore-drill.sh --date <YYYY-MM-DD>" ;;
    esac
  done
  [[ "$date_utc" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || fail "--date must look like 2026-11-05"
  date -u -d "$date_utc" +%Y-%m-%d >/dev/null 2>&1 || fail "--date is not a real date"
  [[ "$(date -u -d "$date_utc" +%Y-%m-%d)" == "$date_utc" ]] || fail "--date is not a real date"

  [[ -n "$BUCKET" ]] || fail "CZAR_BACKUP_BUCKET is not set"
  check_bucket "$BUCKET"
  check_storage_base_url
  check_pg_pointers "$PGHOST_VALUE" "$PGPORT_VALUE" "$PGUSER_VALUE"
  [[ -d "$WORK_ROOT" ]] || fail "the work folder root does not exist"

  drill_db="${DRILL_DB_PREFIX}${date_utc//-/_}"
  [[ "$DRILL_DB_PREFIX" =~ ^[a-z][a-z0-9_]*_$ ]] || fail "the drill database prefix is not plain"
  [[ "$drill_db" =~ ^[a-z][a-z0-9_]*$ ]] || fail "the drill database name is not plain"
  ((${#drill_db} <= MAX_DATABASE_NAME_LENGTH)) || fail "the drill database name is too long"

  work="$(mktemp -d -p "$WORK_ROOT" czar-drill.XXXXXXXX)"
  export PGCONNECT_TIMEOUT="$CONNECT_TIMEOUT_SECONDS"
  if [[ -n "$DRILL_PASSWORD_FILE" ]]; then
    write_pgpass "$work/pgpass" "$PGHOST_VALUE" "$PGPORT_VALUE" '*' "$PGUSER_VALUE" \
      "$DRILL_PASSWORD_FILE"
    export PGPASSFILE="$work/pgpass" # a path, not the password
  fi

  authorize "$work"
  local counts_file="$work/counts.json" dump_file="$work/dump.custom"
  download_object "$OBJECT_PREFIX/$date_utc.counts.json" "$counts_file"
  download_object "$OBJECT_PREFIX/$date_utc.dump" "$dump_file"

  # The recorded counts are checked before they are trusted: an object that parses but has no
  # tables would compare equal to an empty restore and pass the drill for nothing.
  jq -e '(.tables | type == "object" and length > 0)
         and ([.tables[]] | all(type == "number" and . >= 0))' "$counts_file" >/dev/null ||
    fail "the counts file does not hold a non-empty table count object"

  local exists
  exists="$(psql_admin --dbname postgres \
    --command "SELECT 1 FROM pg_database WHERE datname = '$drill_db'")"
  [[ -z "$exists" ]] || fail "the drill database $drill_db already exists; the drill will not reuse it"

  psql_admin --dbname postgres --command "CREATE DATABASE \"$drill_db\""
  drill_db_created="yes"

  # --no-owner/--no-privileges: the dump names production roles that do not exist here.
  # --single-transaction/--exit-on-error: a partial restore is a failed drill, not a smaller one.
  pg_restore --no-password --no-owner --no-privileges --single-transaction --exit-on-error \
    --host "$PGHOST_VALUE" --port "$PGPORT_VALUE" --username "$PGUSER_VALUE" \
    --dbname "$drill_db" "$dump_file" || fail "pg_restore failed"
  log "restored into a new database"

  psql_admin --dbname "$drill_db" --command "$(count_tables_sql)" >"$work/restored.json"
  jq -e 'type == "object"' "$work/restored.json" >/dev/null ||
    fail "the restored database did not return table counts"

  local verdict_file="$work/verdict.txt"
  # One tab-separated row per table in either set. A table on one side only counts as a mismatch.
  jq -r -n --slurpfile recorded "$counts_file" --slurpfile restored "$work/restored.json" '
    ($recorded[0].tables) as $a | ($restored[0]) as $b
    | (($a | keys) + ($b | keys) | unique) as $names
    | [$names[] | . as $n
        | {n: $n, a: $a[$n], b: $b[$n]}
        | . + {ok: (.a != null and .b != null and .a == .b)}] as $rows
    | (["TABLE", "RECORDED", "RESTORED", "RESULT"] | @tsv),
      ($rows[] | [.n, (.a // "missing"), (.b // "missing"), (if .ok then "equal" else "MISMATCH" end)] | @tsv),
      "VERDICT " + (if ($rows | all(.ok)) then "PASS" else "FAIL" end)
        + " " + ($rows | length | tostring) + " tables"
  ' >"$verdict_file" || fail "could not compare the counts"
  cat "$verdict_file"

  drop_drill_database
  log "dropped the drill database"

  tail -n 1 "$verdict_file" | grep -q '^VERDICT PASS ' || fail "the restore drill FAILED"
  log "the restore drill PASSED"
}

main "$@"
