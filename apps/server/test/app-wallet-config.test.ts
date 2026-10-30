import { describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { validateRecordedExchange } from "@czar/api-contract";
import { createLogger } from "@czar/logging";
import { createApp } from "#src/app";
import { setupDatabase } from "#test/db";
import { createTestContext, TEST_VAULT_FACTORY } from "#test/fixtures";

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
      vaultFactory: TEST_VAULT_FACTORY,
      webauthnRpId: "localhost",
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

  it("returns the host name of app.origin as the WebAuthn RP ID (SCR-157 §3)", async () => {
    const config = loadConfig({
      envFile: { ...walletValues, "app.origin": "https://app.czar.example:8443" },
    });
    const { app } = createTestContext(getPool(), { config });

    const body = (await (await app.request("/v1/app/wallet-config")).json()) as {
      webauthnRpId?: string;
    };

    expect(body.webauthnRpId).toBe("app.czar.example");
  });

  it("requires vaultFactory and webauthnRpId in the getAppWalletConfig contract", () => {
    const complete = {
      ...walletValuesToPublicBody(),
      bundlerOrder: ["circle"],
      bundlerEndpoints: {},
      vaultFactory: TEST_VAULT_FACTORY,
      webauthnRpId: "localhost",
    };
    expect(valid(complete)).toBe(true);
    const { vaultFactory: _factory, ...withoutFactory } = complete;
    const { webauthnRpId: _rpId, ...withoutRpId } = complete;
    expect(valid(withoutFactory)).toBe(false);
    expect(valid(withoutRpId)).toBe(false);
    expect(valid({ ...complete, vaultFactory: "not-an-address" })).toBe(false);
    expect(valid({ ...complete, webauthnRpId: "" })).toBe(false);
  });

  it.each([
    ["no factory", ""],
    ["the zero address", "0x0000000000000000000000000000000000000000"],
    ["a malformed address", "0x1234"],
  ])("refuses to start with %s as the vault factory", (_label, vaultFactory) => {
    expect(() =>
      createApp({
        pool: getPool(),
        config: loadConfig({ envFile: walletValues }),
        logger: createLogger({ service: "server", component: "CZ-12", sink: () => undefined }),
        clock: { now: () => new Date("2026-10-30T00:00:00.000Z") },
        random: { bytes: (length) => Buffer.alloc(length, 1) },
        vaultFactory: vaultFactory as `0x${string}`,
      }),
    ).toThrow("Invalid public wallet configuration: vaultFactory");
  });

  it("refuses to start when the read options name a different factory", () => {
    expect(() =>
      createApp({
        pool: getPool(),
        config: loadConfig({ envFile: walletValues }),
        logger: createLogger({ service: "server", component: "CZ-12", sink: () => undefined }),
        clock: { now: () => new Date("2026-10-30T00:00:00.000Z") },
        random: { bytes: (length) => Buffer.alloc(length, 1) },
        vaultFactory: TEST_VAULT_FACTORY,
        appReadOptions: {
          rpcUrl: "http://127.0.0.1:8549",
          factoryAddress: "0x00000000000000000000000000000000000000f2",
          indexerUrl: "http://127.0.0.1:42069",
        },
      }),
    ).toThrow("Invalid public wallet configuration: vaultFactory");
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

function valid(responseBody: unknown): boolean {
  return validateRecordedExchange("getAppWalletConfig", { responseStatus: 200, responseBody })
    .valid;
}

function walletValuesToPublicBody() {
  return {
    circleClientUrl: walletValues["app.circleClientUrl"],
    circleClientKey: walletValues["app.circleClientKey"],
    arcRpcUrl: walletValues["app.arcRpcUrl"],
  };
}
