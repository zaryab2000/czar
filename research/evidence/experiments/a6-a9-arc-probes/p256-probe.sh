#!/usr/bin/env bash
# Probe the P256VERIFY precompile (0x100, EIP-7951 / RIP-7212) on Arc mainnet and testnet.
# Vectors: EIP-7951 assets/eip-7951/test-vectors.json (ethereum/EIPs @ 69ce35b4), entries
# "SHA-256 #1: signature malleability" (valid) and "SHA-256 #3: Modified r or s" (invalid).
set -euo pipefail
P=0x0000000000000000000000000000000000000100
VALID=bb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca6050232ba3a8be6b94d5ec80a6d9d1190a436effe50d85a1eee859b8cc6af9bd5c2e184cd60b855d442f5b3c7b11eb6c4e0ae7525fe710fab9aa7c77a67f79e6fadd762927b10512bae3eddcfe467828128bad2903269919f7086069c8c4df6c732838c7787964eaac00e5921fb1498a60f4606766b3d9685001558d1a974e7341513e
# shellcheck disable=SC2034  # read indirectly via ${!v}
INV3=bb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023d45c5740946b2a147f59262ee6f5bc90bd01ed280528b62b3aed5fc93f06f739b329f479a2bbd0a5c384ee1493b1f5186a87139cac5df4087c134b49156847db2927b10512bae3eddcfe467828128bad2903269919f7086069c8c4df6c732838c7787964eaac00e5921fb1498a60f4606766b3d9685001558d1a974e7341513e
# Tampered: valid vector with the last byte of the message hash changed 0x23 -> 0x24.
# shellcheck disable=SC2034  # read indirectly via ${!v}
TAMP=bb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605024${VALID:64}
for net in mainnet=https://rpc.mainnet.arc.io testnet=https://rpc.testnet.arc.io; do
  n=${net%%=*}; r=${net#*=}
  B=$(cast block-number --rpc-url "$r")
  echo "### $n rpc=$r chainid=$(cast chain-id --rpc-url "$r") block=$B date=$(date -u +%FT%TZ)"
  echo "code at 0x100: $(cast code $P --rpc-url "$r" --block "$B")"
  for v in VALID INV3 TAMP; do
    echo "$v -> [$(cast call $P "0x${!v}" --rpc-url "$r" --block "$B" 2>&1)]"
  done
  for v in VALID INV3; do
    echo "estimateGas $v: $(cast estimate $P "0x${!v}" --rpc-url "$r" 2>&1)"
  done
  # Gas-cap test: total gas = intrinsic + calldata + precompile. Find whether precompile costs 3450 or 6900.
  base=$(cast estimate 0x0000000000000000000000000000000000000004 "0x${VALID}" --rpc-url "$r" 2>&1)
  echo "estimateGas same calldata to identity precompile 0x04 (cost 15+3*5 words=30): $base"
done
