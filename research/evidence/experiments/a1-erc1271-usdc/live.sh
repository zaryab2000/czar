#!/usr/bin/env bash
# Experiment A1 (live, Arc testnet only): deploy OwnerSig1271, fund it with USDC, settle one
# EIP-3009 authorization on-chain via the bytes overload, then pay a local x402 seller through
# Circle's Facilitator Service (keyless trial). Needs owner.addr funded with >= 1.5 testnet USDC.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
RPC=https://rpc.testnet.arc.io
CHAIN_ID=5042002
USDC=0x3600000000000000000000000000000000000000
OWNER="$(cat "$DIR/owner.addr")"
SELLER="$(cat "$DIR/seller.addr")"
GAS=(--gas-price 40gwei --priority-gas-price 2gwei)
RAW="$DIR/raw"
ts() { date -u +%FT%TZ; }
bal() { cast call "$USDC" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC" | awk '{print $1}'; }

echo "start $(ts) block $(cast block-number --rpc-url "$RPC")"
OWNER_BAL="$(bal "$OWNER")"
echo "owner $OWNER usdc=$OWNER_BAL"
if [ "$OWNER_BAL" -lt 1500000 ]; then
  echo "owner needs >= 1.5 testnet USDC (faucet.circle.com, Arc Testnet) to $OWNER" >&2
  exit 1
fi

cd "$DIR"
forge build >/dev/null
echo "== deploy $(ts)"
forge create src/OwnerSig1271.sol:OwnerSig1271 \
  --private-key "$(cat owner.key)" --rpc-url "$RPC" --broadcast "${GAS[@]}" --json \
  --constructor-args "$OWNER" \
  | tee "$RAW/live-deploy.json"
WALLET="$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['deployedTo'])" "$RAW/live-deploy.json")"
echo "$WALLET" >"$DIR/wallet.addr"
echo "wallet $WALLET codesize $(cast codesize "$WALLET" --rpc-url "$RPC") owner() $(cast call "$WALLET" 'owner()(address)' --rpc-url "$RPC")"

echo "== fund wallet with 1 USDC $(ts)"
cast send "$USDC" "transfer(address,uint256)" "$WALLET" 1000000 \
  --private-key "$(cat owner.key)" --rpc-url "$RPC" "${GAS[@]}" --json | tee "$RAW/live-fund.json" \
  | python3 -I -c "import json,sys;r=json.load(sys.stdin);print('tx',r['transactionHash'],'block',int(r['blockNumber'],16),'status',r['status'])"
echo "wallet usdc=$(bal "$WALLET")"

echo "== direct on-chain: bytes overload, from=wallet, relayer=owner, 0.1 USDC to seller $(ts)"
NONCE="$(cast keccak "a1-live-$(date +%s%N)")"
VALID_BEFORE=$(($(date +%s) + 3600))
TD="$(mktemp)"
cat >"$TD" <<JSON
{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},
{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
"TransferWithAuthorization":[{"name":"from","type":"address"},{"name":"to","type":"address"},
{"name":"value","type":"uint256"},{"name":"validAfter","type":"uint256"},
{"name":"validBefore","type":"uint256"},{"name":"nonce","type":"bytes32"}]},
"primaryType":"TransferWithAuthorization",
"domain":{"name":"USDC","version":"2","chainId":$CHAIN_ID,"verifyingContract":"$USDC"},
"message":{"from":"$WALLET","to":"$SELLER","value":"100000","validAfter":"0","validBefore":"$VALID_BEFORE","nonce":"$NONCE"}}
JSON
SIG="$(cast wallet sign --data --from-file "$TD" --private-key "$(cat owner.key)")"
rm -f "$TD"
BEFORE_W="$(bal "$WALLET")"
BEFORE_S="$(bal "$SELLER")"
T0=$(date +%s%N)
cast send "$USDC" "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)" \
  "$WALLET" "$SELLER" 100000 0 "$VALID_BEFORE" "$NONCE" "$SIG" \
  --private-key "$(cat owner.key)" --rpc-url "$RPC" "${GAS[@]}" --json | tee "$RAW/live-direct-3009.json" \
  | python3 -I -c "import json,sys;r=json.load(sys.stdin);print('tx',r['transactionHash'],'block',int(r['blockNumber'],16),'status',r['status'],'gasUsed',int(r['gasUsed'],16))"
echo "send->receipt ms $((($(date +%s%N) - T0) / 1000000))"
echo "wallet usdc $BEFORE_W -> $(bal "$WALLET"); seller usdc $BEFORE_S -> $(bal "$SELLER")"
echo "authorizationState $(cast call "$USDC" 'authorizationState(address,bytes32)(bool)' "$WALLET" "$NONCE" --rpc-url "$RPC")"

echo "== facilitator /verify with contract payer $(ts)"
PAYER="$WALLET" MODE=verify node x402-flow.mjs | tee "$RAW/live-x402-verify.txt"
echo "== facilitator /verify + /settle with contract payer $(ts)"
PAYER="$WALLET" MODE=settle node x402-flow.mjs | tee "$RAW/live-x402-settle.txt"
echo "wallet usdc=$(bal "$WALLET") seller usdc=$(bal "$SELLER")"
echo "end $(ts) block $(cast block-number --rpc-url "$RPC")"
