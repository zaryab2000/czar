// PM-059: the merchants' cloud entry point (SCR-170 §3, §4). A cloud-shaped parameter file keeps the real
// Arc testnet RPC host, so the guard runs unchanged; the chain client is an injected stub, so no request
// leaves the process. The K10 addresses come over a real signer socket, from a fake signer, with the
// socket token read from files on both sides. The database is the local test Postgres.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "@czar/logging";
import { fileSignerIdentity, startSignerSocket } from "@czar/signer";
import type { Address } from "@czar/hashing";
import {
  CLOUD_CONFIG_POINTER,
  DATABASE_URL_POINTER,
  MERCHANT_PORT_POINTER,
  RPC_URL_POINTER,
  startCloudMerchant,
} from "../src/cloud-main.ts";
import { ALPHA_SERVICE_IDS } from "../src/alpha-services.ts";
import { EXTRACT_PATH } from "../src/extract/index.ts";
import { SEARCH_PATH } from "../src/search/index.ts";
import { SPOT_PATH } from "../src/spot/index.ts";

const ARC_TESTNET = 5042002;
const ARC_RPC_URL = "https://rpc.testnet.arc.io";
const TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:15432/postgres";
const ADDRESSES: Record<string, Address> = {
  "K10:czar-search": "0x00000000000000000000000000000000000000a1",
  "K10:czar-spot": "0x00000000000000000000000000000000000000a2",
  "K10:czar-extract": "0x00000000000000000000000000000000000000a3",
};
const cleanups: (() => Promise<void>)[] = [];
let admin: Pool;
let databaseName: string;
let databaseUrl: string;

