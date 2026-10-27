#!/usr/bin/env bash
# Builds the self-contained czar-redact bundle that ships inside the daemon installer (T-064, D45).
# The bundle holds its own CPython (uv-managed, python-build-standalone), the hash-pinned packages from
# apps/redact-sidecar/uv.lock and a launcher; users never install Python.
#
# Usage: scripts/bundle-redact-sidecar.sh <output-dir>
#   <output-dir>/python/          the interpreter
#   <output-dir>/site-packages/   czar_redact, Presidio 2.2.364, spaCy and the English model
#   <output-dir>/bin/czar-redact  launcher: runs the bundled interpreter in isolated mode (-I)
set -euo pipefail

readonly PYTHON_VERSION="3.13.14" # newest uv-managed CPython 3.13 build on 2026-10-19
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly PROJECT="${SCRIPT_DIR}/../apps/redact-sidecar"

out="${1:?usage: bundle-redact-sidecar.sh <output-dir>}"
mkdir -p "${out}"
out="$(cd "${out}" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

uv python install "${PYTHON_VERSION}" --install-dir "${work}/uv-python" --no-bin
src_root="$(dirname "$(dirname "$(find "${work}/uv-python" -path '*/bin/python3.13' | head -1)")")"
[[ -d "${src_root}" ]] || { echo "bundle: uv did not install CPython ${PYTHON_VERSION}" >&2; exit 1; }
rm -rf "${out:?}/python" "${out:?}/site-packages" "${out:?}/bin"
cp -R "${src_root}" "${out}/python"
python="${out}/python/bin/python3.13"
"${python}" -c 'import sys; assert sys.version_info[:2] == (3, 13)'

# Exact versions with hashes from uv.lock (cross-cutting §7: Python with uv and hashes).
(cd "${PROJECT}" && uv export --frozen --no-dev --no-emit-project --format requirements-txt) > "${work}/requirements.txt"
uv pip install --python "${python}" --target "${out}/site-packages" --require-hashes --no-deps \
  -r "${work}/requirements.txt"
uv pip install --python "${python}" --target "${out}/site-packages" --no-deps "${PROJECT}"

mkdir -p "${out}/bin"
cat > "${out}/bin/czar-redact" <<'LAUNCHER'
#!/bin/sh
# czar-redact launcher: bundled interpreter, isolated mode (no PYTHON* variables, no user site).
here="${0%/*}/.."
exec "$here/python/bin/python3.13" -I -c 'import sys; sys.path.insert(0, sys.argv.pop(1)); from czar_redact.server import main; raise SystemExit(main(sys.argv[1:]))' "$here/site-packages" "$@"
LAUNCHER
chmod 0755 "${out}/bin/czar-redact"
echo "bundle: ${out}"
