// PM-010: the testnet deployment record and its bytecode verifier.
// Run from the repository root with the pinned Arc Foundry (scripts/install-arc-foundry.sh) on PATH,
// or ARC_ANVIL / ARC_FORGE pointing at it:
//
//   node --test --experimental-strip-types ops/cloud/test/verify-deployment.test.ts
//
// The chain tests deploy with contracts/script/deploy.sh to a local `arc-anvil --network arc`
// (never standard anvil), then run the verifier against it through the test-only loopback
// override. Nothing here contacts Arc testnet.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
// oxlint-disable-next-line no-restricted-imports -- ops/ is not a workspace package, so the module under test has no @czar/ name
import {
  assertRpcAllowed,
  buildDeployArtifacts,
  EXIT_MATCH,
  EXIT_NOT_MATCHED,
  exitCodeFor,
  formatResults,
  metadataTailLength,
  parseManifest,
  REPO_ROOT,
  VERIFIED_CONTRACTS,
  verifyDeployment,
  type ContractResult,
  type DeploymentManifest,
} from "../verify-deployment.ts";

const run = promisify(execFile);
const ARC_ANVIL = process.env["ARC_ANVIL"] ?? "arc-anvil";
const ARC_FORGE = process.env["ARC_FORGE"] ?? "arc-forge";
const CONTRACTS = join(REPO_ROOT, "contracts");
const DEPLOYMENTS = join(REPO_ROOT, "deployments");
const VERIFIER = fileURLToPath(new URL("../verify-deployment.ts", import.meta.url));
const ARC_TESTNET_CHAIN_ID = 5042002;
const PORT = 18_700 + (process.pid % 200);
const RPC_URL = `http://127.0.0.1:${PORT}`;
const CHAIN_TIMEOUT_MS = 15 * 60 * 1000;
const RPC_READY_ATTEMPTS = 100;
const POLL_MS = 100;
const DEPLOY_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** An address with no code on a fresh arc-anvil. */
const EMPTY_ADDRESS = "0x000000000000000000000000000000000000dEaD";
/** Every field Deploy.s.sol serialises (contracts/script/Deploy.s.sol:98-130). */
const MANIFEST_FIELDS = [
  "AutonomyLogic",
  "CoreLogic",
  "CzarVaultFactory",
  "EnvelopeLogic",
  "JobLogic",
  "OpenEvidenceLog",
  "OwnerActionLogic",
  "PocketLogic",
  "ReservationLogic",
  "SignatureLogic",
  "chainId",
  "factoryConstructorArgs",
  "factoryInitcodeHash",
  "factoryRuntimeHash",
  "gatewayDomain",
  "gatewayMinter",
  "gatewayWallet",
  "jobEscrow",
  "usdc",
  "vaultCreationCodeHash",
];

/** One role entry of the keys file Deploy.s.sol reads: an address and its reference, no key. */
function role(address: string, ref: string): { address: string; ref: string } {
  return { address, ref };
}

function verdicts(results: readonly ContractResult[]): Record<string, string> {
  return Object.fromEntries(results.map((result) => [result.name, result.verdict]));
}

function allExcept(name: string, verdict: string): Record<string, string> {
  return Object.fromEntries(
    VERIFIED_CONTRACTS.map((contract) => [
      contract.name,
      contract.name === name ? verdict : "match",
    ]),
  );
}

