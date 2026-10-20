#!/usr/bin/env bash
# EIP-7702 RPC acceptance test on live Arc with an UNFUNDED throwaway key.
# No funds exist on this key, so nothing can be mined. The point is which error the node returns:
# "insufficient funds" means the type-4 tx was decoded and accepted for validation;
# "transaction type not supported" would mean 7702 is off.
# The key is read from throwaway.key.json (gitignored, mode 600) and never printed.
set -euo pipefail
cd "$(dirname "$0")"
PK=$(jq -r '.. | .private_key? // empty' throwaway.key.json | head -1)
ADDR=$(cat address.txt)
DELEGATE=0xcA11bde05977b3631167028862bE2a173976CA11   # Multicall3, present on both Arc networks
for net in testnet=https://rpc.testnet.arc.io mainnet=https://rpc.mainnet.arc.io; do
  n=${net%%=*}; r=${net#*=}
  CID=$(cast chain-id --rpc-url "$r"); B=$(cast block-number --rpc-url "$r")
  echo "### $n chainid=$CID block=$B date=$(date -u +%FT%TZ) sender=$ADDR balance=$(cast balance "$ADDR" --rpc-url "$r")"
  AUTH=$(cast wallet sign-auth "$DELEGATE" --private-key "$PK" --nonce 1 --chain "$CID" --rpc-url "$r")
  RAW=$(cast mktx "$ADDR" --auth "$AUTH" --private-key "$PK" --rpc-url "$r" --chain "$CID" --nonce 0 \
        --gas-limit 100000 --gas-price 40gwei --priority-gas-price 1gwei)
  echo "raw tx first byte: ${RAW:0:4} (0x04 = EIP-7702 set-code tx), length ${#RAW}"
  echo "publish: $(cast publish "$RAW" --rpc-url "$r" 2>&1 | tr '\n' ' ')"
  echo "control (type-2 tx, same unfunded key): $(cast publish "$(cast mktx "$ADDR" --private-key "$PK" --rpc-url "$r" --chain "$CID" --nonce 0 --gas-limit 21000 --gas-price 40gwei --priority-gas-price 1gwei)" --rpc-url "$r" 2>&1 | tr '\n' ' ')"
done
