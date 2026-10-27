// Test project for the kill-and-resume check (T-030): the production transport against the fault proxy.
import { createConfig } from "ponder";
import { parseAbi } from "viem";
import { arcTransport } from "@czar/indexer/rpc";

const rpcUrl = process.env["CZAR_TEST_RPC_URL"] ?? "";

export default createConfig({
  database: { kind: "pglite", directory: process.env["CZAR_TEST_PGLITE_DIR"] ?? ".ponder/pglite" },
  chains: {
    arcTestnet: {
      id: 5042002,
      rpc: arcTransport({
        urls: [rpcUrl],
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
    Emitter: {
      chain: "arcTestnet",
      abi: parseAbi(["event Ping(uint256 n)"]),
      address: "0x00000000000000000000000000000000000c2a5e",
      startBlock: 0,
      endBlock: Number(process.env["CZAR_TEST_END_BLOCK"] ?? "0"),
    },
  },
});
