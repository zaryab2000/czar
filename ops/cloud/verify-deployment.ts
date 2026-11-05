// PM-010: read-only check that every contract in the recorded testnet deployment runs the code
// this repository builds.
//
// Run from the repository root (ops/ is not a workspace package):
//
//   node --experimental-strip-types ops/cloud/verify-deployment.ts --rpc-url https://rpc.testnet.arc.io
//
// Options:
//   --rpc-url <url>          required; https, with a host in deploy.allowedRpcHosts
//   --config <toml>          parameter overlay (env/cloud.toml on the VM); registry defaults when omitted
//   --manifest <path>        default: deploy.deploymentFile (deployments/arc-testnet.json)
//   --contracts-root <path>  the Foundry project to build; default: this checkout's contracts/
//
// What it does, per contract (the eight vault logic libraries, OpenEvidenceLog, CzarVaultFactory):
//   1. builds the contracts with the reproducible `deploy` profile and the same `--libraries` link
//      flags as contracts/script/deploy.sh, taken from the manifest's library addresses;
//   2. reads the code at the recorded address with `eth_getCode` (the only RPC methods it can send
//      are eth_chainId and eth_getCode: no signing, no transaction, no funds);
//   3. compares it with the artifact's runtime code, with every `immutableReferences` range masked,
//      a library's self-address guard filled with the recorded address, and the CBOR metadata tail
//      stripped when the build has one (the `deploy` profile turns it off);
//   4. prints `match`, `mismatch` or `no-code`, and exits non-zero unless every contract matches.
//
// Uses the pinned Arc Foundry (scripts/install-arc-foundry.sh): `arc-forge` on PATH, or the
// ARC_FORGE pointer as in contracts/script/deploy.sh. Any other forge is refused.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ARC_TESTNET_CHAIN_ID,
  loadConfig,
  loadConfigFile,
  parameterEnvironment,
  type Config,
} from "../../packages/config/src/index.ts";

const run = promisify(execFile);

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const INSTALL_SCRIPT = join(REPO_ROOT, "scripts", "install-arc-foundry.sh");

/** The order of contracts/script/Deploy.s.sol, which is also the order this prints. */
export const LIBRARIES = [
  "CoreLogic",
  "EnvelopeLogic",
  "ReservationLogic",
  "SignatureLogic",
  "PocketLogic",
  "JobLogic",
  "AutonomyLogic",
  "OwnerActionLogic",
] as const;

export interface VerifiedContract {
  readonly name: string;
  /** Source path inside the Foundry project. */
  readonly source: string;
  readonly library: boolean;
}

export const VERIFIED_CONTRACTS: readonly VerifiedContract[] = [
  ...LIBRARIES.map((name) => ({ name, source: `src/vault/logic/${name}.sol`, library: true })),
  { name: "OpenEvidenceLog", source: "src/OpenEvidenceLog.sol", library: false },
  { name: "CzarVaultFactory", source: "src/CzarVaultFactory.sol", library: false },
];

export type Verdict = "match" | "mismatch" | "no-code";

export interface ContractResult {
  readonly name: string;
  readonly verdict: Verdict;
  /** Why it mismatched, in byte offsets and lengths only. */
  readonly detail?: string;
}