beforeAll(async () => {
  admin = new Pool({ connectionString: TEST_DATABASE_URL });
  databaseName = `czar_t_${randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
});

afterAll(async () => {
  if (admin && databaseName) {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function stubChain(chainId = ARC_TESTNET) {
  return { getChainId: vi.fn(async () => chainId) };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
  const address = probe.address();
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  if (address === null || typeof address === "string") throw new Error("no free port");
  return address.port;
}

async function writeOwnerOnly(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o400 });
  await chmod(path, 0o400);
}

interface Fixture {
  readonly dir: string;
  readonly socketPath: string;
  readonly token: string;
  readonly env: Record<string, string>;
}

async function cloudFixture(
  overrides: Readonly<Record<string, string>> = {},
  options: {
    readonly rpcUrl?: string;
    readonly deploymentChainId?: number;
    readonly signerToken?: boolean;
    readonly databaseUrl?: string;
  } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "czar-mc-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const credentials = join(dir, "secrets");
  const merchantCredentials = join(credentials, "merchants");
  await mkdir(merchantCredentials, { recursive: true, mode: 0o700 });
  await writeOwnerOnly(join(merchantCredentials, "db-password"), "test-db-password-unused\n");
  const token = randomBytes(24).toString("hex");
  if (options.signerToken !== false)
    await writeOwnerOnly(join(merchantCredentials, "signer-token"), token);

  const deploymentPath = join(dir, "arc-testnet.json");
  await writeFile(
    deploymentPath,
    JSON.stringify({ chainId: options.deploymentChainId ?? ARC_TESTNET }),
  );
  const socketPath = join(dir, "run", "signer.sock");
  const parameters: Record<string, string> = {
    "deploy.environment": '"cloud-testnet"',
    "deploy.allowedRpcHosts": '["rpc.testnet.arc.io"]',
    "deploy.credentialFilesDir": JSON.stringify(credentials),
    "deploy.deploymentFile": JSON.stringify(deploymentPath),
    "app.origin": '"https://app.example.com"',
    "merchants.publicOrigin": '"https://merchants.example.com"',
    "merchants.lab.enabled": "false",
    "selection.paymentNetwork": '"eip155:5042002"',
    "signer.socketPath": JSON.stringify(socketPath),
    ...overrides,
  };
  const configPath = join(dir, "cloud.toml");
  await writeFile(
    configPath,
    Object.entries(parameters)
      .map(([key, value]) => `"${key}" = ${value}`)
      .join("\n"),
  );
  return {
    dir,
    socketPath,
    token,
    env: {
      [CLOUD_CONFIG_POINTER]: configPath,
      [RPC_URL_POINTER]: options.rpcUrl ?? ARC_RPC_URL,
      [DATABASE_URL_POINTER]: options.databaseUrl ?? databaseUrl,
      [MERCHANT_PORT_POINTER]: String(await freePort()),
    },
  };
}

/** A real signer socket in front of a fake signer; the expected token is read from a file. */
async function startFakeSignerSocket(fixture: Fixture) {
  const clientTokens = join(fixture.dir, "signer-side", "client-tokens");
  await mkdir(clientTokens, { recursive: true, mode: 0o700 });
  await writeOwnerOnly(join(clientTokens, "merchants"), fixture.token);
  const keyAddress = vi.fn(async (_caller: string, keyRef: string) => {
    const found = ADDRESSES[keyRef];
    if (found === undefined) throw new Error("unknown key");
    return found;
  });
  const stop = await startSignerSocket({
    socketPath: fixture.socketPath,
    signer: {
      keyAddress,
      sign: async () => {
        throw new Error("unexpected sign");
      },
      createPocketKey: async () => {
        throw new Error("unexpected pocket key");
      },
    } as never,
    audit: { write: async () => undefined } as never,
    identity: fileSignerIdentity(clientTokens, { services: ["merchants"] }),
    allowedCallers: { merchants: ["cz-20"] },
  });
  cleanups.push(stop);
  return { keyAddress };
}

const quietLogger = () =>
  createLogger({ service: "merchants", component: "CZ-20", sink: () => {} });

describe("merchants cloud entry point refuses an unsafe configuration (SCR-170 §3)", () => {
  const refusals: readonly [string, Record<string, string>, string][] = [
    ["deploy.environment = local", { "deploy.environment": '"local"' }, "deploy.environment"],
    ["an http app.origin", { "app.origin": '"http://localhost"' }, "app.origin"],
    [
      "an http merchants.publicOrigin",
      { "merchants.publicOrigin": '"http://127.0.0.1:8787"' },
      "merchants.publicOrigin",
    ],
    [
      "a local stand-in origin",
      { "fetch.localStandinOrigins": '["http://127.0.0.1:4010"]' },
      "fetch.localStandinOrigins",
    ],
    [
      "a payment network that is not the deployment's chain",
      { "selection.paymentNetwork": '"eip155:31337"' },
      "selection.paymentNetwork",
    ],
  ];

  it.each(refusals)("refuses %s before any RPC call", async (_label, overrides, key) => {
    const fixture = await cloudFixture(overrides);
    const chain = stubChain();
    await expect(
      startCloudMerchant({ env: fixture.env, argv: ["node"], logger: quietLogger(), chain }),
    ).rejects.toMatchObject({ key });
    expect(chain.getChainId).not.toHaveBeenCalled();
  });

  it("refuses an RPC pointer whose host is not allowlisted, without contacting it", async () => {
    const fixture = await cloudFixture({}, { rpcUrl: "https://rpc.testnet.arc.network" });
    const chain = stubChain();
    await expect(
      startCloudMerchant({ env: fixture.env, argv: ["node"], logger: quietLogger(), chain }),
    ).rejects.toMatchObject({ key: "deploy.allowedRpcHosts" });
    expect(chain.getChainId).not.toHaveBeenCalled();
  });

  it("refuses to start without an RPC pointer", async () => {
    const fixture = await cloudFixture();
    const env = { ...fixture.env };
    delete env[RPC_URL_POINTER];
    await expect(
      startCloudMerchant({ env, argv: ["node"], logger: quietLogger(), chain: stubChain() }),
    ).rejects.toThrow(/CZAR_ARC_RPC_URL is not set/);
  });

  it("refuses an RPC that reports a chain the deployment file does not name", async () => {
    const fixture = await cloudFixture();
    await expect(
      startCloudMerchant({
        env: fixture.env,
        argv: ["node"],
        logger: quietLogger(),
        chain: stubChain(31337),
      }),
    ).rejects.toThrow(/RPC reports chain 31337/);
  });

  it("refuses a deployment on any chain but Arc testnet, even when the RPC agrees", async () => {
    const fixture = await cloudFixture({}, { deploymentChainId: 31337 });
    await expect(
      startCloudMerchant({
        env: fixture.env,
        argv: ["node"],
        logger: quietLogger(),
        chain: stubChain(31337),
      }),
    ).rejects.toMatchObject({ key: "chainId" });
  });

  it("refuses a database URL that carries a password", async () => {
    const url = new URL(databaseUrl);
    url.password = "in-the-url";
    const fixture = await cloudFixture({}, { databaseUrl: url.toString() });
    await expect(
      startCloudMerchant({
        env: fixture.env,
        argv: ["node"],
        logger: quietLogger(),
        chain: stubChain(),
      }),
    ).rejects.toThrow(/CZAR_DATABASE_URL must not carry a password/);
  });

  it("refuses a secret-looking environment variable (D78)", async () => {
    const fixture = await cloudFixture();
    await expect(
      startCloudMerchant({
        env: { ...fixture.env, CZAR_SIGNER_SECRET: "x" },
        argv: ["node"],
        logger: quietLogger(),
        chain: stubChain(),
      }),
    ).rejects.toThrow(/looks like a secret/);
  });

  it("stops with merchant_signer_unavailable when its signer token file is missing", async () => {
    const fixture = await cloudFixture({}, { signerToken: false });
    await expect(
      startCloudMerchant({
        env: fixture.env,
        argv: ["node"],
        logger: quietLogger(),
        chain: stubChain(),
      }),
    ).rejects.toThrow(/merchant_signer_unavailable/);
  });
});

describe("merchants cloud entry point starts (SCR-170 §3)", () => {
  it("serves czar-search, czar-spot and czar-extract on 127.0.0.1, with K10 addresses from the socket", async () => {
    const fixture = await cloudFixture();
    const { keyAddress } = await startFakeSignerSocket(fixture);
    const running = await startCloudMerchant({
      env: fixture.env,
      argv: ["node"],
      logger: quietLogger(),
      chain: stubChain(),
    });
    cleanups.push(() => running.stop());
    expect(running.chainId).toBe(ARC_TESTNET);
    expect(running.runtime.routes).toEqual([SEARCH_PATH, SPOT_PATH, EXTRACT_PATH]);
    expect(keyAddress.mock.calls).toEqual(
      ALPHA_SERVICE_IDS.map((service) => ["cz-20", `K10:${service}`]),
    );
    const address = running.runtime.server.address();
    if (address === null || typeof address === "string") throw new Error("not listening");
    expect(address.address).toBe("127.0.0.1");
    expect(address.port).toBe(Number(fixture.env[MERCHANT_PORT_POINTER]));
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    // Each 402 names the public https origin and the service's own K10 payTo.
    const offer = await fetch(`http://127.0.0.1:${address.port}${SEARCH_PATH}?q=arc`);
    expect(offer.status).toBe(402);
    const entries = running.runtime.indexEntries({ lastUpdated: "2026-11-05T00:00:00Z" });
    expect(entries.map((entry) => entry["resource"])).toEqual([
      `https://merchants.example.com${SEARCH_PATH}`,
      `https://merchants.example.com${SPOT_PATH}`,
      `https://merchants.example.com${EXTRACT_PATH}`,
    ]);

    await running.stop();
    expect(running.runtime.server.listening).toBe(false);
  });
});
