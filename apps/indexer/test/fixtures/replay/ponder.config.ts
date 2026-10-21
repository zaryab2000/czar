import { createConfig } from "ponder";
import { getAbiItem } from "viem";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";
import { arcTransport } from "@czar/indexer/rpc";

const address = process.env["CZAR_TEST_FACTORY"] as `0x${string}`;
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
  },
});