/** The fields of deployments/arc-testnet.json this check reads. */
export interface DeploymentManifest {
  readonly chainId: number;
  readonly addresses: Readonly<Record<string, `0x${string}`>>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const READ_ONLY_METHODS = ["eth_chainId", "eth_getCode"] as const;
type ReadOnlyMethod = (typeof READ_ONLY_METHODS)[number];
/** A library's runtime code opens with PUSH20 <its own address>, written at deployment. */
const LIBRARY_GUARD_PREFIX = `73${"00".repeat(20)}`;
const LIBRARY_GUARD_ADDRESS_START = 1;
const ADDRESS_BYTES = 20;
/** The CBOR metadata tail ends with its own length as two big-endian bytes. */
const CBOR_LENGTH_BYTES = 2;
const SOLC_CBOR_KEY = Buffer.from("solc").toString("hex");
const CBOR_MAP_FIRST = 0xa1;
const CBOR_MAP_LAST = 0xb7;
const LOOPBACK_TEST_HOST = "127.0.0.1";
/** arc-forge prints every compiled file; large enough for the whole project. */
const BUILD_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** Exit codes: every contract matched; at least one did not; the check could not run. */
export const EXIT_MATCH = 0;
export const EXIT_NOT_MATCHED = 1;
export const EXIT_REFUSED = 2;

/** Parses the manifest Deploy.s.sol writes. Refuses a missing or malformed address. */
export function parseManifest(text: string): DeploymentManifest {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const chainId = raw["chainId"];
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId))
    throw new Error("the deployment manifest has no valid chainId");
  const addresses: Record<string, `0x${string}`> = {};
  for (const { name } of VERIFIED_CONTRACTS) {
    const value = raw[name];
    if (typeof value !== "string" || !ADDRESS.test(value))
      throw new Error(`the deployment manifest has no valid ${name} address`);
    addresses[name] = value.toLowerCase() as `0x${string}`;
  }
  return { chainId, addresses };
}

/** The `--libraries` flags of deploy.sh pass 3, from the manifest's library addresses. */
export function libraryLinkFlags(manifest: DeploymentManifest): string[] {
  return LIBRARIES.flatMap((name) => [
    "--libraries",
    `src/vault/logic/${name}.sol:${name}:${manifest.addresses[name]}`,
  ]);
}

/** Refuses any forge but the pinned Arc Foundry release (A9-12, A9-13). */
export async function assertPinnedForge(forge: string): Promise<void> {
  const installer = await readFile(INSTALL_SCRIPT, "utf8");
  const expected = /EXPECTED_COMMIT="([0-9a-f]{40})"/.exec(installer)?.[1];
  if (expected === undefined) throw new Error("the pinned Arc Foundry commit was not found");
  const { stdout } = await run(forge, ["--version"]);
  const commit = /Commit SHA:\s*([0-9a-f]{40})/.exec(stdout)?.[1];
  if (commit !== expected)
    throw new Error("refusing to build: the forge binary is not the pinned Arc Foundry release");
}

/** Builds `contractsRoot` with the `deploy` profile and the manifest's link flags into `outDir`. */
export async function buildDeployArtifacts(options: {
  readonly forge: string;
  readonly contractsRoot: string;
  readonly outDir: string;
  readonly manifest: DeploymentManifest;
}): Promise<void> {
  await assertPinnedForge(options.forge);
  await run(
    options.forge,
    [
      "build",
      "--root",
      options.contractsRoot,
      "--out",
      options.outDir,
      "--cache-path",
      join(options.outDir, "cache"),
      ...libraryLinkFlags(options.manifest),
    ],
    {
      cwd: options.contractsRoot,
      env: { ...process.env, FOUNDRY_PROFILE: "deploy" },
      maxBuffer: BUILD_OUTPUT_MAX_BYTES,
    },
  );
}

interface RuntimeArtifact {
  readonly code: string;
  readonly immutables: readonly { readonly start: number; readonly length: number }[];
}

async function readArtifact(outDir: string, contract: VerifiedContract): Promise<RuntimeArtifact> {
  const file = contract.source.split("/").at(-1) as string;
  const json = JSON.parse(await readFile(join(outDir, file, `${contract.name}.json`), "utf8")) as {
    deployedBytecode?: {
      object?: string;
      immutableReferences?: Record<string, { start: number; length: number }[]>;
    };
  };
  const object = json.deployedBytecode?.object;
  if (typeof object !== "string" || !/^0x[0-9a-fA-F]*$/.test(object))
    throw new Error(`${contract.name}: the build has no linked runtime code`);
  return {
    code: object.slice(2).toLowerCase(),
    immutables: Object.values(json.deployedBytecode?.immutableReferences ?? {}).flat(),
  };
}

