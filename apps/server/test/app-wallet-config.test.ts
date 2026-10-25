import { describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { validateRecordedExchange } from "@czar/api-contract";
import { setupDatabase } from "#test/db";
import { createTestContext } from "#test/fixtures";

const getPool = setupDatabase();
const walletValues = {
  "app.circleClientUrl": "http://127.0.0.1:4337",
  "app.circleClientKey": "e2e-public-client-key",
  "app.arcRpcUrl": "http://127.0.0.1:8549",
};

describe("public wallet configuration", () => {
  it("returns the validated config without a session and prevents caching", async () => {
    const config = loadConfig({ envFile: walletValues });
    const { app, logLines } = createTestContext(getPool(), { config });

    const response = await app.request("/v1/app/wallet-config");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(body).toEqual({
      ...walletValuesToPublicBody(),
      bundlerOrder: ["circle", "pimlico", "alchemy", "zerodev"],
      bundlerEndpoints: {},
    });
    expect(
      validateRecordedExchange("getAppWalletConfig", {
        responseStatus: response.status,
        responseBody: body,
      }).valid,
    ).toBe(true);
    expect(logLines.join("\n")).not.toContain(walletValues["app.circleClientUrl"]);
    expect(logLines.join("\n")).not.toContain(walletValues["app.circleClientKey"]);
  });

  it("fails app startup when required wallet configuration is missing", () => {
    expect(() => createTestContext(getPool(), { config: loadConfig() })).toThrow(
      "app.circleClientUrl has no default",
    );
  });

  it("fails app startup when a public endpoint is malformed", () => {
    const config = loadConfig({
      envFile: { ...walletValues, "app.arcRpcUrl": "not-a-url" },
    });

    expect(() => createTestContext(getPool(), { config })).toThrow(
      "Invalid public wallet configuration",
    );
  });
});

function walletValuesToPublicBody() {
  return {
    circleClientUrl: walletValues["app.circleClientUrl"],
    circleClientKey: walletValues["app.circleClientKey"],
    arcRpcUrl: walletValues["app.arcRpcUrl"],
  };
}
