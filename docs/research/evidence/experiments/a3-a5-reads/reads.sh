#!/usr/bin/env bash
# Read-only RPC/API calls behind ground-truth items A3-A5. No keys, no transactions.
set -euo pipefail
M=https://rpc.mainnet.arc.io
T=https://rpc.testnet.arc.io
SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc

echo "mainnet block $(cast block-number --rpc-url "$M")  testnet block $(cast block-number --rpc-url "$T")"

# A3: Permit2, x402 proxies and batch-settlement contracts on Arc
for a in 0x000000000022D473030F116dDEE9F6B43aC78BA3 0x402085c248EeA27D92E8b30b2C58ed07f9E20001 \
  0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002 0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003 \
  0x4020806089470a89826cB9fB1f4059150b550004 0x4020425FAf3B746C082C2f942b4E5159887B0005; do
  echo "$a mainnet=$(cast codesize "$a" --rpc-url "$M") testnet=$(cast codesize "$a" --rpc-url "$T")"
done
curl -s https://api.circle.com/v1/facilitator/x402/supported
echo

# A4: ERC-8183 AgenticCommerce on Arc testnet
P=0x0747EEf0706327138c69792bF28Cd525089e4583
for f in "platformFeeBP()(uint256)" "evaluatorFeeBP()(uint256)" "platformTreasury()(address)" \
  "paymentToken()(address)" "jobCounter()(uint256)"; do
  echo "$f = $(cast call "$P" "$f" --rpc-url "$T")"
done
echo "impl $(cast storage "$P" "$SLOT" --rpc-url "$T")"
echo "mainnet code at proxy address: $(cast codesize "$P" --rpc-url "$M")"
for t in "RoleGranted(bytes32,address,address)" "RoleRevoked(bytes32,address,address)" \
  "HookWhitelistUpdated(address,bool)" "Upgraded(address)"; do
  echo "== $t"
  curl -s "https://explorer.testnet.arc.io/api?module=logs&action=getLogs&address=$P&fromBlock=0&toBlock=latest&topic0=$(cast keccak "$t")"
  echo
done

# A5: ERC-8004 registries, before/after the 2026-09-14 upgrade (block 20817518)
for a in 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63 \
  0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58; do
  for b in 20817517 20817518 latest; do
    echo "$a block=$b impl=$(cast storage "$a" "$SLOT" --rpc-url "$M" -b "$b") ver=$(cast call "$a" 'getVersion()(string)' --rpc-url "$M" -b "$b")"
  done
done
echo "owner nonce $(cast nonce 0x547289319C3e6aedB179C0b8e8aF0B5ACd062603 --rpc-url "$M")"