/** Length in bytes of a solc CBOR metadata tail at the end of `code`, or 0 when there is none. */
export function metadataTailLength(code: string): number {
  const bytes = code.length / 2;
  if (bytes < CBOR_LENGTH_BYTES) return 0;
  const cborLength = Number.parseInt(code.slice(-CBOR_LENGTH_BYTES * 2), 16);
  const tail = cborLength + CBOR_LENGTH_BYTES;
  if (cborLength === 0 || tail > bytes) return 0;
  const cbor = code.slice(code.length - tail * 2, code.length - CBOR_LENGTH_BYTES * 2);
  const first = Number.parseInt(cbor.slice(0, 2), 16);
  if (first < CBOR_MAP_FIRST || first > CBOR_MAP_LAST || !cbor.includes(SOLC_CBOR_KEY)) return 0;
  return tail;
}

function mask(code: string, ranges: RuntimeArtifact["immutables"]): string {
  let out = code;
  for (const { start, length } of ranges)
    out = out.slice(0, start * 2) + "00".repeat(length) + out.slice((start + length) * 2);
  return out;
}

/** Compares on-chain runtime code with a build artifact. `onChain` is hex without 0x. */
export function compareRuntimeCode(options: {
  readonly artifact: RuntimeArtifact;
  readonly onChain: string;
  readonly address: string;
  readonly library: boolean;
}): Omit<ContractResult, "name"> {
  const onChain = options.onChain.toLowerCase();
  if (onChain === "") return { verdict: "no-code" };
  let expected = options.artifact.code;
  if (options.library) {
    if (!expected.startsWith(LIBRARY_GUARD_PREFIX))
      return { verdict: "mismatch", detail: "the built library has no self-address guard" };
    const guardStart = LIBRARY_GUARD_ADDRESS_START * 2;
    expected =
      expected.slice(0, guardStart) +
      options.address.slice(2).toLowerCase() +
      expected.slice(guardStart + ADDRESS_BYTES * 2);
  }
  const tail = metadataTailLength(expected);
  if (onChain.length !== expected.length)
    return {
      verdict: "mismatch",
      detail: `on-chain ${onChain.length / 2} bytes, build ${expected.length / 2} bytes`,
    };
  const left = mask(onChain, options.artifact.immutables).slice(0, onChain.length - tail * 2);
  const right = mask(expected, options.artifact.immutables).slice(0, expected.length - tail * 2);
  if (left === right) return { verdict: "match" };
  let index = 0;
  while (left[index] === right[index]) index += 1;
  return { verdict: "mismatch", detail: `first difference at byte ${Math.floor(index / 2)}` };
}

/**
 * Refuses an RPC URL whose host is not in deploy.allowedRpcHosts, or that is not https.
 * `testOnlyLoopbackRpc` is for ops/cloud/test only: it accepts http://127.0.0.1 in place of the
 * allowlist, so the tests can point at a local arc-anvil. The command line never sets it.
 */
export function assertRpcAllowed(
  rpcUrl: string,
  allowedRpcHosts: readonly string[],
  testOnlyLoopbackRpc = false,
): void {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new Error("refusing to run: the RPC URL is not a URL");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    throw new Error("refusing to run: the RPC URL carries credentials, a query or a fragment");
  if (testOnlyLoopbackRpc && url.protocol === "http:" && url.hostname === LOOPBACK_TEST_HOST)
    return;
  if (url.protocol !== "https:" || !allowedRpcHosts.includes(url.hostname))
    throw new Error(
      "refusing to run: the RPC URL must be https with a host in deploy.allowedRpcHosts",
    );
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

async function rpc(
  fetchImpl: Fetch,
  rpcUrl: string,
  method: ReadOnlyMethod,
  params: readonly unknown[],
): Promise<string> {
  if (!READ_ONLY_METHODS.includes(method)) throw new Error("only read-only RPC methods are sent");
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: unknown } };
  if (typeof body.result !== "string") throw new Error(`${method} returned no result`);
  return body.result;
}

