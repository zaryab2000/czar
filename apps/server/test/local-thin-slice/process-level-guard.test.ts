import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { validateT050aEndpoints } from "#test/local-thin-slice/preflight";

const localConfig = loadConfig({
  envFile: {
    "fetch.localStandinOrigins": ["http://127.0.0.1:4999"],
    "merchants.facilitatorBaseUrl": "http://127.0.0.1:4999",
    "chain.gatewayApiBaseUrl": "http://127.0.0.1:4999",
    "merchants.publicOrigin": "http://127.0.0.1:8787",
    "app.circleClientUrl": "http://127.0.0.1:4999",
    "app.arcRpcUrl": "http://127.0.0.1:8545",
  },
});

const localOverlay = new URL("../../../../env/local.toml", import.meta.url);
const defaults = {
  config: localConfig,
  overlayPath: localOverlay,
  rpcUrl: "http://127.0.0.1:8545",
  serverUrl: "http://127.0.0.1:3000",
  merchantUrl: "http://127.0.0.1:8787",
  databaseUrl: "postgres://postgres@127.0.0.1:15433/postgres",
  fetchFn: async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { currentBlockNumber: "0x1" } })),
};

describe("T-050a process endpoint guard", () => {
  it("allows loopback endpoints only with the local overlay and Anvil nodeInfo", async () => {
    await expect(validateT050aEndpoints(defaults)).resolves.toBeUndefined();
  });

  it("rejects a non-local overlay before querying the RPC", async () => {
    const fetchFn = vi.fn(defaults.fetchFn);
    await expect(
      validateT050aEndpoints({
        ...defaults,
        overlayPath: new URL("../../../../env/testnet.toml", import.meta.url),
        fetchFn,
      }),
    ).rejects.toThrow("local overlay");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["RPC", { rpcUrl: "https://rpc.testnet.arc.io" }],
    ["server", { serverUrl: "http://server.example:3000" }],
    ["merchant", { merchantUrl: "https://merchant.example" }],
    ["Postgres", { databaseUrl: "postgres://postgres@db.example:15433/postgres" }],
  ])("rejects a non-loopback %s endpoint before making a request", async (_name, endpoint) => {
    const fetchFn = vi.fn(defaults.fetchFn);
    await expect(validateT050aEndpoints({ ...defaults, ...endpoint, fetchFn })).rejects.toThrow(
      "loopback",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["RPC error", async () => new Response(JSON.stringify({ error: { code: -32601 } }))],
    ["missing result", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }))],
    ["unavailable RPC", async () => Promise.reject(new Error("connection refused"))],
  ])("rejects %s from anvil_nodeInfo", async (_name, fetchFn) => {
    await expect(validateT050aEndpoints({ ...defaults, fetchFn })).rejects.toThrow(
      "did not answer anvil_nodeInfo",
    );
  });
});
