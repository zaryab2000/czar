import { describe, expect, it } from "vitest";
import { assertNoSecretInProcess, keychainPassphrase, promptPassphrase } from "../src/index.ts";

describe("passphrase sources (D78)", () => {
  it("signer_passphraseFromArgvOrEnv_rejected", () => {
    const node = ["node", "signer"];
    expect(() => assertNoSecretInProcess([...node, "--passphrase=x"], {})).toThrow(
      expect.objectContaining({ rule: "secret-in-argv" }),
    );
    expect(() => assertNoSecretInProcess([...node, "--password", "x"], {})).toThrow(
      expect.objectContaining({ rule: "secret-in-argv" }),
    );
    expect(() => assertNoSecretInProcess(node, { CZAR_SIGNER_PASSPHRASE: "x" })).toThrow(
      expect.objectContaining({ rule: "secret-in-env" }),
    );
    expect(() => assertNoSecretInProcess(node, { KEYSTORE_PASSPHRASE: "x" })).toThrow(
      expect.objectContaining({ rule: "secret-in-env" }),
    );
    expect(() => assertNoSecretInProcess(node, { CZAR_RELAYER_PRIVATE_KEY: "x" })).toThrow(
      expect.objectContaining({ rule: "secret-in-env" }),
    );
    expect(() =>
      assertNoSecretInProcess([...node, "--dry-run"], {
        CZAR_SIGNER_BACKEND: "local-keystore",
        PATH: "/bin",
      }),
    ).not.toThrow();
  });

  it("never echoes a value in the refusal", () => {
    try {
      assertNoSecretInProcess(["node", "signer"], { CZAR_SIGNER_PASSPHRASE: "hunter2-not-real" });
    } catch (error) {
      expect(String(error)).not.toContain("hunter2");
    }
  });

  it("reads the keychain item through the injected keychain and refuses a missing or denied item", async () => {
    const seen: string[] = [];
    const value = "in-memory-test-value";
    const ok = keychainPassphrase("dev.czar.signer.keystore", (service, account) => {
      seen.push(`${service}/${account}`);
      return { getPassword: () => value, setPassword: () => undefined };
    });
    expect(await ok.read()).toBe(value);
    expect(seen).toEqual(["dev.czar.signer.keystore/keystore"]);
    const missing = keychainPassphrase("dev.czar.signer.keystore", () => ({
      getPassword: () => null,
      setPassword: () => undefined,
    }));
    await expect(missing.read()).rejects.toMatchObject({ rule: "keychain-missing" });
    const denied = keychainPassphrase("dev.czar.signer.keystore", () => {
      throw new Error("user canceled");
    });
    await expect(denied.read()).rejects.toMatchObject({ rule: "keychain-denied" });
  });

  it("refuses to prompt without a terminal, so a passphrase cannot be piped in", async () => {
    const source = promptPassphrase("p: ", {
      input: { isTTY: false } as never,
      output: process.stderr,
    });
    await expect(source.read()).rejects.toMatchObject({ rule: "no-tty" });
  });
});
