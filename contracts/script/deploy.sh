#!/usr/bin/env bash
# T-027 (07 PRD 13): three-pass CREATE2 deployment of the vault logic libraries, OpenEvidenceLog and CzarVaultFactory.
# Usage (from contracts/):
#   script/deploy.sh <rpc-url> <keys-file> <out-file> [extra forge args: sender and, for a dry run, nothing else]
# Local:   script/deploy.sh http://127.0.0.1:8545 ../deployments/local-keys.json ../deployments/local.json \
#            --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
# Testnet: only after T-105 and Zaryab's written funds approval:
#          script/deploy.sh https://rpc.testnet.arc.io ../deployments/arc-testnet-keys.json \
#            ../deployments/arc-testnet.json --broadcast --account czar-deployer
# Never put a private key, passphrase or mnemonic on this command line or in the environment (D70, D78).
set -euo pipefail
FORGE="${ARC_FORGE:-arc-forge}"
RPC="$1"
KEYS="$2"
OUT="$3"
shift 3
export FOUNDRY_PROFILE=deploy

# Every library entry printed by Deploy.predictLibraries becomes a --libraries flag.
link_flags() { "$FORGE" script script/Deploy.s.sol --sig "predictLibraries(uint256,uint256)" "$1" "$2" "${LINK[@]+"${LINK[@]}"}" "${COMPILE[@]+"${COMPILE[@]}"}" |
	sed -n 's/^ *\(src\/vault\/logic\/[A-Za-z]*\.sol:[A-Za-z]*:0x[0-9a-fA-F]\{40\}\)$/--libraries \1/p'; }

COMPILE=()
# Compiler flags (for example --use <solc> --offline) are passed through to every pass; broadcast flags only to pass 3.
while [ $# -gt 0 ]; do
	case "$1" in
	--use)
		COMPILE+=("$1" "$2")
		shift 2
		;;
	--offline)
		COMPILE+=("$1")
		shift
		;;
	*) break ;;
	esac
done

LINK=()
read -r -a LINK <<<"$(link_flags 0 7 | tr '\n' ' ')" # pass 1: the seven libraries that link nothing
[ "${#LINK[@]}" -eq 14 ] || {
	echo "deploy.sh: expected 7 library addresses" >&2
	exit 1
}
read -r -a EXTRA <<<"$(link_flags 7 8 | tr '\n' ' ')" # pass 2: OwnerActionLogic, linked to the five it calls
[ "${#EXTRA[@]}" -eq 2 ] || {
	echo "deploy.sh: expected the OwnerActionLogic address" >&2
	exit 1
}
LINK+=("${EXTRA[@]}")

# Pass 3: everything linked; deploy (or simulate when no --broadcast is given).
"$FORGE" script script/Deploy.s.sol --sig "run(string,string)" "$KEYS" "$OUT" --rpc-url "$RPC" \
	"${LINK[@]+"${LINK[@]}"}" "${COMPILE[@]+"${COMPILE[@]}"}" "$@"
