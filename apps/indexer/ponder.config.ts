// Arc testnet indexer. The deployment manifest is written by T-027.
import { readFileSync } from "node:fs";
import { createConfig } from "ponder";
import { getAbiItem } from "viem";
import { loadConfig } from "@czar/config";
import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_PUBLIC_RPC } from "@czar/indexer/chain";
import { arcTransport } from "@czar/indexer/rpc";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";

const config = loadConfig({ env: process.env });
const MS_PER_SECOND = 1000;
const deploymentPath =
  process.env["CZAR_INDEXER_DEPLOYMENT_PATH"] ??
  new URL("../../deployments/arc-testnet.json", import.meta.url);
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as {
  CzarVaultFactory?: string;
};
if (!deployment.CzarVaultFactory || !/^0x[\da-fA-F]{40}$/.test(deployment.CzarVaultFactory)) {
  throw new Error(
    `Invalid CzarVaultFactory address in deployment manifest: ${String(deploymentPath)}`,
  );
}
const factoryAddress = deployment.CzarVaultFactory as `0x${string}`;

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
      startBlock: Number(process.env["CZAR_INDEXER_START_BLOCK"] ?? "0"),
    },
    CzarVault: {
      chain: "arcTestnet",
      abi: czarVaultAbi,
      address: {
        address: factoryAddress,
        event: getAbiItem({ abi: czarVaultFactoryAbi, name: "VaultCreated" }),
        parameter: "vault",
      },
      startBlock: Number(process.env["CZAR_INDEXER_START_BLOCK"] ?? "0"),
    },
  },
});
