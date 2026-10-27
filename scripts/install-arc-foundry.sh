#!/usr/bin/env bash
# Installs Arc Foundry (arc-forge, arc-cast, arc-anvil) from the checksummed GitHub release (T-003).
# Never uses foundryup or foundry-toolchain: they install upstream Foundry without Arc rules (A9-12, A9-13).
# The same script runs locally and in CI. Running it again with the binaries in place changes nothing.
#
# Usage: scripts/install-arc-foundry.sh [install-dir]   (default: $HOME/.local/bin)
set -euo pipefail

readonly VERSION="v0.8.0-2"                                     # A9-12
readonly EXPECTED_COMMIT="d497beea7096ff2a8e583c8b307941f24a61b06b" # A9-13
readonly RELEASE_URL="https://github.com/circlefin/arc-foundry/releases/download/${VERSION}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# Pinned archive digests, one "<sha256>  <archive>" line per target. A digest here must match;
# the release's own .sha256 file must match too.
readonly PINNED_SHA256_FILE="${SCRIPT_DIR}/arc-foundry.sha256"

install_dir="${1:-${HOME}/.local/bin}"
work=""

log() { printf 'install-arc-foundry: %s\n' "$*" >&2; }
fail() { log "error: $*"; exit 1; }

detect_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "${os}/${arch}" in
    Linux/x86_64) echo "x86_64-unknown-linux-gnu" ;;
    Linux/aarch64 | Linux/arm64) echo "aarch64-unknown-linux-gnu" ;;
    Darwin/arm64) echo "aarch64-apple-darwin" ;;
    *) fail "no prebuilt Arc Foundry for ${os}/${arch}; build from source (A9-12)" ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

installed_commit() {
  "${install_dir}/arc-anvil" --version 2>/dev/null | awk -F': *' '/Commit SHA/ {print $2}'
}

main() {
  if [[ -x "${install_dir}/arc-forge" && -x "${install_dir}/arc-cast" && -x "${install_dir}/arc-anvil" ]] \
    && [[ "$(installed_commit)" == "${EXPECTED_COMMIT}" ]]; then
    log "Arc Foundry ${VERSION} already installed in ${install_dir}"
    return 0
  fi

  local target archive expected_release actual pinned
  target="$(detect_target)"
  archive="arc-foundry-${VERSION}-${target}.tar.gz"
  work="$(mktemp -d)"
  trap 'if [[ -n "${work}" ]]; then rm -rf "${work}"; fi' EXIT

  log "downloading ${archive}"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --output "${work}/${archive}" "${RELEASE_URL}/${archive}"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --output "${work}/${archive}.sha256" "${RELEASE_URL}/${archive}.sha256"

  actual="$(sha256_of "${work}/${archive}")"
  expected_release="$(awk '{print $1}' "${work}/${archive}.sha256")"
  log "sha256 ${actual}"
  [[ "${actual}" == "${expected_release}" ]] || fail "sha256 does not match the release .sha256 file"

  pinned="$(awk -v a="${archive}" '$2 == a {print $1}' "${PINNED_SHA256_FILE}")"
  if [[ -n "${pinned}" ]]; then
    [[ "${actual}" == "${pinned}" ]] || fail "sha256 does not match the pinned digest in ${PINNED_SHA256_FILE}"
  elif [[ "${ARC_FOUNDRY_ALLOW_UNPINNED:-0}" != "1" ]]; then
    fail "no pinned digest for ${archive} in ${PINNED_SHA256_FILE}"
  else
    log "warning: no pinned digest for ${archive}; verified against the release .sha256 only"
  fi

  tar -xzf "${work}/${archive}" -C "${work}" forge cast anvil
  mkdir -p "${install_dir}"
  install -m 0755 "${work}/forge" "${install_dir}/arc-forge"
  install -m 0755 "${work}/cast" "${install_dir}/arc-cast"
  install -m 0755 "${work}/anvil" "${install_dir}/arc-anvil"

  [[ "$(installed_commit)" == "${EXPECTED_COMMIT}" ]] \
    || fail "arc-anvil reports commit '$(installed_commit)', expected ${EXPECTED_COMMIT}"
  log "installed Arc Foundry ${VERSION} (${EXPECTED_COMMIT}) in ${install_dir}"
}

main "$@"
