// PM-059 / SCR-170 §3 (b): `register-external-events.ts` runs `validateCloudConfig(…, {role: "indexer"})`
// in place of `validateLocalOnlyConfig` only when the pointer `CZAR_CLOUD_CONFIG` is set. With it unset,
// `validateLocalOnlyConfig` runs exactly as today. Ponder's virtual modules are stubbed, so loading the
// file only runs its startup code and records its handler registrations; the RPC client is a stub, so
// nothing is contacted.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  getChainId: vi.fn(async () => 5042002),
  createPublicClient: vi.fn(),
  validateLocalOnlyConfig: vi.fn(),
  validateCloudConfig: vi.fn(),
}));

vi.mock("ponder:registry", () => ({ ponder: { on: mocks.on } }));
vi.mock("ponder:schema", () => ({
  anchors: {},
  authorizations: {},
  dependencyState: {},
  envelopes: {},
  externalEvents: {},
  escrowJobs: {},
  gatewayTransfers: {},
  alerts: {},
  haltFlags: {},
  pockets: {},
  pocketBalances: {},
  pullbacks: {},
  vaults: {},
}));
vi.mock("viem", async (importOriginal) => {
  const original = await importOriginal<typeof import("viem")>();
  mocks.createPublicClient.mockImplementation(() => ({ getChainId: mocks.getChainId }));
  return { ...original, createPublicClient: mocks.createPublicClient };
});
vi.mock("@czar/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@czar/config")>();
  mocks.validateLocalOnlyConfig.mockImplementation(original.validateLocalOnlyConfig);
  mocks.validateCloudConfig.mockImplementation(original.validateCloudConfig);
  return {
    ...original,
    validateLocalOnlyConfig: mocks.validateLocalOnlyConfig,
    validateCloudConfig: mocks.validateCloudConfig,
  };
});

const POINTERS = [
  "CZAR_CLOUD_CONFIG",
  "CZAR_LOCAL_CONFIG",
  "CZAR_INDEXER_RPC_URL",
  "CZAR_INDEXER_DEPLOYMENT_PATH",
] as const;
const saved: Partial<Record<(typeof POINTERS)[number], string | undefined>> = {};
const temporaryDirectories: string[] = [];

