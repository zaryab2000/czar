import { createConfig } from "ponder";
import { getAbiItem } from "viem";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";
import { arcTransport } from "@czar/indexer/rpc";
import {
  erc8183Events,
  eip7708Events,
  gatewayMinterEvents,
  gatewayWalletEvents,
  openEvidenceEvents,
  usdcEvents,
} from "#src/external-abis";
import { EXTERNAL_ADDRESSES } from "#src/external-events";

const address = process.env["CZAR_TEST_FACTORY"] as `0x${string}`;
const openEvidenceAddress = process.env["CZAR_TEST_OPEN_EVIDENCE"] as `0x${string}`;
const rpc = process.env["CZAR_TEST_RPC_URL"] ?? "";
const endBlock = Number(process.env["CZAR_TEST_END_BLOCK"] ?? "0");

export default createConfig({
  database: { kind: "pglite", directory: process.env["CZAR_TEST_PGLITE_DIR"] ?? ".ponder/pglite" },
  chains: {
    arcTestnet: {
      id: 5042002,
      rpc: arcTransport({
        urls: [rpc],
        getLogsBlockRange: 9999,
        retryBaseMs: 5,
        retryMax: 50,
        failoverHoldMs: 0,
      }),
      ethGetLogsBlockRange: 9999,
      pollingInterval: 1000,
    },
  },
  contracts: {
    CzarVaultFactory: {
      chain: "arcTestnet",
      abi: czarVaultFactoryAbi,
      address,
      startBlock: 0,
      endBlock,
    },
    CzarVault: {
      chain: "arcTestnet",
      abi: czarVaultAbi,
      address: {
        address,
        event: getAbiItem({ abi: czarVaultFactoryAbi, name: "VaultCreated" }),
        parameter: "vault",
      },
      startBlock: 0,
      endBlock,
    },
    USDC: {
      chain: "arcTestnet",
      abi: usdcEvents,
      address: EXTERNAL_ADDRESSES.usdc as `0x${string}`,
      startBlock: 0,
      endBlock,
    },
    EIP7708System: {
      chain: "arcTestnet",
      abi: eip7708Events,
      address: EXTERNAL_ADDRESSES.eip7708 as `0x${string}`,
      startBlock: 0,
      endBlock,
    },
    GatewayWallet: {
      chain: "arcTestnet",
      abi: gatewayWalletEvents,
      address: EXTERNAL_ADDRESSES.gatewayWallet as `0x${string}`,
      startBlock: 0,
      endBlock,
    },
    GatewayMinter: {
      chain: "arcTestnet",
      abi: gatewayMinterEvents,
      address: EXTERNAL_ADDRESSES.gatewayMinter as `0x${string}`,
      startBlock: 0,
      endBlock,
    },
    ERC8183: {
      chain: "arcTestnet",
      abi: erc8183Events,
      address: EXTERNAL_ADDRESSES.erc8183 as `0x${string}`,
      startBlock: 0,
      endBlock,
    },
    OpenEvidenceLog: {
      chain: "arcTestnet",
      abi: openEvidenceEvents,
      address: openEvidenceAddress,
      startBlock: 0,
      endBlock,
    },
  },
});
