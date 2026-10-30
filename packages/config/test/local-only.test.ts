import { describe, expect, it, vi } from "vitest";
import { loadConfig, validateLocalOnlyConfig } from "@czar/config";

const localValues = {
  "fetch.localStandinOrigins": ["http://127.0.0.1:4999"],
  "merchants.facilitatorBaseUrl": "http://127.0.0.1:4999",
  "chain.gatewayApiBaseUrl": "http://127.0.0.1:4999",
  "merchants.publicOrigin": "http://127.0.0.1:8787",
  "app.circleClientUrl": "http://127.0.0.1:4999",
  "app.arcRpcUrl": "http://127.0.0.1:8545",
} as const;
const answered = vi.fn(
  async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { currentBlockNumber: "0x1" } })),
);

describe("local-only endpoint guard", () => {
  it("accepts the six local endpoints only with local overlay, loopback RPC, and nodeInfo", async () => {
    await expect(
      validateLocalOnlyConfig({
        config: loadConfig({ envFile: localValues }),
        overlayPath: new URL("../../../env/local.toml", import.meta.url),
        arcRpcUrl: "http://127.0.0.1:8545",
        fetchFn: answered,
      }),
    ).resolves.toBeUndefined();
    expect(answered).toHaveBeenCalledWith(
      "http://127.0.0.1:8545",
      expect.objectContaining({ method: "POST", body: expect.stringContaining("anvil_nodeInfo") }),
    );
  });

  it("rejects loopback endpoints with a non-loopback process RPC", async () => {
    await expect(
      validateLocalOnlyConfig({
        config: loadConfig({ envFile: localValues }),
        overlayPath: new URL("../../../env/local.toml", import.meta.url),
        arcRpcUrl: "https://rpc.testnet.arc.network",
        fetchFn: answered,
      }),
    ).rejects.toThrow("Arc RPC URL");
  });

  it("rejects loopback endpoints when the RPC does not answer anvil_nodeInfo", async () => {
    await expect(
      validateLocalOnlyConfig({
        config: loadConfig({ envFile: localValues }),
        overlayPath: new URL("../../../env/local.toml", import.meta.url),
        arcRpcUrl: "http://127.0.0.1:8545",
        fetchFn: async () => new Response(JSON.stringify({ error: { code: -32601 } })),
      }),
    ).rejects.toThrow("did not answer anvil_nodeInfo");
  });

  it("rejects a local endpoint when no local overlay is selected", async () => {
    await expect(
      validateLocalOnlyConfig({
        config: loadConfig({ envFile: localValues }),
        overlayPath: "",
        arcRpcUrl: "http://127.0.0.1:8545",
        fetchFn: answered,
      }),
    ).rejects.toThrow("local overlay");
  });

  it("requires the local guard for uppercase HTTP loopback URLs", async () => {
    await expect(
      validateLocalOnlyConfig({
        config: loadConfig({ envFile: { "chain.gatewayApiBaseUrl": "HTTP://127.0.0.1:4999" } }),
        overlayPath: "",
        arcRpcUrl: "https://rpc.testnet.arc.io",
        fetchFn: answered,
      }),
    ).rejects.toThrow("local overlay");
  });

  it("rejects non-loopback HTTP and accepts HTTPS defaults", async () => {
    const config = loadConfig({
      envFile: { ...localValues, "chain.gatewayApiBaseUrl": "http://gateway.example" },
    });
    await expect(
      validateLocalOnlyConfig({
        config,
        overlayPath: new URL("../../../env/local.toml", import.meta.url),
        arcRpcUrl: "http://127.0.0.1:8545",
        fetchFn: answered,
      }),
    ).rejects.toThrow("chain.gatewayApiBaseUrl");
  });

  it.each(["http://localhost", "http://localhost:3001"])(
    "accepts app.origin %s (SCR-156)",
    async (origin) => {
      await expect(
        validateLocalOnlyConfig({
          config: loadConfig({ envFile: { ...localValues, "app.origin": origin } }),
          overlayPath: new URL("../../../env/local.toml", import.meta.url),
          arcRpcUrl: "http://127.0.0.1:8545",
          fetchFn: answered,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it.each([
    "https://evil.example",
    "http://127.0.0.1:3001",
    "http://localhost:3001/onboarding",
    "http://user@localhost:3001",
  ])("rejects app.origin %s (SCR-156)", async (origin) => {
    await expect(
      validateLocalOnlyConfig({
        config: loadConfig({ envFile: { ...localValues, "app.origin": origin } }),
        overlayPath: new URL("../../../env/local.toml", import.meta.url),
        arcRpcUrl: "http://127.0.0.1:8545",
        fetchFn: answered,
      }),
    ).rejects.toThrow(/app\.origin/);
  });
});
