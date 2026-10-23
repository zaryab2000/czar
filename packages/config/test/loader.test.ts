import { describe, expect, it } from "vitest";
import { ConfigError, envVarName, loadConfig, PARAMETERS } from "@czar/config";

function errorOf(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
  it("returns spec defaults", () => {
    const config = loadConfig();
    expect(config.get("app.challengeTtlSeconds")).toBe(300);
    expect(config.get("app.bundlerEndpoints")).toEqual({});
    expect(config.get("daemon.hookPort")).toBe(47011);
    expect(config.get("indexer.getLogsBlockRange")).toBe(9999);
    expect(config.get("signer.backend")).toBe("local-keystore");
    expect(config.get("vault.maxAuthorizationsPerReservation")).toBe(128);
    expect(config.get("payer.job.minExpiryLeadSeconds")).toBe(360);
    expect(config.get("payer.pullbackFallbackPollSeconds")).toBe(60);
    expect(config.get("payer.job.deliverableStorePath")).toBe("./var/job-deliverables");
    expect(config.get("payer.vaultEventPollMs")).toBe(4000);
    expect(config.get("chain.usdcAddress")).toBe("0x3600000000000000000000000000000000000000");
    expect(config.get("chain.gatewayWalletAddress")).toBe(
      "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    );
  });

  it("env overlay overrides a default", () => {
    const config = loadConfig({ env: { CZAR_DAEMON_HOOK_PORT: "48000" } });
    expect(config.get("daemon.hookPort")).toBe(48000);
    expect(config.dump().find((entry) => entry.key === "daemon.hookPort")?.source).toBe("env-var");
  });

  it("environment variables win over the environment file", () => {
    const config = loadConfig({
      envFile: { "daemon.hookPort": 47100, "redaction.languages": ["en", "de"] },
      env: { CZAR_DAEMON_HOOK_PORT: "47200" },
    });
    expect(config.get("daemon.hookPort")).toBe(47200);
    expect(config.get("redaction.languages")).toEqual(["en", "de"]);
  });

  it("ignores variables without the CZAR_ prefix", () => {
    expect(
      loadConfig({ env: { PATH: "/usr/bin", HOME: "/home/x" } }).get("daemon.heartbeatS"),
    ).toBe(60);
  });

  it("unknown key → startup error", () => {
    expect(errorOf(() => loadConfig({ env: { CZAR_DAEMON_HOOK_PORTT: "1" } })).code).toBe(
      "unknown-key",
    );
    expect(errorOf(() => loadConfig({ envFile: { "daemon.nope": 1 } })).code).toBe("unknown-key");
  });

  it.each(["passphrase", "secret", "private", "mnemonic", "seed", "PASSPHRASE"])(
    "refuses a CZAR_* variable whose name contains %s (D78)",
    (fragment) => {
      const name = `CZAR_SIGNER_${fragment.toUpperCase()}`;
      expect(errorOf(() => loadConfig({ env: { [name]: "x" } })).code).toBe("secret-like-name");
    },
  );

  it("refuses an environment-file key whose name looks like a secret, before the unknown-key check", () => {
    expect(errorOf(() => loadConfig({ envFile: { "signer.keystorePassphrase": "x" } })).code).toBe(
      "secret-like-name",
    );
  });

  it("never echoes the value of a refused variable", () => {
    const error = errorOf(() => loadConfig({ env: { CZAR_SIGNER_SEED_WORDS: "abandon abandon" } }));
    expect(error.message).not.toContain("abandon");
  });

  it("refuses to override a contract mirror", () => {
    const error = errorOf(() =>
      loadConfig({ env: { CZAR_VAULT_MAX_AUTHORIZATIONS_PER_RESERVATION: "200" } }),
    );
    expect(error.code).toBe("read-only");
  });

  it("rejects values of the wrong type", () => {
    expect(errorOf(() => loadConfig({ env: { CZAR_DAEMON_HOOK_PORT: "47.5" } })).code).toBe(
      "invalid-value",
    );
    expect(errorOf(() => loadConfig({ env: { CZAR_DAEMON_HOOK_PORT: "" } })).code).toBe(
      "invalid-value",
    );
    expect(errorOf(() => loadConfig({ env: { CZAR_SIGNER_BACKEND: "hsm" } })).code).toBe(
      "invalid-value",
    );
    expect(errorOf(() => loadConfig({ envFile: { "redaction.languages": "en" } })).code).toBe(
      "invalid-value",
    );
  });

  it("a parameter with no spec default must be set before use", () => {
    const config = loadConfig();
    expect(config.has("indexer.startBlock")).toBe(false);
    expect(errorOf(() => config.get("indexer.startBlock")).code).toBe("missing-value");
    expect(loadConfig({ env: { CZAR_INDEXER_START_BLOCK: "123" } }).get("indexer.startBlock")).toBe(
      123,
    );
  });
});

describe("registry", () => {
  it("has unique keys and unique environment names", () => {
    const keys = PARAMETERS.map((spec) => spec.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys.map(envVarName)).size).toBe(keys.length);
  });

  it("every entry has a unit field, a reason and a spec source", () => {
    for (const spec of PARAMETERS) {
      expect(spec.reason.length, spec.key).toBeGreaterThan(0);
      expect(spec.source, spec.key).toMatch(
        /^docs\/specs\/(0[0-5][^:]*|06-review\/[^:]*)\.md:\d+$/,
      );
    }
  });

  it("no registry key looks like a secret", () => {
    const fragments = ["passphrase", "secret", "private", "mnemonic", "seed"];
    // merchants.lab.seed is a deterministic PRNG seed for lab test profiles, not key material.
    const allowlist = new Set(["merchants.lab.seed", "selection.seedJobRuns"]);
    for (const spec of PARAMETERS) {
      if (allowlist.has(spec.key)) continue;
      expect(
        fragments.some((fragment) => spec.key.toLowerCase().includes(fragment)),
        spec.key,
      ).toBe(false);
    }
  });

  it("includes the T-004 review-fix keys", () => {
    const keys = new Set<string>(PARAMETERS.map((spec) => spec.key));
    for (const key of [
      "signer.backend",
      "signer.keystorePath",
      "signer.keychainService",
      "signer.socketPath",
      "signer.freezeStateMaxAgeSec",
      "signer.gas.K3.minAtomic",
      "signer.pocketKeyRetainHours",
      "fetch.maxRedirects",
      "fetch.maxBytes",
      "fetch.timeoutMs",
      "fetch.localMerchantOrigins",
      "payer.pullbackWindowBlocks",
      "acceptance.deliverableRefetchTries",
      "acceptance.deliverableRefetchDelayMs",
      "screen.chunkOverlapChars",
      "api.briefSignatureMaxAgeSeconds",
    ]) {
      expect(keys.has(key), key).toBe(true);
    }
  });

  it("matches the dump snapshot", () => {
    expect(loadConfig().dump()).toMatchSnapshot();
  });
});
