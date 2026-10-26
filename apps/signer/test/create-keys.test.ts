// T-105 script tests. Only the dry run executes; it keeps throwaway keys in memory and writes nothing.
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  createKeys,
  KEYS_FILE,
  LOCAL_KEYS_FILE,
  PHASE1_KEYS,
  validateKeysFile,
} from "../scripts/create-keys.ts";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sample = () => ({
  network: "arc-testnet",
  chainId: 5042002,
  backend: "local-keystore",
  createdAt: "2026-10-19T00:00:00.000Z",
  addresses: Object.fromEntries(
    PHASE1_KEYS.map(({ keyId, role }, i) => [
      keyId,
      { role, address: getAddress(`0x${(i + 1).toString(16).padStart(40, "a")}`) },
    ]),
  ),
});

describe("deployments/arc-testnet-keys.json validation", () => {
  it("accepts seven distinct checksummed addresses", () => {
    expect(validateKeysFile(sample())).toEqual([]);
  });

  it("refuses lowercase addresses, repeats, missing keys and secret-named fields", () => {
    const lower = sample();
    (lower.addresses["K3"] as { address: string }).address = (
      lower.addresses["K3"] as { address: string }
    ).address.toLowerCase();
    expect(validateKeysFile(lower).join()).toMatch(/K3 address is not checksummed/);

    const repeat = sample();
    (repeat.addresses["K5"] as { address: string }).address = (
      repeat.addresses["K3"] as { address: string }
    ).address;
    expect(validateKeysFile(repeat).join()).toMatch(/repeats/);

    const missing = sample();
    delete (missing.addresses as Record<string, unknown>)["K20"];
    expect(validateKeysFile(missing).join()).toMatch(/exactly/);

    for (const field of ["key", "secret", "privateKey", "mnemonic"]) {
      const bad = { ...sample(), [field]: "x" };
      expect(validateKeysFile(bad).join()).toMatch(/forbidden field/);
    }
  });
});

describe("local deployment signer roles", () => {
  it("requires the local manifest and passes it to Deploy.s.sol", async () => {
    const deployScript = await readFile(
      resolve(import.meta.dirname, "../../../ops/local/deploy.sh"),
      "utf8",
    );
    expect(deployScript).toContain('KEYS_FILE="$ROOT/deployments/local-keys.json"');
    expect(deployScript).toContain('"../deployments/local-keys.json"');
    expect(deployScript).toContain("arc-cast rpc eth_sendTransaction");
    expect(deployScript).toContain("manifest[role].address");
    expect(deployScript).toContain("tr '[:upper:]' '[:lower:]'");
    expect(deployScript).not.toContain("${ADDRESS,,}");
    expect(deployScript).not.toContain(".arc-local-addresses.");
  });
});

describe("create-keys dry run", () => {
  it("runs the real guards, prints seven addresses and writes nothing", async () => {
    const lines: string[] = [];
    const existed = existsSync(KEYS_FILE);
    const file = await createKeys({
      dryRun: true,
      argv: ["node", "create-keys.ts", "--dry-run"],
      env: {},
      out: (l) => lines.push(l),
    });
    expect(validateKeysFile(file)).toEqual([]);
    expect(lines[0]).toMatch(/^DRY RUN/);
    expect(lines).toHaveLength(8);
    expect(existsSync(KEYS_FILE)).toBe(existed);
    // Output holds addresses only: every token after the role is a 20-byte address.
    for (const line of lines.slice(1)) expect(line).toMatch(/0x[0-9a-fA-F]{40}$/);
    expect(lines.join("\n")).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it("creates a dry-run local manifest in Deploy.s.sol address/ref shape", async () => {
    const lines: string[] = [];
    const existed = existsSync(LOCAL_KEYS_FILE);
    const file = await createKeys({
      dryRun: true,
      local: true,
      argv: ["node", "create-keys.ts", "--dry-run", "--local"],
      env: {},
      out: (line) => lines.push(line),
    });
    expect(validateKeysFile(file, true)).toEqual([]);
    expect(file.network).toBe("arc-local");
    for (const { keyId } of PHASE1_KEYS) {
      const entry = file[keyId as keyof typeof file] as { address: string; ref: string };
      expect(entry.ref).toBe(keyId);
      expect(entry.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    const deploymentInput = JSON.parse(JSON.stringify(file)) as Record<
      string,
      { address?: string }
    >;
    for (const role of ["K3", "K5", "K6", "K7", "K20"])
      expect(deploymentInput[role]?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(lines[0]).toMatch(/^DRY RUN/);
    expect(existsSync(LOCAL_KEYS_FILE)).toBe(existed);
  });

  it("refuses a passphrase-like argument or variable before touching anything", async () => {
    await expect(
      createKeys({
        dryRun: true,
        argv: ["node", "s", "--passphrase", "x"],
        env: {},
        out: () => undefined,
      }),
    ).rejects.toMatchObject({ rule: "secret-in-argv" });
    await expect(
      createKeys({
        dryRun: true,
        argv: ["node", "s"],
        env: { CZAR_SIGNER_PASSPHRASE: "x" },
        out: () => undefined,
      }),
    ).rejects.toMatchObject({ rule: "secret-in-env" });
  });

  it("refuses a keystore path inside the repository", async () => {
    await expect(
      createKeys({
        dryRun: true,
        argv: ["node", "s"],
        env: { CZAR_SIGNER_KEYSTORE_PATH: process.cwd() },
        out: () => undefined,
      }),
    ).rejects.toMatchObject({ rule: "keystore-inside-git" });
  });
});
