#!/usr/bin/env bash
# Check whether well-known singleton contracts have code on Arc mainnet and testnet.
# Prints code size in bytes and keccak256 of the runtime code at a pinned block.
set -euo pipefail
ADDRS=(
  "EntryPoint v0.6|0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"
  "EntryPoint v0.7|0x0000000071727De22E5E9d8BAf0edAc6f37da032"
  "EntryPoint v0.8|0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108"
  "EntryPoint v0.9|0x433709009B8330FDa32311DF1C2AFA402eD8D009"
  "SenderCreator v0.9|0x0A630a99Df908A81115A3022927Be82f9299987e"
  "0xSplits v1 SplitMain|0x2ed6c4B5dA6378c7897AC67Ba9e43102Feb694EE"
  "0xSplits v2 PullSplitFactory (v2.0)|0x80f1B766817D04870f115fEBbcCADF8DBF75E017"
  "0xSplits v2 PushSplitFactory (v2.0)|0xaDC87646f736d6A82e9a6539cddC488b2aA07f38"
  "0xSplits PullSplitFactoryV2.1|0x5cbA88D55Cec83caD5A105Ad40C8c9aF20bE21d1"
  "0xSplits PushSplitFactoryV2.1|0xDc6259E13ec0621e6F19026b2e49D846525548Ed"
  "0xSplits PullSplitFactoryV2.2|0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1"
  "0xSplits PushSplitFactoryV2.2|0x8E8eB0cC6AE34A38B67D5Cf91ACa38f60bc3Ecf4"
  "0xSplits SplitsWarehouse|0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8"
  "EAS (Ethereum mainnet addr)|0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587"
  "EAS SchemaRegistry (Ethereum mainnet addr)|0xA7b39296258348C78294F95B872b282326A97BDF"
  "EAS OP-stack predeploy|0x4200000000000000000000000000000000000021"
  "EAS SchemaRegistry OP-stack predeploy|0x4200000000000000000000000000000000000020"
  "EAS (Arbitrum One addr)|0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458"
  "EAS (Polygon addr)|0x5E634ef5355f45A855d02D66eCD687b1502AF790"
  "ENS Registry (Ethereum addr)|0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e"
  "Multicall3|0xcA11bde05977b3631167028862bE2a173976CA11"
  "Arachnid CREATE2 deployer|0x4e59b44847b379578588920cA78FbF26c0B4956C"
  "Safe singleton factory|0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7"
  "CreateX|0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed"
  "Permit2|0x000000000022D473030F116dDEE9F6B43aC78BA3"
)
for net in mainnet=https://rpc.mainnet.arc.io testnet=https://rpc.testnet.arc.io; do
  n=${net%%=*}; r=${net#*=}
  B=$(cast block-number --rpc-url "$r")
  echo "### $n chainid=$(cast chain-id --rpc-url "$r") block=$B date=$(date -u +%FT%TZ)"
  for e in "${ADDRS[@]}"; do
    name=${e%%|*}; a=${e#*|}
    code=$(cast code "$a" --rpc-url "$r" --block "$B")
    size=$(( (${#code} - 2) / 2 ))
    if [ "$size" -gt 0 ]; then h=$(cast keccak "$code"); else h=-; fi
    printf '%-45s %s size=%s codehash=%s\n' "$name" "$a" "$size" "$h"
  done
done
