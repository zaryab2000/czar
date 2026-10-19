#!/usr/bin/env bash
# Measure the P256VERIFY gas price on Arc via eth_call + code override (nothing is deployed).
# Probe runtime bytecode reads calldata = [gas:32 bytes][160-byte precompile input],
# STATICCALLs 0x100 with exactly that gas, and returns [result word][success flag].
# EIP-7951 charges 6900 gas; RIP-7212 charged 3450.
set -euo pipefail
PROBE=0x00000000000000000000000000000000c0ffee01
CODE=0x6020360360206000376020610200602036036000610100600035fa610220526040610200f3
VALID=bb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca6050232ba3a8be6b94d5ec80a6d9d1190a436effe50d85a1eee859b8cc6af9bd5c2e184cd60b855d442f5b3c7b11eb6c4e0ae7525fe710fab9aa7c77a67f79e6fadd762927b10512bae3eddcfe467828128bad2903269919f7086069c8c4df6c732838c7787964eaac00e5921fb1498a60f4606766b3d9685001558d1a974e7341513e
for net in mainnet=https://rpc.mainnet.arc.io testnet=https://rpc.testnet.arc.io; do
  n=${net%%=*}; r=${net#*=}
  B=$(cast block-number --rpc-url "$r")
  echo "### $n block=$B date=$(date -u +%FT%TZ)"
  for g in 3449 3450 6899 6900 100000; do
    gw=$(cast to-uint256 $g | cut -c3-)
    out=$(cast call $PROBE "0x${gw}${VALID}" --override-code "$PROBE:$CODE" --rpc-url "$r" --block "$B" 2>&1)
    echo "gas=$g -> $out"
  done
done
