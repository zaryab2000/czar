// T-105 tests: key creation stays in dry-run; local deployment runs against mocked commands.
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
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const LOCAL_UNLOCKED_ACCOUNT = "0x0000000000000000000000000000000000000999";
const localSample = () => ({
  network: "arc-local",
  chainId: 5042002,
  backend: "local-keystore",
  createdAt: "2026-10-19T00:00:00.000Z",
  ...Object.fromEntries(
    PHASE1_KEYS.map(({ keyId }, index) => [
      keyId,
      {
        address: getAddress(`0x${(index + 1).toString(16).padStart(40, "0")}`),
        ref: keyId,
      },
    ]),
  ),
});

async function localDeployFixture(manifest: unknown) {
  const root = await mkdtemp(join(tmpdir(), "czar-local-deploy-"));
  const bin = join(root, "bin");
  const log = join(root, "rpc-calls.jsonl");
  const forgeLog = join(root, "forge-args.txt");
  const script = join(root, "ops/local/deploy.sh");
  await mkdir(bin, { recursive: true });
  await mkdir(join(root, "ops/local"), { recursive: true });
  await mkdir(join(root, "deployments"), { recursive: true });
  await mkdir(join(root, "contracts/script"), { recursive: true });
  await copyFile(resolve(import.meta.dirname, "../../../ops/local/deploy.sh"), script);
  await copyFile(
    resolve(import.meta.dirname, "../../../ops/local/parse-local-keys.mjs"),
    join(root, "ops/local/parse-local-keys.mjs"),
  );
  await writeFile(join(root, "deployments/local-keys.json"), JSON.stringify(manifest));
  const arcCast = `#!/bin/sh
set -eu
if [ "$1" = chain-id ]; then [ "$3" = http://127.0.0.1:8545 ] || exit 1; printf '5042002'; exit 0; fi
if [ "$1" = rpc ] && [ "$2" = eth_accounts ]; then [ "$4" = http://127.0.0.1:8545 ] || exit 1; printf '["${LOCAL_UNLOCKED_ACCOUNT}"]'; exit 0; fi
if [ "$1" = rpc ] && [ "$2" = eth_sendTransaction ]; then [ "$5" = http://127.0.0.1:8545 ] || exit 1; printf '%s\\n' "$3" >> "$FUND_LOG"; exit 0; fi
if [ "$1" = code ]; then printf '0x'; exit 0; fi
exit 1
`;
  await writeFile(join(bin, "arc-cast"), arcCast);
  await writeFile(join(bin, "arc-forge"), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FORGE_LOG"\n');
  await writeFile(join(root, "contracts/script/deploy.sh"), '#!/bin/sh\narc-forge "$@"\n');
  await Promise.all([
    chmod(join(bin, "arc-cast"), 0o755),
    chmod(join(bin, "arc-forge"), 0o755),
    chmod(join(root, "contracts/script/deploy.sh"), 0o755),
  ]);
  return { root, log, forgeLog, script, bin };
}

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
  it("parses the T-105 local key/ref manifest and requires all seven entries", async () => {
    const parserPath = resolve(import.meta.dirname, "../../../ops/local/parse-local-keys.mjs");
    const { parseLocalKeysManifest } = await import(pathToFileURL(parserPath).href);
    const manifest = localSample();
    expect(parseLocalKeysManifest(manifest).relayer.ref).toBe("relayer");
    const withoutRelayer = Object.fromEntries(
      Object.entries(manifest).filter(([key]) => key !== "relayer"),
    );
    expect(() => parseLocalKeysManifest(withoutRelayer)).toThrow(
      /exactly the seven T-105 key entries/,
    );
    const placeholder = JSON.parse(
      await readFile(
        resolve(import.meta.dirname, "../../../deployments/local-keys.example.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(() => parseLocalKeysManifest(placeholder)).toThrow(/invalid K3 address\/ref/);
  });

  it("passes the new manifest to Deploy.s.sol and funds only the local relayer", async () => {
    const manifest = localSample();
    const fixture = await localDeployFixture(manifest);
    try {
      const parserResult = spawnSync(
        "node",
        [
          join(fixture.root, "ops/local/parse-local-keys.mjs"),
          "--cli",
          "deployments/local-keys.json",
          "relayer",
        ],
        { cwd: fixture.root, encoding: "utf8", env: { PATH: process.env["PATH"] } },
      );
      expect(parserResult.status).toBe(0);
      expect(parserResult.stdout).toHaveLength(42);
      const result = spawnSync("bash", [fixture.script], {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          PATH: `${fixture.bin}${process.env["PATH"] ? `:${process.env["PATH"]}` : ""}`,
          FUND_LOG: fixture.log,
          FORGE_LOG: fixture.forgeLog,
        },
      });
      expect(result.status).toBe(0);
      const funded = (await readFile(fixture.log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, string>);
      expect(funded).toEqual([
        {
          from: LOCAL_UNLOCKED_ACCOUNT,
          to: (manifest as unknown as { relayer: { address: string } }).relayer.address,
          value: "0xDE0B6B3A7640000",
        },
      ]);
      const forgeArgs = await readFile(fixture.forgeLog, "utf8");
      expect(forgeArgs).toContain("--unlocked");
      expect(forgeArgs).toContain("--sender");
      expect(forgeArgs).toContain(LOCAL_UNLOCKED_ACCOUNT);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses the local manifest and parser before deployment", async () => {
    const deployScript = await readFile(
      resolve(import.meta.dirname, "../../../ops/local/deploy.sh"),
      "utf8",
    );
    expect(deployScript).toContain('KEYS_FILE="$ROOT/deployments/local-keys.json"');
    expect(deployScript).toContain('"../deployments/local-keys.json"');
    expect(deployScript).toContain("arc-cast rpc eth_sendTransaction");
    expect(deployScript).toContain('parse-local-keys.mjs" --cli "$KEYS_FILE" relayer');
    expect(deployScript).not.toContain("for ROLE in K3 K5 K6 K7 K20");
    expect(deployScript).not.toContain(".arc-local-addresses.");
  });

  it("keeps the committed manifest as a non-address placeholder", async () => {
    const example = await readFile(
      resolve(import.meta.dirname, "../../../deployments/local-keys.example.json"),
      "utf8",
    );
    expect(example).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(example).toContain('"relayer"');
    expect(example).toContain('"ref": "K3"');
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
    expect((file as unknown as { relayer: { ref: string } }).relayer.ref).toBe("relayer");
    const parserPath = resolve(import.meta.dirname, "../../../ops/local/parse-local-keys.mjs");
    const { parseLocalKeysManifest } = await import(pathToFileURL(parserPath).href);
    expect(parseLocalKeysManifest(file).relayer.ref).toBe("relayer");
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
