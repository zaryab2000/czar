#!/usr/bin/env bash
# czar-metadata-guard: only root and the signer may reach the GCE metadata server.
#
# SCR-170 §4: every Czar container runs with `network_mode: host`, so each one shares the host's
# network stack. Without this rule a compromised container could fetch a service-account token
# from the metadata server and call Cloud KMS `asymmetricSign` on K3, K7, K8 or K10 directly,
# skipping the signer's policy, or read every credential out of Secret Manager.
#
# Root keeps access because czar-secrets.service, the backup timer and the Ops Agent need it.
# The signer keeps access because signing is its job. Nobody else: not the UID every other Czar
# container runs as, not any other. The only UIDs this file may name are the two below, and
# ops/cloud/test/metadata-guard.test.ts fails if a third one ever appears.
#
# ---------------------------------------------------------------------------------------------
# WHY THREE RULES AND NOT ONE
#
# SCR-170 §4 writes the guard as a single negated rule:
#
#   iptables -A OUTPUT -d 169.254.169.254 -m owner ! --uid-owner 0 ! --uid-owner 10002 -j REJECT
#
# iptables REFUSES that rule. One `-m owner` match takes `--uid-owner` only once:
#
#   $ iptables -C OUTPUT -d 169.254.169.254 -m owner ! --uid-owner 0 ! --uid-owner 10002 -j REJECT
#   iptables v1.8.10 (nf_tables): owner: option "--uid-owner" can only be used once.   (exit 2)
#
# So the spec's rule can never be installed. The same three UIDs are expressed instead as
# allow-then-reject, which is semantically identical and which iptables does accept:
#
#   -A OUTPUT -d <metadata> -m owner --uid-owner 0      -j ACCEPT
#   -A OUTPUT -d <metadata> -m owner --uid-owner 10002  -j ACCEPT
#   -A OUTPUT -d <metadata>                             -j REJECT
#
# ORDER IS LOAD-BEARING. The REJECT must be the last of the three. If it were appended first,
# it would shadow both ACCEPTs and lock root and the signer out of the metadata server, which
# would break czar-secrets.service, the backups, the Ops Agent and all signing. So this script
# never appends into a partial state: if any of the three is missing, it removes whichever are
# present and appends all three in order.
# ---------------------------------------------------------------------------------------------
#
# Run by czar-metadata-guard.service at every boot, before docker.service.
set -euo pipefail

readonly METADATA_IPV4="169.254.169.254" # SCR-170 §4
readonly METADATA_IPV6="fd00:ec2::254"   # SCR-170 §4
readonly ROOT_UID=0                      # czar-secrets.service, the backup timer, the Ops Agent
readonly SIGNER_UID=10002                # the signer image's user (SCR-170 §4)

# The three rules, named, in the order they must appear in the OUTPUT chain.
readonly RULES=(accept-root accept-signer reject-everyone-else)

# Where the kernel reports IPv6 interfaces. Overridden by the unit test only; never in production.
readonly IF_INET6_PATH="${CZAR_IF_INET6_PATH:-/proc/net/if_inet6}"

log() {
  printf 'czar-metadata-guard: %s\n' "$1" >&2
}

fail() {
  log "$1"
  exit 1
}

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "$1 is not installed; refusing to continue, so Docker does not start unguarded"
    exit 1
  fi
}

# Prints one rule's arguments, one per line, ready for mapfile. The chain name comes first, so
# the caller only has to prepend the action (-C, -A or -D).
rule_args() {
  local which="$1"
  local destination="$2"
  case "$which" in
    accept-root)
      printf '%s\n' OUTPUT -d "$destination" -m owner --uid-owner "$ROOT_UID" -j ACCEPT
      ;;
    accept-signer)
      printf '%s\n' OUTPUT -d "$destination" -m owner --uid-owner "$SIGNER_UID" -j ACCEPT
      ;;
    reject-everyone-else)
      printf '%s\n' OUTPUT -d "$destination" -j REJECT
      ;;
    *)
      log "unknown rule name: $which"
      return 64
      ;;
  esac
}

# 0 = the rule is present, 1 = it is absent. Anything else is a rule iptables will not accept,
# and that ends the script rather than being read as "absent" — the mistake that made the
# spec's single-rule form look like a missing rule instead of a parse error.
check_rule() {
  local tool="$1"
  local which="$2"
  local destination="$3"
  local -a args=()
  mapfile -t args < <(rule_args "$which" "$destination")
  [[ ${#args[@]} -gt 0 ]] || fail "could not build the $which rule"

  local status=0
  "$tool" -C "${args[@]}" >/dev/null 2>&1 || status=$?
  case "$status" in
    0) return 0 ;;
    1) return 1 ;;
    *)
      fail "$tool will not accept the $which rule (exit $status); it does not parse"
      ;;
  esac
}

run_rule() {
  local tool="$1"
  local action="$2"
  local which="$3"
  local destination="$4"
  local -a args=()
  mapfile -t args < <(rule_args "$which" "$destination")
  [[ ${#args[@]} -gt 0 ]] || fail "could not build the $which rule"
  "$tool" "$action" "${args[@]}"
}

apply_rules() {
  local tool="$1"
  local destination="$2"
  local which
  local missing=0

  for which in "${RULES[@]}"; do
    check_rule "$tool" "$which" "$destination" || missing=$((missing + 1))
  done

  if [[ $missing -eq 0 ]]; then
    log "$tool rules already in place for $destination"
    return 0
  fi

  # Clear any partial state first, so the append below cannot put the REJECT before an ACCEPT.
  for which in "${RULES[@]}"; do
    while check_rule "$tool" "$which" "$destination"; do
      run_rule "$tool" -D "$which" "$destination"
    done
  done

  for which in "${RULES[@]}"; do
    run_rule "$tool" -A "$which" "$destination"
  done
  log "$tool rules applied for $destination"
}

main() {
  require iptables
  apply_rules iptables "$METADATA_IPV4"

  if [[ -e "$IF_INET6_PATH" ]]; then
    require ip6tables
    apply_rules ip6tables "$METADATA_IPV6"
  else
    log "IPv6 is off on this host; no ip6tables rules needed"
  fi
}

main "$@"