describe("the committed testnet record", () => {
  test("deployments/arc-testnet.json is exactly the Deploy.s.sol shape, on Arc testnet", async () => {
    const text = await readFile(join(DEPLOYMENTS, "arc-testnet.json"), "utf8");
    const raw = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw), MANIFEST_FIELDS);
    assert.equal(raw["chainId"], ARC_TESTNET_CHAIN_ID);
    assert.equal(raw["gatewayDomain"], 26);
    for (const field of ["usdc", "gatewayWallet", "gatewayMinter", "jobEscrow"])
      assert.match(String(raw[field]), /^0x[0-9a-fA-F]{40}$/);
    for (const field of ["factoryInitcodeHash", "factoryRuntimeHash", "vaultCreationCodeHash"])
      assert.match(String(raw[field]), /^0x[0-9a-f]{64}$/);
    const manifest = parseManifest(text);
    assert.equal(new Set(Object.values(manifest.addresses)).size, VERIFIED_CONTRACTS.length);
  });

  test("deployments/arc-testnet.meta.json records the source and commit, and no wallet address", async () => {
    const meta = JSON.parse(
      await readFile(join(DEPLOYMENTS, "arc-testnet.meta.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(meta["source"], "broadcast run-latest.json");
    assert.match(String(meta["deployCommit"]), /^[0-9a-f]{7,40}$/);
    assert.ok(!Number.isNaN(Date.parse(String(meta["deployedAt"]))));
    assert.ok(!("deployedBy" in meta));
    assert.doesNotMatch(JSON.stringify(meta), /0x[0-9a-fA-F]{40}/);
  });
});

describe("pure checks", () => {
  test("the RPC host must be https and in deploy.allowedRpcHosts", () => {
    const allowed = ["rpc.testnet.arc.io"];
    assertRpcAllowed("https://rpc.testnet.arc.io", allowed);
    for (const url of [
      "http://rpc.testnet.arc.io",
      "https://rpc.testnet.arc.network",
      "https://user:pw@rpc.testnet.arc.io",
      "https://rpc.testnet.arc.io/?key=1",
      RPC_URL,
      "not a url",
    ])
      assert.throws(() => assertRpcAllowed(url, allowed), /refusing to run/);
    // The override admits loopback http only, nothing else.
    assertRpcAllowed(RPC_URL, allowed, true);
    assert.throws(() => assertRpcAllowed("http://10.0.0.1:8545", allowed, true), /refusing/);
  });

  test("a refused host is never contacted", async () => {
    let calls = 0;
    const manifest = parseManifest(await readFile(join(DEPLOYMENTS, "arc-testnet.json"), "utf8"));
    await assert.rejects(
      verifyDeployment({
        manifest,
        artifactsDir: "/nonexistent",
        rpcUrl: "https://example.com",
        allowedRpcHosts: ["rpc.testnet.arc.io"],
        fetch: async () => {
          calls += 1;
          throw new Error("contacted");
        },
      }),
      /refusing to run/,
    );
    assert.equal(calls, 0);
  });

  test("the command line has no loopback override and no default RPC", () => {
    for (const args of [["--rpc-url", RPC_URL], []]) {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", VERIFIER, ...args],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /refusing to run|--rpc-url is required/);
    }
  });

  test("only a solc CBOR tail is stripped", () => {
    // a2 64 "ipfs" 58 22 <34 bytes> 64 "solc" 43 <3 bytes> 0033: the default solc tail.
    const cbor = `a264697066735822${"11".repeat(34)}64736f6c6343${"000817"}`;
    const tail = `${cbor}${(cbor.length / 2).toString(16).padStart(4, "0")}`;
    assert.equal(metadataTailLength(`6080604052${tail}`), cbor.length / 2 + 2);
    assert.equal(metadataTailLength("60806040525050505056"), 0);
  });

  test("any verdict but match exits non-zero", () => {
    const match: ContractResult = { name: "A", verdict: "match" };
    assert.equal(exitCodeFor([match, match]), EXIT_MATCH);
    assert.equal(exitCodeFor([match, { name: "B", verdict: "mismatch" }]), EXIT_NOT_MATCHED);
    assert.equal(exitCodeFor([match, { name: "B", verdict: "no-code" }]), EXIT_NOT_MATCHED);
    assert.equal(exitCodeFor([]), EXIT_NOT_MATCHED);
  });
});

describe("against a local pinned arc-anvil deploy", { timeout: CHAIN_TIMEOUT_MS }, () => {
  const tag = randomBytes(6).toString("hex");
  // Addresses only (Anvil's public accounts 1–5); the deploy script reads no key.
  const keysFile = join(DEPLOYMENTS, `.pm-010-test-${tag}-keys.json`);
  const manifestFile = join(DEPLOYMENTS, `.pm-010-test-${tag}.json`);
  const scratch: string[] = [];
  let anvil: ChildProcess | undefined;
  let manifest: DeploymentManifest;
  let artifacts: string;

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    scratch.push(dir);
    return dir;
  }

  before(async () => {
    anvil = spawn(
      ARC_ANVIL,
      ["--network", "arc", "--chain-id", String(ARC_TESTNET_CHAIN_ID), "--port", String(PORT)],
      { stdio: "ignore" },
    );
    let accounts: string[] = [];
    for (let attempt = 0; attempt < RPC_READY_ATTEMPTS && accounts.length === 0; attempt += 1) {
      if (anvil.exitCode !== null) throw new Error(`arc-anvil exited with ${anvil.exitCode}`);
      try {
        const response = await fetch(RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] }),
        });
        accounts = ((await response.json()) as { result: string[] }).result;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    }
    const [sender, k3, k5, k6, k7, k20] = accounts;
    if (sender === undefined || k20 === undefined) throw new Error("arc-anvil did not start");
    await writeFile(
      keysFile,
      JSON.stringify({
        network: "pm-010-test",
        chainId: ARC_TESTNET_CHAIN_ID,
        K3: role(k3 as string, "K3"),
        K5: role(k5 as string, "K5"),
        K6: role(k6 as string, "K6"),
        K7: role(k7 as string, "K7"),
        K20: role(k20, "K20"),
      }),
    );
    // The local chain reuses the testnet chain id, so Foundry's broadcast record goes to a scratch
    // folder: on the machine that deployed, contracts/broadcast/Deploy.s.sol/5042002/run-latest.json
    // is the real testnet record and must never be overwritten by a test.
    const broadcast = await tempDir("pm-010-broadcast-");
    await run(
      join(CONTRACTS, "script", "deploy.sh"),
      [RPC_URL, keysFile, manifestFile, "--broadcast", "--unlocked", "--sender", sender],
      {
        cwd: CONTRACTS,
        env: { ...process.env, ARC_FORGE, FOUNDRY_BROADCAST: broadcast },
        maxBuffer: DEPLOY_OUTPUT_MAX_BYTES,
      },
    );
    manifest = parseManifest(await readFile(manifestFile, "utf8"));
    artifacts = await tempDir("pm-010-build-");
    await buildDeployArtifacts({
      forge: ARC_FORGE,
      contractsRoot: CONTRACTS,
      outDir: artifacts,
      manifest,
    });
  });

  after(async () => {
    anvil?.kill("SIGTERM");
    await rm(keysFile, { force: true });
    await rm(manifestFile, { force: true });
    for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  });

  test("today's build matches every deployed contract", async () => {
    const results = await verifyDeployment({
      manifest,
      artifactsDir: artifacts,
      rpcUrl: RPC_URL,
      allowedRpcHosts: [],
      testOnlyLoopbackRpc: true,
    });
    assert.deepEqual(verdicts(results), allExcept("", "match"), formatResults(results));
    assert.equal(exitCodeFor(results), EXIT_MATCH);
  });

  test("a build with one contract changed mismatches that contract only", async () => {
    // A fixture copy of the Foundry project with one added function in OpenEvidenceLog.
    const root = await tempDir("pm-010-modified-");
    await cp(join(CONTRACTS, "src"), join(root, "src"), { recursive: true });
    await cp(join(CONTRACTS, "foundry.toml"), join(root, "foundry.toml"));
    await symlink(join(CONTRACTS, "lib"), join(root, "lib"));
    const source = join(root, "src", "OpenEvidenceLog.sol");
    const original = await readFile(source, "utf8");
    const anchor = "contract OpenEvidenceLog is IOpenEvidenceLog {";
    assert.ok(original.includes(anchor));
    await writeFile(
      source,
      original.replace(
        anchor,
        `${anchor}\n    function pm010Fixture() external pure returns (uint256) {\n        return 1;\n    }\n`,
      ),
    );
    const out = await tempDir("pm-010-modified-build-");
    await buildDeployArtifacts({ forge: ARC_FORGE, contractsRoot: root, outDir: out, manifest });
    const results = await verifyDeployment({
      manifest,
      artifactsDir: out,
      rpcUrl: RPC_URL,
      allowedRpcHosts: [],
      testOnlyLoopbackRpc: true,
    });
    assert.deepEqual(
      verdicts(results),
      allExcept("OpenEvidenceLog", "mismatch"),
      formatResults(results),
    );
    assert.equal(exitCodeFor(results), EXIT_NOT_MATCHED);
  });

  test("a wrong address reports no-code", async () => {
    const wrong: DeploymentManifest = {
      ...manifest,
      addresses: {
        ...manifest.addresses,
        CzarVaultFactory: EMPTY_ADDRESS.toLowerCase() as `0x${string}`,
      },
    };
    const results = await verifyDeployment({
      manifest: wrong,
      artifactsDir: artifacts,
      rpcUrl: RPC_URL,
      allowedRpcHosts: [],
      testOnlyLoopbackRpc: true,
    });
    assert.deepEqual(
      verdicts(results),
      allExcept("CzarVaultFactory", "no-code"),
      formatResults(results),
    );
    assert.equal(exitCodeFor(results), EXIT_NOT_MATCHED);
  });

  test("a manifest naming another library's address mismatches", async () => {
    // Code exists at the named address, but it is not this library's code.
    const swapped: DeploymentManifest = {
      ...manifest,
      addresses: {
        ...manifest.addresses,
        CoreLogic: manifest.addresses["EnvelopeLogic"] as `0x${string}`,
      },
    };
    const results = await verifyDeployment({
      manifest: swapped,
      artifactsDir: artifacts,
      rpcUrl: RPC_URL,
      allowedRpcHosts: [],
      testOnlyLoopbackRpc: true,
    });
    assert.equal(verdicts(results)["CoreLogic"], "mismatch");
  });

  test("an RPC on another chain is refused", async () => {
    await assert.rejects(
      verifyDeployment({
        manifest: { ...manifest, chainId: 1 },
        artifactsDir: artifacts,
        rpcUrl: RPC_URL,
        allowedRpcHosts: [],
        testOnlyLoopbackRpc: true,
      }),
      /refusing to run/,
    );
  });
});
