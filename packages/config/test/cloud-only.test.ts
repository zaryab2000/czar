// PM-061: validateCloudConfig refuses every shape SCR-170 §3 forbids.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ARC_TESTNET_CHAIN_ID,
  ConfigError,
  hasSecretLikeName,
  loadConfig,
  loadConfigFile,
  PARAMETERS,
  SECRET_NAME_FRAGMENTS,
  validateCloudConfig,
} from "@czar/config";
import { PRODUCTION_PARAMETERS } from "../src/registry-production.ts";
import type { CloudGuardOptions } from "@czar/config";

const ARC_CHAIN_ID = ARC_TESTNET_CHAIN_ID;
const RPC = "https://rpc.testnet.arc.io";

/** The smallest environment file that satisfies every §3 rule. */
const cloudEnvFile = {
  "deploy.environment": "cloud-testnet",
  "app.origin": "https://app.czar.example",
  "merchants.publicOrigin": "https://merchants.czar.example",
  "signer.backend": "gcp-kms",
} as const;

const options = (
  overrides: Partial<CloudGuardOptions> = {},
  envFile: Readonly<Record<string, unknown>> = cloudEnvFile,
): CloudGuardOptions => ({
  config: loadConfig({ envFile }),
  role: "server",
  chainId: ARC_CHAIN_ID,
  rpcUrls: [RPC],
  ...overrides,
});

const refusal = (run: () => void, key: string) => {
  expect(run).toThrow(ConfigError);
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    const failure = error as ConfigError;
    expect(failure.key).toBe(key);
    expect(failure.code).toBe("invalid-value");
    // Messages name keys, never values (errors.ts header rule).
    expect(failure.message).toContain("refusing to start");
  }
};

describe("validateCloudConfig (SCR-170 §3)", () => {
  it("accepts a cloud-shaped config for every role", () => {
    for (const role of ["server", "merchants", "indexer"] as const)
      expect(() => validateCloudConfig(options({ role }))).not.toThrow();
    expect(() => validateCloudConfig(options({ role: "signer" }))).not.toThrow();
  });

  it("refuses an environment other than cloud-testnet", () => {
    refusal(
      () => validateCloudConfig(options({}, { ...cloudEnvFile, "deploy.environment": "local" })),
      "deploy.environment",
    );
    // The default is "local", so a config that sets nothing is refused too.
    refusal(() => validateCloudConfig(options({}, {})), "deploy.environment");
  });

  it("refuses any chain id but Arc testnet", () => {
    refusal(() => validateCloudConfig(options({ chainId: 1 })), "chainId");
    refusal(() => validateCloudConfig(options({ chainId: 5042003 })), "chainId");
  });

  it("refuses an RPC URL whose host is not allowed", () => {
    refusal(
      () => validateCloudConfig(options({ rpcUrls: [RPC, "https://rpc.testnet.arc.network"] })),
      "deploy.allowedRpcHosts",
    );
    refusal(
      () => validateCloudConfig(options({ rpcUrls: ["http://127.0.0.1:8545"] })),
      "deploy.allowedRpcHosts",
    );
    refusal(
      () => validateCloudConfig(options({ rpcUrls: ["not a url"] })),
      "deploy.allowedRpcHosts",
    );
  });

  it("requires at least one RPC URL", () => {
    refusal(() => validateCloudConfig(options({ rpcUrls: [] })), "deploy.allowedRpcHosts");
  });

  it("refuses a non-https app origin", () => {
    refusal(
      () =>
        validateCloudConfig(
          options({}, { ...cloudEnvFile, "app.origin": "http://app.czar.example" }),
        ),
      "app.origin",
    );
  });

  it("refuses a non-https merchants origin", () => {
    refusal(
      () =>
        validateCloudConfig(
          options(
            {},
            { ...cloudEnvFile, "merchants.publicOrigin": "http://merchants.czar.example" },
          ),
        ),
      "merchants.publicOrigin",
    );
  });

  it("accepts an unset fetch.localStandinOrigins and refuses a non-empty one", () => {
    // The key has no default, so the check must use has() before get().
    expect(() => validateCloudConfig(options())).not.toThrow();
    expect(() =>
      validateCloudConfig(options({}, { ...cloudEnvFile, "fetch.localStandinOrigins": [] })),
    ).not.toThrow();
    refusal(
      () =>
        validateCloudConfig(
          options({}, { ...cloudEnvFile, "fetch.localStandinOrigins": ["http://127.0.0.1:8081"] }),
        ),
      "fetch.localStandinOrigins",
    );
  });

  it("refuses the signer role on the local keystore backend", () => {
    refusal(
      () =>
        validateCloudConfig(
          options({ role: "signer" }, { ...cloudEnvFile, "signer.backend": "local-keystore" }),
        ),
      "signer.backend",
    );
    // Other roles do not read the signer backend.
    expect(() =>
      validateCloudConfig(
        options({ role: "server" }, { ...cloudEnvFile, "signer.backend": "local-keystore" }),
      ),
    ).not.toThrow();
  });

  it("refuses the test-merchant lab unless the payment network is a test chain", () => {
    // merchants.lab.enabled defaults to true, and the Arc testnet default payment network is
    // a test chain, so the accepted config above already covers the allowed case.
    expect(() =>
      validateCloudConfig(options({}, { ...cloudEnvFile, "merchants.lab.enabled": true })),
    ).not.toThrow();
    // Any chain that is not a known test chain counts as mainnet (fail closed).
    for (const network of ["eip155:1", "eip155:8453", "eip155:137", "eip155:999999"])
      refusal(
        () =>
          validateCloudConfig(
            options(
              {},
              {
                ...cloudEnvFile,
                "merchants.lab.enabled": true,
                "selection.paymentNetwork": network,
              },
            ),
          ),
        "merchants.lab.enabled",
      );
    // With the lab off, this rule passes and the refusal moves to the chain-agreement rule:
    // a mainnet payment network can never pass the whole guard.
    refusal(
      () =>
        validateCloudConfig(
          options(
            {},
            {
              ...cloudEnvFile,
              "merchants.lab.enabled": false,
              "selection.paymentNetwork": "eip155:1",
            },
          ),
        ),
      "selection.paymentNetwork",
    );
  });

  it("refuses a chain id that disagrees with selection.paymentNetwork", () => {
    refusal(
      () =>
        validateCloudConfig(
          options({}, { ...cloudEnvFile, "selection.paymentNetwork": "eip155:31337" }),
        ),
      "selection.paymentNetwork",
    );
  });
});

