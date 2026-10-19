// Ponder project for CZ-19 (T-030): Arc testnet, ≤ 9,999-block log pages, -32012 / -32014 handling.
// Contracts and projections are added by T-031 and T-032 from deployments/arc-testnet.json (T-027).
import { createConfig } from "ponder";
import { loadConfig } from "@czar/config";
import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_PUBLIC_RPC } from "./src/chain.ts";
import { arcTransport } from "./src/rpc/arc-transport.ts";

const config = loadConfig({ env: process.env });
const MS_PER_SECOND = 1000;

export default createConfig({
  chains: {
    arcTestnet: {
      id: ARC_TESTNET_CHAIN_ID,
      // The keyed fallback provider (A9-07) is added once its storage is decided (SCR-104).
      rpc: arcTransport({
        urls: [ARC_TESTNET_PUBLIC_RPC],
        getLogsBlockRange: config.get("indexer.getLogsBlockRange") as number,
        retryBaseMs: config.get("indexer.rpcRetryBaseMs") as number,
        retryMax: config.get("indexer.rpcRetryMax") as number,
        failoverHoldMs: (config.get("indexer.failoverHoldSeconds") as number) * MS_PER_SECOND,
      }),
      pollingInterval: config.get("indexer.pollingIntervalMs") as number,
      ethGetLogsBlockRange: config.get("indexer.getLogsBlockRange") as number,
    },
  },
  contracts: {},
});
