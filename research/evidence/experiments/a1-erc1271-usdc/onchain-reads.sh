#!/usr/bin/env bash
# Experiment A1: read-only facts about USDC at 0x3600…0000 on Arc mainnet and testnet.
set -euo pipefail
U=0x3600000000000000000000000000000000000000
LIB=0xfcFf98B65F9ea559EC0df36F4072C7E3BE0520Df
ZOS_IMPL_SLOT=0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3
ZOS_ADMIN_SLOT=0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b
for R in https://rpc.mainnet.arc.io https://rpc.testnet.arc.io; do
  B="$(cast block-number --rpc-url "$R")"
  echo "== $R chain $(cast chain-id --rpc-url "$R") block $B $(date -u +%FT%TZ)"
  for f in "name()(string)" "symbol()(string)" "version()(string)" "decimals()(uint8)" \
    "DOMAIN_SEPARATOR()(bytes32)" "TRANSFER_WITH_AUTHORIZATION_TYPEHASH()(bytes32)" \
    "implementation()(address)" "paused()(bool)" "owner()(address)"; do
    echo "$f = $(cast call "$U" "$f" --rpc-url "$R" --block "$B" 2>&1 | tr '\n' ' ')"
  done
  echo "eip712Domain() = $(cast call "$U" 'eip712Domain()' --rpc-url "$R" --block "$B" 2>&1 | head -1)"
  echo "impl slot = $(cast storage "$U" "$ZOS_IMPL_SLOT" --rpc-url "$R" --block "$B")"
  echo "admin slot = $(cast storage "$U" "$ZOS_ADMIN_SLOT" --rpc-url "$R" --block "$B")"
  IMPL="$(cast call "$U" 'implementation()(address)' --rpc-url "$R" --block "$B")"
  CODE="$(cast code "$IMPL" --rpc-url "$R" --block "$B")"
  echo "impl codesize = $(cast codesize "$IMPL" --rpc-url "$R" --block "$B") sha1 = $(printf '%s' "$CODE" | shasum | cut -c1-40)"
  for s in "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)" \
    "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" \
    "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)" \
    "cancelAuthorization(address,bytes32,bytes)" "permit(address,address,uint256,uint256,bytes)"; do
    SEL="$(cast sig "$s")"
    echo "selector $SEL in impl dispatcher: $(grep -c "63${SEL#0x}" <<<"$CODE" || true) ($s)"
  done
  echo "linked SignatureChecker $LIB in impl code: $(grep -ci "${LIB#0x}" <<<"$CODE" || true); lib codesize $(cast codesize "$LIB" --rpc-url "$R" --block "$B"); lib contains 1626ba7e: $(cast code "$LIB" --rpc-url "$R" --block "$B" | grep -c 1626ba7e || true)"
  echo "precompile 0x1800..00 code = $(cast code 0x1800000000000000000000000000000000000000 --rpc-url "$R" --block "$B")"
done
