// Arc testnet indexer. The deployment manifest is written by T-027.
import { readFileSync } from "node:fs";
import { createConfig } from "ponder";
import { getAbiItem } from "viem";
import { loadConfig, parameterEnvironment, parseParameterToml } from "@czar/config";
import { ARC_TESTNET_CHAIN_ID, resolveIndexerRpcUrl } from "@czar/indexer/chain";
import { arcTransport } from "@czar/indexer/rpc";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";
import {
  erc8183Events,
  eip7708Events,
  gatewayMinterEvents,
  gatewayWalletEvents,
  openEvidenceEvents,
  proxyEvents,
  usdcEvents,
} from "#src/external-abis";
import { EXTERNAL_ADDRESSES } from "#src/external-events";
import {
  cloudConfigPointer,
  cloudDatabaseConfig,
  loadCloudIndexerConfig,
  refuseUnsafeCloudConfig,
} from "#src/cloud-config";

const startBlockValue = process.env["CZAR_INDEXER_START_BLOCK"];
if (startBlockValue !== undefined && !/^\d+$/.test(startBlockValue)) {
  throw new Error(
    "CZAR_INDEXER_START_BLOCK must contain only decimal digits; leave it unset to use 0.",
  );
}
const startBlock = startBlockValue === undefined ? 0 : Number(startBlockValue);
if (!Number.isSafeInteger(startBlock)) {
  throw new Error("CZAR_INDEXER_START_BLOCK must be a safe integer block number.");
}

const localConfigPath =
  process.env["CZAR_LOCAL_CONFIG"] ?? new URL("../../../env/local.toml", import.meta.url);
// SCR-170 §3 (a): taken only when the pointer CZAR_CLOUD_CONFIG is set; unset, nothing below changes.
const cloudConfigPath = cloudConfigPointer(process.env);
const config =
  cloudConfigPath === undefined
    ? loadConfig({
        envFile: parseParameterToml(readFileSync(localConfigPath, "utf8")),
        env: parameterEnvironment(process.env),
      })
    : loadCloudIndexerConfig(cloudConfigPath, process.env);
if (cloudConfigPath !== undefined)
  refuseUnsafeCloudConfig(config, resolveIndexerRpcUrl(process.env["CZAR_INDEXER_RPC_URL"]));
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

export default createConfig({
  ...(cloudConfigPath === undefined ? {} : { database: cloudDatabaseConfig(config, process.env) }),
  chains: {
    arcTestnet: {
      id: ARC_TESTNET_CHAIN_ID,
      // The keyed fallback provider (A9-07) is added once its storage is decided (SCR-104).
      rpc: arcTransport({
        urls: [resolveIndexerRpcUrl(process.env["CZAR_INDEXER_RPC_URL"])],
        getLogsBlockRange: config.get("indexer.getLogsBlockRange") as number,
        retryBaseMs: config.get("indexer.rpcRetryBaseMs") as number,
        retryMax: config.get("indexer.rpcRetryMax") as number,
        failoverHoldMs: (config.get("indexer.failoverHoldSeconds") as number) * MS_PER_SECOND,
      }),
      pollingInterval: config.get("indexer.pollingIntervalMs") as number,
      ethGetLogsBlockRange: config.get("indexer.getLogsBlockRange") as number,
    },
  },
  blocks: {
    GatewayPoll: { chain: "arcTestnet", startBlock },
    IndexerLag: { chain: "arcTestnet", startBlock },
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
      abi: [...usdcEvents, ...proxyEvents],
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
      abi: [...gatewayWalletEvents, ...proxyEvents],
      address: EXTERNAL_ADDRESSES.gatewayWallet as `0x${string}`,
      startBlock,
    },
    GatewayMinter: {
      chain: "arcTestnet",
      abi: [...gatewayMinterEvents, ...proxyEvents],
      address: EXTERNAL_ADDRESSES.gatewayMinter as `0x${string}`,
      startBlock,
    },
    ERC8183: {
      chain: "arcTestnet",
      abi: [...erc8183Events, ...proxyEvents],
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
