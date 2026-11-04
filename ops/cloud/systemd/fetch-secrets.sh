#!/usr/bin/env bash
# czar-secrets: write the boot-time credential files (SCR-170 §4).
#
# Credentials are files, never environment variables, command-line arguments, image layers,
# compose files or config values (D70, D78). This script reads the NAMES in secrets.list, asks
# the VM metadata server for a short-lived access token, reads the latest version of each secret
# from Secret Manager over REST, and writes it under deploy.credentialFilesDir as mode 0400 owned
# by the container UID that reads it.
#
# It never prints a value, never puts one on a command line, never exports one, and never writes
# one outside deploy.credentialFilesDir. The access token lives in a 0600 file in a private work
# folder and reaches curl through `-H @<file>`, so it never appears in `ps`.
#
# Run by czar-secrets.service at boot, as root, after run-czar-secrets.mount and before Docker.
set -euo pipefail
umask 077

# Pointers, not values. Each default is the registry default for the config key named beside it;
# the metadata and Secret Manager base URLs are overridden by the unit test only.
readonly SECRETS_LIST="${CZAR_SECRETS_LIST:-/opt/czar/ops/secrets.list}"
# deploy.credentialFilesDir
readonly CREDENTIAL_FILES_DIR="${CZAR_CREDENTIAL_FILES_DIR:-/run/czar/secrets}"
# deploy.metadataTokenUrl
readonly METADATA_TOKEN_URL="${CZAR_METADATA_TOKEN_URL:-http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token}"
readonly METADATA_PROJECT_URL="${CZAR_METADATA_PROJECT_URL:-http://metadata.google.internal/computeMetadata/v1/project/project-id}"
readonly SECRET_MANAGER_BASE_URL="${CZAR_SECRET_MANAGER_BASE_URL:-https://secretmanager.googleapis.com}"

# Named limits and modes, so nothing here is a bare number.
readonly HTTP_TIMEOUT_SECONDS=15 # one boot-time read per secret; well under the unit's timeout
readonly SERVICE_DIR_MODE=0500   # a service may read its own folder; no other UID may list it
readonly SERVICE_DIR_WORK_MODE=0700 # while this script is still writing into the folder
readonly CREDENTIAL_FILE_MODE=0400  # read-only to the one UID that needs it
readonly AUTHORIZATION_FILE_MODE=0600 # root only, for the few seconds the token is on tmpfs
readonly EXPECTED_FIELDS=5          # secret service file uid requirement

work=""
partial=""

log() {
  printf 'czar-secrets: %s\n' "$1" >&2
}

fail() {
  log "$1"
  exit 1
}

cleanup() {
  [[ -n "$partial" && -e "$partial" ]] && rm -f -- "$partial"
  [[ -n "$work" && -d "$work" ]] && rm -rf -- "$work"
  return 0
}
trap cleanup EXIT

require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed"
}

# Parallel arrays: one entry per row of secrets.list.
names=()
services=()
files=()
uids=()
requirements=()
declare -A service_uid=()

