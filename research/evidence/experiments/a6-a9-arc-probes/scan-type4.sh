#!/usr/bin/env bash
# Scan the most recent N blocks for EIP-7702 (type 0x4) transactions on Arc mainnet and testnet.
set -euo pipefail
N=${N:-600}
OUT=$(cd "$(dirname "$0")" && pwd)
one() {
  cast block "$1" --full --json --rpc-url "$2" | jq -r '(.data // .).transactions[]
    | select(.type=="0x4")
    | "\(.blockNumber) \(.hash) from=\(.from) to=\(.to) auths=\(.authorizationList|length) delegate0=\(.authorizationList[0].address)"'
}
export -f one
for net in mainnet=https://rpc.mainnet.arc.io testnet=https://rpc.testnet.arc.io; do
  n=${net%%=*}; r=${net#*=}
  B=$(cast block-number --rpc-url "$r")
  echo "### $n scanning blocks $((B - N + 1))..$B date=$(date -u +%FT%TZ)"
  seq -f %.0f $((B - N + 1)) "$B" | xargs -P 12 -I{} bash -c "one {} $r" | sort > "$OUT/type4-$n.txt"
  head -10 "$OUT/type4-$n.txt"
  echo "type-4 tx count in window: $(wc -l < "$OUT/type4-$n.txt")"
done