/** Reads every recorded address and compares it with the artifacts in `artifactsDir`. */
export async function verifyDeployment(options: {
  readonly manifest: DeploymentManifest;
  readonly artifactsDir: string;
  readonly rpcUrl: string;
  readonly allowedRpcHosts: readonly string[];
  readonly testOnlyLoopbackRpc?: boolean;
  readonly fetch?: Fetch;
}): Promise<ContractResult[]> {
  assertRpcAllowed(options.rpcUrl, options.allowedRpcHosts, options.testOnlyLoopbackRpc ?? false);
  const fetchImpl = options.fetch ?? fetch;
  if (options.manifest.chainId !== ARC_TESTNET_CHAIN_ID)
    throw new Error(
      `refusing to run: the manifest chain id is not Arc testnet ${ARC_TESTNET_CHAIN_ID}`,
    );
  const rpcChainId = Number.parseInt(await rpc(fetchImpl, options.rpcUrl, "eth_chainId", []), 16);
  if (rpcChainId !== options.manifest.chainId)
    throw new Error(
      `refusing to run: the RPC reports chain ${rpcChainId}, the manifest ${options.manifest.chainId}`,
    );
  const results: ContractResult[] = [];
  for (const contract of VERIFIED_CONTRACTS) {
    const address = options.manifest.addresses[contract.name] as string;
    const artifact = await readArtifact(options.artifactsDir, contract);
    const code = await rpc(fetchImpl, options.rpcUrl, "eth_getCode", [address, "latest"]);
    if (!/^0x[0-9a-fA-F]*$/.test(code)) throw new Error("eth_getCode returned non-hex code");
    results.push({
      name: contract.name,
      ...compareRuntimeCode({
        artifact,
        onChain: code.slice(2),
        address,
        library: contract.library,
      }),
    });
  }
  return results;
}

/** 0 only when every contract matched; `no-code` counts as not matched. */
export function exitCodeFor(results: readonly ContractResult[]): number {
  return results.length > 0 && results.every((result) => result.verdict === "match")
    ? EXIT_MATCH
    : EXIT_NOT_MATCHED;
}

/** One line per contract: `<name> <verdict>`, then the reason for a mismatch. */
export function formatResults(results: readonly ContractResult[]): string {
  const width = Math.max(...results.map((result) => result.name.length));
  return results
    .map(
      (result) =>
        `${result.name.padEnd(width)}  ${result.verdict}` +
        (result.detail === undefined ? "" : `  (${result.detail})`),
    )
    .join("\n");
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const known = ["--rpc-url", "--config", "--manifest", "--contracts-root"];
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] as string;
    const value = argv[index + 1];
    if (!known.includes(flag) || value === undefined)
      throw new Error(`unknown or incomplete option ${flag}`);
    args.set(flag, value);
  }
  return args;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const rpcUrl = args.get("--rpc-url");
  if (rpcUrl === undefined) throw new Error("--rpc-url is required");
  const configPath = args.get("--config");
  const env = { env: parameterEnvironment(process.env) };
  const config: Config =
    configPath === undefined ? loadConfig(env) : await loadConfigFile(configPath, env);
  const allowedRpcHosts = config.get("deploy.allowedRpcHosts");
  if (!Array.isArray(allowedRpcHosts)) throw new Error("deploy.allowedRpcHosts must be a list");
  // Checked before the build, so a refused host costs nothing and is never contacted.
  assertRpcAllowed(rpcUrl, allowedRpcHosts as string[]);
  const manifestPath = resolve(
    args.get("--manifest") ?? String(config.get("deploy.deploymentFile")),
  );
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));
  const contractsRoot = resolve(args.get("--contracts-root") ?? join(REPO_ROOT, "contracts"));
  const outDir = await mkdtemp(join(tmpdir(), "czar-verify-deployment-"));
  try {
    await buildDeployArtifacts({
      forge: process.env["ARC_FORGE"] ?? "arc-forge",
      contractsRoot,
      outDir,
      manifest,
    });
    const results = await verifyDeployment({
      manifest,
      artifactsDir: outDir,
      rpcUrl,
      allowedRpcHosts: allowedRpcHosts as string[],
    });
    process.stdout.write(`${formatResults(results)}\n`);
    const matched = results.filter((result) => result.verdict === "match").length;
    process.stdout.write(`${matched} of ${results.length} contracts match\n`);
    return exitCodeFor(results);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `verify-deployment: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = EXIT_REFUSED;
    },
  );
}
