#!/usr/bin/env bash
# Count ERC-4337 UserOperationEvent logs per EntryPoint over a recent window on Arc mainnet and testnet,
# and list the distinct bundler EOAs (tx.from) that submitted handleOps.
set -euo pipefail
TOPIC=$(cast keccak "UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")
WINDOW=${WINDOW:-9000}
for net in mainnet=https://rpc.mainnet.arc.io testnet=https://rpc.testnet.arc.io; do
  n=${net%%=*}; r=${net#*=}
  B=$(cast block-number --rpc-url "$r"); F=$((B - WINDOW))
  echo "### $n blocks $F..$B (~$((WINDOW / 2 / 60)) min) date=$(date -u +%FT%TZ)"
  for ep in v0.6=0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789 v0.7=0x0000000071727De22E5E9d8BAf0edAc6f37da032 \
            v0.8=0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108 v0.9=0x433709009B8330FDa32311DF1C2AFA402eD8D009; do
    v=${ep%%=*}; a=${ep#*=}
    logs=$(cast logs --from-block "$F" --to-block "$B" --address "$a" "$TOPIC" --rpc-url "$r" --json 2>&1 || true)
    cnt=$(echo "$logs" | jq 'length' 2>/dev/null || echo "ERR: $logs")
    echo "EntryPoint $v $a UserOperationEvent count=$cnt"
    if [ "$cnt" != "0" ] && [[ "$cnt" =~ ^[0-9]+$ ]]; then
      for tx in $(echo "$logs" | jq -r '.[].transactionHash' | sort -u | head -15); do
        cast tx "$tx" from --rpc-url "$r"
      done | sort | uniq -c | sed 's/^/   bundler(tx.from, sample of up to 15 txs): /'
    fi
  done
done
