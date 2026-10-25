import { describe, expect, it } from "vitest";
import { loadConfig, validateLocalOnlyConfig } from "@czar/config";
import { ARC_TESTNET_PUBLIC_RPC, resolveIndexerRpcUrl } from "@czar/indexer/chain";

describe("indexer RPC selection", () => {
  it("uses the configured Ponder endpoint when provided", () => {
    expect(resolveIndexerRpcUrl("http://127.0.0.1:8545")).toBe("http://127.0.0.1:8545");
  });

  it("uses the same testnet default as Ponder when no override is provided", () => {
    expect(resolveIndexerRpcUrl(undefined)).toBe(ARC_TESTNET_PUBLIC_RPC);
  });

  it("does not allow a local overlay to validate against Ponder's public RPC default", async () => {
    const config = loadConfig({
      envFile: {
        "fetch.localStandinOrigins": ["http://127.0.0.1:4999"],
        "merchants.facilitatorBaseUrl": "http://127.0.0.1:4999",
        "chain.gatewayApiBaseUrl": "http://127.0.0.1:4999",
        "merchants.publicOrigin": "http://127.0.0.1:8787",
        "app.circleClientUrl": "http://127.0.0.1:4999",
        "app.arcRpcUrl": "http://127.0.0.1:8545",
      },
    });
    await expect(
      validateLocalOnlyConfig({
        config,
        overlayPath: new URL("../../../env/local.toml", import.meta.url),
        arcRpcUrl: resolveIndexerRpcUrl(undefined),
      }),
    ).rejects.toThrow("Arc RPC URL");
  });
});