read_list() {
  [[ -r "$SECRETS_LIST" ]] || fail "the credential list is not readable"

  local raw line number=0
  local -a fields
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    number=$((number + 1))
    line="${raw%%#*}"
    fields=()
    read -r -a fields <<<"$line"
    [[ ${#fields[@]} -eq 0 ]] && continue
    if [[ ${#fields[@]} -ne $EXPECTED_FIELDS ]]; then
      fail "line $number of the credential list has ${#fields[@]} fields, not $EXPECTED_FIELDS"
    fi

    local name="${fields[0]}" service="${fields[1]}" file="${fields[2]}"
    local uid="${fields[3]}" requirement="${fields[4]}"

    # The service account is granted secretmanager.secretAccessor on czar-alpha-* only.
    [[ "$name" =~ ^czar-alpha-[a-z0-9-]+$ ]] || fail "line $number: bad secret name"
    # A service is one path segment, so it cannot climb out of the credential folder.
    [[ "$service" =~ ^[a-z][a-z0-9-]*$ ]] || fail "line $number: bad service name"
    # A file is one or more plain path segments: no leading slash, no dot segments.
    [[ "$file" =~ ^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$ ]] ||
      fail "line $number: bad destination file name"
    [[ "$file" != *".."* ]] || fail "line $number: bad destination file name"
    [[ "$uid" =~ ^[0-9]+$ ]] || fail "line $number: uid is not a number"
    case "$requirement" in
      required | optional) ;;
      *) fail "line $number: requirement must be required or optional" ;;
    esac

    if [[ -n "${service_uid[$service]:-}" && "${service_uid[$service]}" != "$uid" ]]; then
      fail "line $number: service $service is listed with two different UIDs"
    fi
    service_uid["$service"]="$uid"

    names+=("$name")
    services+=("$service")
    files+=("$file")
    uids+=("$uid")
    requirements+=("$requirement")
  done <"$SECRETS_LIST"

  [[ ${#names[@]} -gt 0 ]] || fail "the credential list names nothing"
}

# One folder per service, which is the only folder that service's container is shown.
prepare_folders() {
  local index service dir
  for index in "${!names[@]}"; do
    service="${services[$index]}"
    dir="$(dirname -- "$CREDENTIAL_FILES_DIR/$service/${files[$index]}")"
    case "$dir" in
      "$CREDENTIAL_FILES_DIR/"*) ;;
      *) fail "refusing a destination outside the credential folder" ;;
    esac
    mkdir -p -- "$dir"
    chown "${uids[$index]}" "$dir"
    chmod "$SERVICE_DIR_WORK_MODE" "$dir"
  done
}

seal_folders() {
  local service
  for service in "${!service_uid[@]}"; do
    find "$CREDENTIAL_FILES_DIR/$service" -depth -type d -exec chmod "$SERVICE_DIR_MODE" {} +
  done
}

authorization_file=""
project=""

authorize() {
  local token_body="$work/token.json"
  curl --silent --show-error --fail --max-time "$HTTP_TIMEOUT_SECONDS" \
    --header 'Metadata-Flavor: Google' "$METADATA_TOKEN_URL" >"$token_body" ||
    fail "the metadata server did not return an access token"

  authorization_file="$work/authorization"
  : >"$authorization_file"
  chmod "$AUTHORIZATION_FILE_MODE" "$authorization_file"
  # The token goes straight from the response file into a header file. It is never a variable,
  # never an argument and never logged.
  {
    printf 'Authorization: Bearer '
    jq -r '.access_token' "$token_body"
  } >"$authorization_file"
  rm -f -- "$token_body"

  project="$(curl --silent --show-error --fail --max-time "$HTTP_TIMEOUT_SECONDS" \
    --header 'Metadata-Flavor: Google' "$METADATA_PROJECT_URL")" ||
    fail "the metadata server did not return the project id"
  [[ "$project" =~ ^[a-z][a-z0-9-]*$ ]] || fail "the metadata server returned a bad project id"
}

fetch_one() {
  local name="$1" dest="$2" uid="$3" requirement="$4"
  local body="$work/body.json"
  local status

  status="$(curl --silent --show-error --output "$body" --write-out '%{http_code}' \
    --max-time "$HTTP_TIMEOUT_SECONDS" -H @"$authorization_file" \
    "$SECRET_MANAGER_BASE_URL/v1/projects/$project/secrets/$name/versions/latest:access")" ||
    fail "$name: could not reach Secret Manager"

  case "$status" in
    200) ;;
    404)
      if [[ "$requirement" == "optional" ]]; then
        log "$name has no version yet; skipped, because it is optional"
        rm -f -- "$body"
        return 0
      fi
      fail "$name has no accessible version and is required"
      ;;
    *)
      # Anything else, including 403, is a misconfiguration. Never read as "not configured".
      fail "$name: Secret Manager answered HTTP $status"
      ;;
  esac

  partial="$dest.partial"
  jq -r '.payload.data' "$body" | base64 --decode >"$partial"
  rm -f -- "$body"
  chown "$uid" "$partial"
  chmod "$CREDENTIAL_FILE_MODE" "$partial"
  # Same tmpfs, so this is a rename: the file is never briefly world-readable at its real name.
  mv -f -- "$partial" "$dest"
  partial=""
  log "wrote $name"
}

main() {
  require curl
  require jq
  require base64

  [[ -d "$CREDENTIAL_FILES_DIR" ]] || fail "the credential folder is not mounted"

  read_list
  work="$(mktemp -d)"
  prepare_folders
  authorize

  local index
  for index in "${!names[@]}"; do
    fetch_one \
      "${names[$index]}" \
      "$CREDENTIAL_FILES_DIR/${services[$index]}/${files[$index]}" \
      "${uids[$index]}" \
      "${requirements[$index]}"
  done

  seal_folders
  log "wrote ${#names[@]} credential rows for ${#service_uid[@]} services"
}

main "$@"
