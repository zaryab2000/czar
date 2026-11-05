#!/usr/bin/env bash
# Czar public alpha: uptime checks, resource alerts and the low-gas alert (SCR-170 §1; PM-051).
#
# NOTHING HAPPENS WITHOUT --apply. The default is --dry-run, which prints the command list to
# stdout and runs nothing at all. Creating the notification channel, the checks, the metric and
# the policies in Google Cloud is Zaryab's approval item; this script exists so that the whole set
# of commands can be reviewed as code first.
#
#   review:  ops/cloud/monitoring/create-alerts.sh --project <id> --domain <domain>
#   create:  ops/cloud/monitoring/create-alerts.sh --project <id> --domain <domain> \
#              --email <operator address> --apply
#
# The email address is a flag the operator fills in at apply time. The repository holds none; the
# dry run prints a placeholder when --email is not given, and --apply refuses to run without one.
# The commands are not idempotent: run --apply once. A second run would create duplicates.
#
# What it makes (all in the one project):
#   - one email notification channel
#   - uptime checks on https://app.<domain>/health and https://merchants.<domain>/health,
#     every 60 s, from three regions
#   - a log-based metric counting signer_gas_low log events, labelled by key id (K3, K7, K8, relayer)
#   - four alert policies: uptime failing 2 min, disk above 80%, memory above 90% for 10 min,
#     any signer_gas_low in 5 min
#
# Not done here: installing ops-agent.yaml on the VM. The disk and memory policies stay silent until
# it is installed (see the end of the --apply run, and the header of ops-agent.yaml).
set -euo pipefail

readonly CHANNEL_NAME="czar-alpha-ops-email"
readonly CHANNEL_PLACEHOLDER="@CHANNEL_NAME@" # replaced by the real channel name during --apply
readonly EMAIL_PLACEHOLDER="OPERATOR_EMAIL_ADDRESS"
readonly UPTIME_PERIOD_MINUTES=1                 # SCR-170 §1 task: every 60 s
readonly UPTIME_TIMEOUT_SECONDS=10
readonly UPTIME_REGIONS="usa-oregon,europe,asia-pacific" # three regions; Google needs at least 3
readonly UPTIME_PATH="/health"
readonly GAS_METRIC_NAME="czar_signer_gas_low_events"

readonly METRIC_FILE="ops/cloud/monitoring/metrics/signer-gas-low.json"
readonly POLICY_FILES=(
  "ops/cloud/monitoring/policies/uptime-failing.json"
  "ops/cloud/monitoring/policies/disk-high.json"
  "ops/cloud/monitoring/policies/memory-high.json"
  "ops/cloud/monitoring/policies/signer-gas-low.json"
)

project=""
domain=""
email=""
apply="no"

usage() {
  cat <<'USAGE'
Usage: create-alerts.sh --project <id> --domain <domain> [--email <address>] [--apply]

  --project <id>    the Google Cloud project (required)
  --domain <domain> the public domain; app.<domain> and merchants.<domain> are checked (required)
  --email <address> where alerts are sent; required with --apply, a placeholder is printed without it
  --dry-run         print the command list and run nothing (the default)
  --apply           run the commands; needs Zaryab's approval first
USAGE
}

fail() {
  printf 'create-alerts.sh: %s\n' "$1" >&2
  usage >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      project="${2:-}"
      shift 2 || fail "--project needs a value"
      ;;
    --domain)
      domain="${2:-}"
      shift 2 || fail "--domain needs a value"
      ;;
    --email)
      email="${2:-}"
      shift 2 || fail "--email needs a value"
      ;;
    --dry-run)
      apply="no"
      shift
      ;;
    --apply)
      apply="yes"
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

