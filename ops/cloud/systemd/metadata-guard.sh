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
# Run by czar-metadata-guard.service at every boot, before docker.service. It is idempotent:
# it asks iptables whether the rule is already there before adding it.
set -euo pipefail

readonly METADATA_IPV4="169.254.169.254" # SCR-170 §4
readonly METADATA_IPV6="fd00:ec2::254"   # SCR-170 §4
readonly ROOT_UID=0                      # czar-secrets.service, the backup timer, the Ops Agent
readonly SIGNER_UID=10002                # the signer image's user (SCR-170 §4)

# Where the kernel reports IPv6 interfaces. Overridden by the unit test only; never in production.
readonly IF_INET6_PATH="${CZAR_IF_INET6_PATH:-/proc/net/if_inet6}"

log() {
  printf 'czar-metadata-guard: %s\n' "$1" >&2
}

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "$1 is not installed; refusing to continue, so Docker does not start unguarded"
    exit 1
  fi
}

# Adds the REJECT rule for one address family, after checking it is not already present.
apply_rule() {
  local tool="$1"
  local destination="$2"
  local -a rule=(
    OUTPUT
    -d "$destination"
    -m owner
    ! --uid-owner "$ROOT_UID"
    ! --uid-owner "$SIGNER_UID"
    -j REJECT
  )

  if "$tool" -C "${rule[@]}"; then
    log "$tool rule already present for $destination"
    return 0
  fi

  "$tool" -A "${rule[@]}"
  log "$tool rule added for $destination"
}

main() {
  require iptables
  apply_rule iptables "$METADATA_IPV4"

  if [[ -e "$IF_INET6_PATH" ]]; then
    require ip6tables
    apply_rule ip6tables "$METADATA_IPV6"
  else
    log "IPv6 is off on this host; no ip6tables rule needed"
  fi
}

main "$@"