describe("PRODUCTION_PARAMETERS (SCR-170 §7)", () => {
  it("adds unique keys that collide with nothing in the rest of the registry", () => {
    const production = PRODUCTION_PARAMETERS.map((spec) => spec.key);
    expect(new Set(production).size).toBe(production.length);
    const others = PARAMETERS.filter(
      (spec) => !(production as readonly string[]).includes(spec.key),
    );
    expect(others.length).toBe(PARAMETERS.length - production.length);
    for (const key of production) expect(others.some((spec) => spec.key === key)).toBe(false);
  });

  it("loads every production key with its default through the ordinary loader", () => {
    const config = loadConfig();
    expect(config.get("deploy.environment")).toBe("local");
    expect(config.get("deploy.allowedRpcHosts")).toEqual(["rpc.testnet.arc.io"]);
    expect(config.get("deploy.credentialFilesDir")).toBe("/run/czar/secrets");
    expect(config.get("deploy.backupRetentionDays")).toBe(14);
    expect(config.get("signer.kms.keyVersions")).toEqual({});
    expect(config.get("models.provider")).toBe("none");
    expect(config.get("models.anthropic.maxPromptTokens")).toBe(100000);
    // Both no-default keys are absent until an environment file sets them.
    expect(config.has("signer.kms.projectId")).toBe(false);
    expect(config.has("signer.socketGroupGid")).toBe(false);
  });

  it("names no key like a secret and cites a spec line for each", () => {
    for (const spec of PRODUCTION_PARAMETERS) {
      expect(hasSecretLikeName(spec.key), spec.key).toBe(false);
      expect(spec.source, spec.key).toMatch(/^docs\/specs\/.+\.md:[0-9]+$/);
      expect(spec.reason.length, spec.key).toBeGreaterThan(0);
    }
  });
});

describe("env/cloud.example.toml", () => {
  const examplePath = new URL("../../../env/cloud.example.toml", import.meta.url);

  it("loads with no unknown or secret-like key and passes the cloud guard", async () => {
    const config = await loadConfigFile(examplePath);
    expect(() =>
      validateCloudConfig({
        config,
        role: "server",
        chainId: ARC_TESTNET_CHAIN_ID,
        rpcUrls: ["https://rpc.testnet.arc.io"],
      }),
    ).not.toThrow();
    expect(() =>
      validateCloudConfig({
        config,
        role: "signer",
        chainId: ARC_TESTNET_CHAIN_ID,
        rpcUrls: ["https://rpc.testnet.arc.io"],
      }),
    ).not.toThrow();
  });

  it("contains no credential value, only file names", async () => {
    const source = await readFile(examplePath, "utf8");
    for (const key of SECRET_NAME_FRAGMENTS)
      expect(source.toLowerCase().includes(`"${key}`), key).toBe(false);
    // No 0x-prefixed key material, and no bearer-looking token.
    expect(source).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(source).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});
