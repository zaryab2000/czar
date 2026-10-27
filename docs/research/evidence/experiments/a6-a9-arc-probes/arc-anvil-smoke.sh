#!/usr/bin/env bash
# Smoke-test arc-anvil (Arc Foundry v0.8.0-2) locally: version, chain id, P256 precompile,
# zero-address value transfer rule, and an EIP-7702 type-4 tx under Arc rules.
# ARC_BIN = directory holding the extracted arc-foundry binaries (forge, cast, anvil).
set -euo pipefail
ARC_BIN=${ARC_BIN:?set ARC_BIN to the extracted arc-foundry directory}
A="$ARC_BIN/anvil"; C="$ARC_BIN/cast"
PORT=8597; R=http://127.0.0.1:$PORT; LOG=$(mktemp)
"$A" --version | head -2
"$A" --network arc --port $PORT > "$LOG" 2>&1 &
PID=$!; trap 'kill $PID' EXIT
for _ in $(seq 1 50); do "$C" chain-id --rpc-url "$R" >/dev/null 2>&1 && break; sleep 0.2; done
echo "chain-id: $("$C" chain-id --rpc-url "$R")"
grep -m3 -i -E "chain|hardfork|arc" "$LOG" || true
VALID=bb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca6050232ba3a8be6b94d5ec80a6d9d1190a436effe50d85a1eee859b8cc6af9bd5c2e184cd60b855d442f5b3c7b11eb6c4e0ae7525fe710fab9aa7c77a67f79e6fadd762927b10512bae3eddcfe467828128bad2903269919f7086069c8c4df6c732838c7787964eaac00e5921fb1498a60f4606766b3d9685001558d1a974e7341513e
echo "P256VERIFY valid vector -> $("$C" call 0x0000000000000000000000000000000000000100 0x$VALID --rpc-url "$R" 2>&1)"
# anvil dev account 0 (well-known public test mnemonic keys)
PK0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ADDR0=$("$C" wallet address $PK0)
echo "dev0=$ADDR0 native balance=$("$C" balance "$ADDR0" --rpc-url "$R")"
echo "USDC ERC-20 balanceOf(dev0) at 0x3600..: $("$C" call 0x3600000000000000000000000000000000000000 'balanceOf(address)(uint256)' "$ADDR0" --rpc-url "$R" 2>&1)"
echo "-- value transfer to 0x0 (Arc docs: should revert):"
"$C" send 0x0000000000000000000000000000000000000000 --value 1 --private-key "$PK0" --rpc-url "$R" 2>&1 | grep -E -i "status|revert|error|Zero" | head -3 || true
echo "-- EIP-7702: dev0 sends a self-sponsored type-4 tx delegating to 0x3600... (explicit gas;"
echo "   gas estimation for this self-call reverted with empty data in an earlier run):"
"$C" send "$ADDR0" --auth 0x3600000000000000000000000000000000000000 --private-key "$PK0" \
  --rpc-url "$R" --gas-limit 200000 2>&1 | grep -E "^(status|type|transactionHash)" || true
echo "code at dev0 after (expect 0xef0100 || delegate): $("$C" code "$ADDR0" --rpc-url "$R")"
