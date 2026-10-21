// Arc testnet indexer. The deployment manifest is written by T-027.
import { readFileSync } from "node:fs";
import { createConfig } from "ponder";
import { getAbiItem } from "viem";
import { loadConfig } from "@czar/config";
import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_PUBLIC_RPC } from "@czar/indexer/chain";
import { arcTransport } from "@czar/indexer/rpc";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";
import {
  erc8183Events,
  eip7708Events,
  gatewayMinterEvents,
  gatewayWalletEvents,
  openEvidenceEvents,
  usdcEvents,
} from "#src/external-abis";
import { EXTERNAL_ADDRESSES } from "#src/external-events";

const config = loadConfig({ env: process.env });
const MS_PER_SECOND = 1000;
const deploymentPath =
  process.env["CZAR_INDEXER_DEPLOYMENT_PATH"] ??
  new URL("../../deployments/arc-testnet.json", import.meta.url);
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as {
  CzarVaultFactory?: string;
  OpenEvidenceLog?: string;
};
if (
  !deployment.CzarVaultFactory ||
  !/^0x[\da-fA-F]{40}$/.test(deployment.CzarVaultFactory) ||
  !deployment.OpenEvidenceLog ||
  !/^0x[\da-fA-F]{40}$/.test(deployment.OpenEvidenceLog)
) {
  throw new Error(
    `Invalid CzarVaultFactory or OpenEvidenceLog address in deployment manifest: ${String(deploymentPath)}`,
  );
}
const factoryAddress = deployment.CzarVaultFactory as `0x${string}`;
const openEvidenceAddress = deployment.OpenEvidenceLog as `0x${string}`;
const startBlock = Number(process.env["CZAR_INDEXER_START_BLOCK"] ?? "0");

export default createConfig({
  chains: {
    arcTestnet: {
      id: ARC_TESTNET_CHAIN_ID,
      // The keyed fallback provider (A9-07) is added once its storage is decided (SCR-104).
      rpc: arcTransport({
        urls: [process.env["CZAR_INDEXER_RPC_URL"] ?? ARC_TESTNET_PUBLIC_RPC],
        getLogsBlockRange: config.get("indexer.getLogsBlockRange") as number,
        retryBaseMs: config.get("indexer.rpcRetryBaseMs") as number,
        retryMax: config.get("indexer.rpcRetryMax") as number,
        failoverHoldMs: (config.get("indexer.failoverHoldSeconds") as number) * MS_PER_SECOND,
      }),
      pollingInterval: config.get("indexer.pollingIntervalMs") as number,
      ethGetLogsBlockRange: config.get("indexer.getLogsBlockRange") as number,
    },
  },
  contracts: {
    CzarVaultFactory: {
      chain: "arcTestnet",
      abi: czarVaultFactoryAbi,
      address: factoryAddress,
      startBlock,
    },
    CzarVault: {
      chain: "arcTestnet",
      abi: czarVaultAbi,
      address: {
        address: factoryAddress,
        event: getAbiItem({ abi: czarVaultFactoryAbi, name: "VaultCreated" }),
        parameter: "vault",
      },
      startBlock,
    },
    USDC: {
      chain: "arcTestnet",
      abi: usdcEvents,
      address: EXTERNAL_ADDRESSES.usdc as `0x${string}`,
      startBlock,
    },
    EIP7708System: {
      chain: "arcTestnet",
      abi: eip7708Events,
      address: EXTERNAL_ADDRESSES.eip7708 as `0x${string}`,
      startBlock,
    },
    GatewayWallet: {
      chain: "arcTestnet",
      abi: gatewayWalletEvents,
      address: EXTERNAL_ADDRESSES.gatewayWallet as `0x${string}`,
      startBlock,
    },
    GatewayMinter: {
      chain: "arcTestnet",
      abi: gatewayMinterEvents,
      address: EXTERNAL_ADDRESSES.gatewayMinter as `0x${string}`,
      startBlock,
    },
    ERC8183: {
      chain: "arcTestnet",
      abi: erc8183Events,
      address: EXTERNAL_ADDRESSES.erc8183 as `0x${string}`,
      startBlock,
    },
    OpenEvidenceLog: {
      chain: "arcTestnet",
      abi: openEvidenceEvents,
      address: openEvidenceAddress,
      startBlock,
    },
  },
});
