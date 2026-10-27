#!/usr/bin/env bash
# Experiment A1 (simulation): ERC-1271 payer for USDC transferWithAuthorization on Arc.
# Read-only: eth_call with state overrides against the live Arc RPC. No transactions are sent.
# Usage: ./sim.sh [rpc_url] [chain_id]
set -euo pipefail

RPC="${1:-https://rpc.testnet.arc.io}"
CHAIN_ID="${2:-5042002}"
DIR="$(cd "$(dirname "$0")" && pwd)"
USDC=0x3600000000000000000000000000000000000000
WALLET=0x00000000000000000000000000000000000A1A11 # simulated ERC-1271 payer
PROBE=0x00000000000000000000000000000000000A1A12  # simulated settle probe
PAYEE=0x00000000000000000000000000000000000A1A13
OWNER_KEY="$(cat "$DIR/owner.key")"
OWNER="$(cat "$DIR/owner.addr")"
VALUE=1000000 # 1 USDC (6 decimals)

code_of() {
  python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['deployedBytecode']['object'])" \
    "$DIR/out/$1.sol/$1.json"
}
WALLET_CODE="$(code_of OwnerSig1271)"
PROBE_CODE="$(code_of SettleProbe)"
OWNER_SLOT_VALUE="0x$(printf '%064s' "${OWNER#0x}" | tr ' ' 0)"

typed_data() { # from to value validBefore nonce
  cat <<JSON
{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},
{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
"TransferWithAuthorization":[{"name":"from","type":"address"},{"name":"to","type":"address"},
{"name":"value","type":"uint256"},{"name":"validAfter","type":"uint256"},
{"name":"validBefore","type":"uint256"},{"name":"nonce","type":"bytes32"}]},
"primaryType":"TransferWithAuthorization",
"domain":{"name":"USDC","version":"2","chainId":$CHAIN_ID,"verifyingContract":"$USDC"},
"message":{"from":"$1","to":"$2","value":"$3","validAfter":"0","validBefore":"$4","nonce":"$5"}}
JSON
}

sign() { # key from to value validBefore nonce
  local f
  f="$(mktemp)"
  typed_data "$2" "$3" "$4" "$5" "$6" >"$f"
  cast wallet sign --data --from-file "$f" --private-key "$1"
  rm -f "$f"
}

run() { # label cmd...
  echo "### $1"
  shift
  "$@" 2>&1 | sed 's/^/    /' || true
}

BLOCK="$(cast block-number --rpc-url "$RPC")"
VALID_BEFORE=$(($(date +%s) + 3600))
NONCE="$(cast keccak "a1-sim-$(date +%s%N)")"
echo "rpc=$RPC chain=$CHAIN_ID block=$BLOCK date=$(date -u +%FT%TZ)"
echo "wallet=$WALLET owner=$OWNER payee=$PAYEE value=$VALUE nonce=$NONCE"

GOOD_SIG="$(sign "$OWNER_KEY" "$WALLET" "$PAYEE" "$VALUE" "$VALID_BEFORE" "$NONCE")"
OTHER_KEY="$(cast keccak a1-not-the-owner)"
BAD_SIG="$(sign "$OTHER_KEY" "$WALLET" "$PAYEE" "$VALUE" "$VALID_BEFORE" "$NONCE")"
echo "good_sig_len_bytes=$(((${#GOOD_SIG} - 2) / 2))"

OVERRIDES=(
  --override-code "$WALLET:$WALLET_CODE,$PROBE:$PROBE_CODE"
  --override-state-diff "$WALLET:0x0:$OWNER_SLOT_VALUE"
  --override-balance "$WALLET:10000000000000000000"
)
SETTLE_SIG="settle(address,address,uint256,uint256,bytes32,bytes)(uint256,uint256,uint256,uint256,bool)"

run "T0 isValidSignature on simulated wallet (expect 0x1626ba7e)" \
  cast call "$WALLET" "isValidSignature(bytes32,bytes)(bytes4)" \
  "$(cast keccak x)" "$(cast wallet sign --no-hash "$(cast keccak x)" --private-key "$OWNER_KEY")" \
  "${OVERRIDES[@]}" --rpc-url "$RPC" --block "$BLOCK"

run "T1 bytes overload, contract payer, owner signature (expect success, balances move)" \
  cast call "$PROBE" "$SETTLE_SIG" "$WALLET" "$PAYEE" "$VALUE" "$VALID_BEFORE" "$NONCE" "$GOOD_SIG" \
  "${OVERRIDES[@]}" --rpc-url "$RPC" --block "$BLOCK"

run "T2 bytes overload, contract payer, wrong key (expect revert invalid signature)" \
  cast call "$PROBE" "$SETTLE_SIG" "$WALLET" "$PAYEE" "$VALUE" "$VALID_BEFORE" "$NONCE" "$BAD_SIG" \
  "${OVERRIDES[@]}" --rpc-url "$RPC" --block "$BLOCK"

read -r -a VRS <<<"$(python3 -I -c "import sys;s=sys.argv[1][2:];print(int(s[128:130],16),'0x'+s[:64],'0x'+s[64:128])" "$GOOD_SIG")"
run "T3 v,r,s overload, contract payer, owner signature (expect success, empty return)" \
  cast call "$USDC" \
  "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" \
  "$WALLET" "$PAYEE" "$VALUE" 0 "$VALID_BEFORE" "$NONCE" "${VRS[0]}" "${VRS[1]}" "${VRS[2]}" \
  "${OVERRIDES[@]}" --rpc-url "$RPC" --block "$BLOCK"

run "T4 same owner signature but payer has no code (EOA path; expect revert invalid signature)" \
  cast call "$PROBE" "$SETTLE_SIG" "$WALLET" "$PAYEE" "$VALUE" "$VALID_BEFORE" "$NONCE" "$GOOD_SIG" \
  --override-code "$PROBE:$PROBE_CODE" --override-balance "$WALLET:10000000000000000000" \
  --rpc-url "$RPC" --block "$BLOCK"

run "T5 contract payer with zero balance (expect revert on balance)" \
  cast call "$PROBE" "$SETTLE_SIG" "$WALLET" "$PAYEE" "$VALUE" "$VALID_BEFORE" "$NONCE" "$GOOD_SIG" \
  --override-code "$WALLET:$WALLET_CODE,$PROBE:$PROBE_CODE" \
  --override-state-diff "$WALLET:0x0:$OWNER_SLOT_VALUE" --rpc-url "$RPC" --block "$BLOCK"