# Every flag is validated before it is put in a command, so the command list can be split on
# whitespace and run as argv with no shell expansion anywhere.
[[ -n "$project" ]] || fail "--project is required"
[[ -n "$domain" ]] || fail "--domain is required"
[[ "$project" =~ ^[a-z][a-z0-9-]*$ ]] || fail "--project is not a project id"
[[ ${#project} -le 30 ]] || fail "--project is too long for a project id"
[[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
  fail "--domain is not a domain name"
if [[ -n "$email" ]]; then
  [[ "$email" =~ ^[A-Za-z0-9._+-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]] ||
    fail "--email is not an email address"
fi
if [[ "$apply" == "yes" && -z "$email" ]]; then
  fail "--apply needs --email <address>: the repository holds no address"
fi
email_for_command="${email:-$EMAIL_PLACEHOLDER}"

# Paths are printed relative to the repository root, so the printed list is the same on every
# machine and can be diffed in review.
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"

# The command list, and a parallel list naming the placeholder a command's output fills. Only the
# channel-create command captures anything: the policies need its name.
commands=()
captures=()

add() {
  commands+=("$1")
  captures+=("")
}

add_capture() {
  commands+=("$1")
  captures+=("$2")
}

build_command_list() {
  local file host name
  # ---- 1. the one email channel; its name is captured for the policies --------------------
  add_capture "gcloud beta monitoring channels create --project=$project --display-name=$CHANNEL_NAME --type=email --channel-labels=email_address=$email_for_command --format=value(name)" "$CHANNEL_PLACEHOLDER"

  # ---- 2. uptime checks on /health, every 60 s, from three regions -----------------------
  for host in "app.$domain" "merchants.$domain"; do
    name="czar-alpha-${host%%.*}-health"
    add "gcloud monitoring uptime create $name --project=$project --resource-type=uptime-url --resource-labels=host=$host,project_id=$project --protocol=https --path=$UPTIME_PATH --period=$UPTIME_PERIOD_MINUTES --regions=$UPTIME_REGIONS --timeout=$UPTIME_TIMEOUT_SECONDS --validate-ssl=true --status-classes=2xx"
  done

  # ---- 3. the log-based metric, before the policy that reads it --------------------------
  add "gcloud logging metrics create $GAS_METRIC_NAME --project=$project --config-from-file=$METRIC_FILE"

  # ---- 4. the alert policies, each sending to the one channel ----------------------------
  for file in "${POLICY_FILES[@]}"; do
    add "gcloud monitoring policies create --project=$project --policy-from-file=$file --notification-channels=$CHANNEL_PLACEHOLDER"
  done
}

# Prints one token so that the line pastes into a shell and means the same thing: a token with a
# character outside the plain set is single-quoted. No token can contain a single quote, because
# every flag was validated above.
quote_token() {
  if [[ "$1" =~ ^[A-Za-z0-9_@%+=:,./-]+$ ]]; then
    printf '%s' "$1"
  else
    printf "'%s'" "$1"
  fi
}

print_command() {
  local -a argv
  local token first="yes"
  read -r -a argv <<<"$1"
  for token in "${argv[@]}"; do
    if [[ "$first" == "yes" ]]; then first="no"; else printf ' '; fi
    # --format=value(name) is quoted as a unit: the flag name stays plain, its value is quoted.
    if [[ "$token" == --*=*[\(\)]* ]]; then
      printf '%s=' "${token%%=*}"
      quote_token "${token#*=}"
    else
      quote_token "$token"
    fi
  done
  printf '\n'
}

print_command_list() {
  local rendered
  for rendered in "${commands[@]}"; do
    print_command "$rendered"
  done
}

run_command_list() {
  local index rendered placeholder value
  local -a argv
  for index in "${!commands[@]}"; do
    rendered="${commands[$index]}"
    printf 'create-alerts.sh: running step %d of %d\n' "$((index + 1))" "${#commands[@]}" >&2
    argv=()
    read -r -a argv <<<"$rendered"
    placeholder="${captures[$index]}"
    if [[ -n "$placeholder" ]]; then
      value="$("${argv[@]}")" || fail "step $((index + 1)) failed; nothing after it has run"
      [[ "$value" =~ ^projects/[a-z][a-z0-9-]*/notificationChannels/[0-9]+$ ]] ||
        fail "step $((index + 1)) did not return a notification channel name"
      # Fill the placeholder in every command after this one.
      local later
      for ((later = index + 1; later < ${#commands[@]}; later++)); do
        commands[later]="${commands[$later]//$placeholder/$value}"
      done
      continue
    fi
    "${argv[@]}" || fail "step $((index + 1)) failed; nothing after it has run"
  done
}

main() {
  local file
  for file in "$METRIC_FILE" "${POLICY_FILES[@]}"; do
    [[ -f "$repo_root/$file" ]] || fail "missing definition file: $file"
  done
  build_command_list

  if [[ "$apply" == "yes" ]]; then
    command -v gcloud >/dev/null 2>&1 || fail "gcloud is not installed"
    cd -- "$repo_root"
    printf 'create-alerts.sh: applying %d commands to project %s\n' "${#commands[@]}" "$project" >&2
    run_command_list
    printf 'create-alerts.sh: done. Now install ops-agent.yaml on the VM (see its header); the disk and memory alerts need it.\n' >&2
    return 0
  fi

  # Dry run. stdout is the command list and nothing else, so it diffs cleanly in review.
  print_command_list
  printf 'create-alerts.sh: dry run. %d commands printed, none run. Add --email and --apply to run them.\n' \
    "${#commands[@]}" >&2
}

main "$@"
