#!/usr/bin/env bash
set -euo pipefail
R=${RPC:-https://rpc.testnet.arc.io}
G=${GW:-0x0077777d7EBA4688BDeF3E311b846F25870A19B9}
USDC=0x3600000000000000000000000000000000000000
B=$(cast block-number -r "$R")
echo "rpc=$R chainId=$(cast chain-id -r "$R") block=$B date=$(date -u +%FT%TZ)"
echo "impl(EIP-1967)=$(cast implementation "$G" -r "$R" -B "$B")"
echo "admin(EIP-1967)=$(cast admin "$G" -r "$R" -B "$B")"
for f in "withdrawalDelay()(uint256)" "owner()(address)" "contractSignersAllowlister()(address)" \
  "contractSignersDisallowlister()(address)" "feeRecipient()(address)" "paused()(bool)" "pauser()(address)" \
  "domain()(uint32)"; do
  echo "$f = $(cast call "$G" "$f" -r "$R" -b "$B" 2>&1 | head -1)"
done
echo "isTokenSupported(USDC) = $(cast call "$G" 'isTokenSupported(address)(bool)' $USDC -r "$R" -b "$B" 2>&1 | head -1)"
echo "isAuthorizedForBalance(USDC,0x..01,0x..01) = $(cast call "$G" 'isAuthorizedForBalance(address,address,address)(bool)' $USDC 0x0000000000000000000000000000000000000001 0x0000000000000000000000000000000000000001 -r "$R" -b "$B" 2>&1 | head -1)"
echo "isContractSignatureSigner(0x..01) = $(cast call "$G" 'isContractSignatureSigner(address)(bool)' 0x0000000000000000000000000000000000000001 -r "$R" -b "$B" 2>&1 | head -1)"
echo "isAllowlistedContractSigner(0x..01) = $(cast call "$G" 'isAllowlistedContractSigner(address)(bool)' 0x0000000000000000000000000000000000000001 -r "$R" -b "$B" 2>&1 | head -1)"
echo "isBatchSigner(0x..01) = $(cast call "$G" 'isBatchSigner(address)(bool)' 0x0000000000000000000000000000000000000001 -r "$R" -b "$B" 2>&1 | head -1)"
IMPL=$(cast implementation "$G" -r "$R" -B "$B")
echo "impl codesize=$(cast codesize "$IMPL" -r "$R" -B "$B")"
cast code "$IMPL" -r "$R" -B "$B" | cast keccak | sed 's/^/impl code keccak=/'