beforeEach(() => {
  vi.resetModules();
  for (const name of POINTERS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  mocks.on.mockClear();
  mocks.getChainId.mockClear();
  mocks.getChainId.mockImplementation(async () => 5042002);
  mocks.createPublicClient.mockClear();
  mocks.validateLocalOnlyConfig.mockClear();
  mocks.validateCloudConfig.mockClear();
});

afterEach(async () => {
  for (const name of POINTERS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function writeDeployment(chainId = 5042002): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "czar-indexer-events-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "deployment.json");
  await writeFile(
    path,
    JSON.stringify({
      chainId,
      gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
      usdc: "0x3600000000000000000000000000000000000000",
      gatewayDomain: 26,
    }),
  );
  return path;
}

async function writeCloudConfig(overrides: Readonly<Record<string, string>> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "czar-indexer-cloud-"));
  temporaryDirectories.push(directory);
  const credentials = join(directory, "secrets", "indexer");
  await mkdir(credentials, { recursive: true, mode: 0o700 });
  await writeFile(join(credentials, "db-password"), "unused\n", { mode: 0o400 });
  await chmod(join(credentials, "db-password"), 0o400);
  const parameters: Record<string, string> = {
    "deploy.environment": '"cloud-testnet"',
    "deploy.allowedRpcHosts": '["rpc.testnet.arc.io"]',
    "deploy.credentialFilesDir": JSON.stringify(join(directory, "secrets")),
    "app.origin": '"https://app.example.com"',
    "merchants.publicOrigin": '"https://merchants.example.com"',
    "merchants.lab.enabled": "false",
    "selection.paymentNetwork": '"eip155:5042002"',
    ...overrides,
  };
  const path = join(directory, "cloud.toml");
  await writeFile(
    path,
    Object.entries(parameters)
      .map(([key, value]) => `"${key}" = ${value}`)
      .join("\n"),
  );
  return path;
}

const loadEvents = () => import("../src/register-external-events.ts");

describe("register-external-events with CZAR_CLOUD_CONFIG set", () => {
  it("runs the cloud guard with an https app.origin, passes, and registers the handlers", async () => {
    process.env["CZAR_CLOUD_CONFIG"] = await writeCloudConfig();
    process.env["CZAR_INDEXER_DEPLOYMENT_PATH"] = await writeDeployment();
    await loadEvents();
    expect(mocks.validateLocalOnlyConfig).not.toHaveBeenCalled();
    // Once before any RPC call, once with the chain id the RPC reports.
    expect(mocks.validateCloudConfig).toHaveBeenCalledTimes(2);
    for (const [options] of mocks.validateCloudConfig.mock.calls)
      expect(options).toMatchObject({
        role: "indexer",
        chainId: 5042002,
        rpcUrls: ["https://rpc.testnet.arc.io"],
      });
    expect(mocks.validateCloudConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getChainId.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.getChainId).toHaveBeenCalledTimes(1);
    expect(mocks.on).toHaveBeenCalled();
  });

  it("refuses an http app.origin before any RPC call", async () => {
    process.env["CZAR_CLOUD_CONFIG"] = await writeCloudConfig({
      "app.origin": '"http://localhost"',
    });
    process.env["CZAR_INDEXER_DEPLOYMENT_PATH"] = await writeDeployment();
    await expect(loadEvents()).rejects.toMatchObject({ key: "app.origin" });
    expect(mocks.getChainId).not.toHaveBeenCalled();
    expect(mocks.on).not.toHaveBeenCalled();
  });

  it("refuses an RPC that reports a chain the deployment file does not name", async () => {
    process.env["CZAR_CLOUD_CONFIG"] = await writeCloudConfig();
    process.env["CZAR_INDEXER_DEPLOYMENT_PATH"] = await writeDeployment();
    mocks.getChainId.mockImplementation(async () => 31337);
    await expect(loadEvents()).rejects.toThrow(/RPC reports chain 31337/);
    expect(mocks.on).not.toHaveBeenCalled();
  });
});

describe("register-external-events with CZAR_CLOUD_CONFIG unset", () => {
  it("runs validateLocalOnlyConfig exactly as today and never the cloud guard", async () => {
    const localConfig = resolve(import.meta.dirname, "../../../env/local.toml");
    process.env["CZAR_LOCAL_CONFIG"] = localConfig;
    process.env["CZAR_INDEXER_RPC_URL"] = "http://127.0.0.1:8545";
    process.env["CZAR_INDEXER_DEPLOYMENT_PATH"] = await writeDeployment();
    // The real local guard asks the RPC for anvil_nodeInfo; no arc-anvil runs here, so this one call
    // answers as a pinned arc-anvil would, and the arguments it was given are what is checked.
    mocks.validateLocalOnlyConfig.mockResolvedValueOnce(undefined);
    await loadEvents();
    expect(mocks.validateCloudConfig).not.toHaveBeenCalled();
    expect(mocks.createPublicClient).not.toHaveBeenCalled();
    expect(mocks.validateLocalOnlyConfig).toHaveBeenCalledTimes(1);
    const [options] = mocks.validateLocalOnlyConfig.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(options).toSorted()).toEqual(["arcRpcUrl", "config", "overlayPath"]);
    expect(options["overlayPath"]).toBe(localConfig);
    expect(options["arcRpcUrl"]).toBe("http://127.0.0.1:8545");
    expect(mocks.on).toHaveBeenCalled();
  });

  it("with no local overlay either, passes an empty overlay path and the public RPC, as today", async () => {
    process.env["CZAR_INDEXER_DEPLOYMENT_PATH"] = await writeDeployment();
    // Today the local guard refuses this combination; the point is that it is the local guard that does.
    await loadEvents().catch(() => undefined);
    expect(mocks.validateCloudConfig).not.toHaveBeenCalled();
    expect(mocks.validateLocalOnlyConfig).toHaveBeenCalledTimes(1);
    const [options] = mocks.validateLocalOnlyConfig.mock.calls[0] as [Record<string, unknown>];
    expect(options["overlayPath"]).toBe("");
    expect(options["arcRpcUrl"]).toBe("https://rpc.testnet.arc.io");
  });
});
