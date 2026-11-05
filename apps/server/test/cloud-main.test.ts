// PM-059: the server's cloud entry point (SCR-170 §3, §4, §6). A cloud-shaped parameter file keeps the
// real Arc testnet RPC host, so the guard runs unchanged; the RPC client is an injected stub, so no
// request leaves the process. The database is the local test Postgres, reached through the same
// `pg.Pool` the cloud builds, with its password function reading a file. No real model is called: the
// one model test answers from an injected `fetch`.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@czar/logging";
import { setupDatabaseConnection } from "#test/db";
import { computePromptHash } from "#src/models/proxy";
import {
  CLOUD_CONFIG_POINTER,
  DATABASE_URL_POINTER,
  RPC_URL_POINTER,
  SERVER_PORT_POINTER,
  cloudDatabasePool,
  startCloudServer,
  type CloudServerOptions,
} from "#src/cloud-main";

const ARC_TESTNET = 5042002;
const ARC_RPC_URL = "https://rpc.testnet.arc.io";
const database = setupDatabaseConnection();
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const hexAddress = (byte: string) => `0x${byte.repeat(40)}`;

/** A stub Arc client: every read answers locally, and nothing is ever broadcast. */
function stubChain(chainId = ARC_TESTNET) {
  const getChainId = vi.fn(async () => chainId);
  const publicClient = {
    getChainId,
    getBlockNumber: vi.fn(async () => 0n),
    getContractEvents: vi.fn(async () => []),
    getGasPrice: vi.fn(async () => 1n),
    readContract: vi.fn(async () => false),
    watchContractEvent: vi.fn(() => vi.fn()),
  };
  const walletClient = {
    sendRawTransaction: vi.fn(async () => {
      throw new Error("unexpected transaction broadcast");
    }),
  };
  return {
    getChainId,
    options: {
      publicClient: publicClient as unknown as NonNullable<CloudServerOptions["publicClient"]>,
      walletClient: walletClient as unknown as NonNullable<CloudServerOptions["walletClient"]>,
    },
  };
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
  readonly credentials: string;
  readonly env: Record<string, string>;
}

async function cloudFixture(
  overrides: Readonly<Record<string, string>> = {},
  options: {
    readonly rpcUrl?: string;
    readonly deploymentChainId?: number;
    readonly signerToken?: boolean;
    readonly databaseUrl?: string;
    readonly port?: number;
  } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "czar-server-cloud-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const credentials = join(dir, "secrets");
  const serverCredentials = join(credentials, "server");
  await mkdir(serverCredentials, { recursive: true, mode: 0o700 });
  await writeOwnerOnly(join(serverCredentials, "db-password"), "test-db-password-unused\n");
  if (options.signerToken !== false)
    await writeOwnerOnly(join(serverCredentials, "signer-token"), randomBytes(24).toString("hex"));
  await writeOwnerOnly(join(serverCredentials, "anthropic-api-key"), "fake-model-key-for-tests\n");

  const deploymentPath = join(dir, "arc-testnet.json");
  await writeFile(
    deploymentPath,
    JSON.stringify({
      chainId: options.deploymentChainId ?? ARC_TESTNET,
      CzarVaultFactory: hexAddress("1"),
      gatewayMinter: hexAddress("5"),
      gatewayDomain: 26,
    }),
  );
  const parameters: Record<string, string> = {
    "deploy.environment": '"cloud-testnet"',
    "deploy.allowedRpcHosts": '["rpc.testnet.arc.io"]',
    "deploy.credentialFilesDir": JSON.stringify(credentials),
    "deploy.deploymentFile": JSON.stringify(deploymentPath),
    "deploy.objectStorePath": JSON.stringify(join(dir, "objects")),
    "deploy.indexerUrl": '"http://127.0.0.1:42069"',
    "app.origin": '"https://app.example.com"',
    "app.arcRpcUrl": JSON.stringify(ARC_RPC_URL),
    "app.circleClientUrl": '"https://modular-sdk.example.com"',
    "app.circleClientKey": '"public-client-key"',
    "merchants.publicOrigin": '"https://merchants.example.com"',
    "merchants.lab.enabled": "false",
    "selection.paymentNetwork": '"eip155:5042002"',
    "signer.socketPath": JSON.stringify(join(dir, "run", "signer.sock")),
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
    credentials,
    env: {
      [CLOUD_CONFIG_POINTER]: configPath,
      [RPC_URL_POINTER]: options.rpcUrl ?? ARC_RPC_URL,
      [DATABASE_URL_POINTER]: options.databaseUrl ?? database.getUrl(),
      [SERVER_PORT_POINTER]: String(options.port ?? (await freePort())),
    },
  };
}

const quietLogger = () => createLogger({ service: "server", component: "CZ-15", sink: () => {} });

async function start(fixture: Fixture, extra: Partial<CloudServerOptions> = {}) {
  const chain = stubChain();
  const running = await startCloudServer({
    env: fixture.env,
    argv: ["node", "cloud-main.ts"],
    logger: quietLogger(),
    ...chain.options,
    ...extra,
  });
  cleanups.push(() => running.stop());
  return running;
}

describe("server cloud entry point refuses an unsafe configuration (SCR-170 §3)", () => {
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
    [
      "a loopback app.arcRpcUrl",
      { "app.arcRpcUrl": '"http://127.0.0.1:8549"' },
      "deploy.allowedRpcHosts",
    ],
  ];

  it.each(refusals)("refuses %s before any RPC call", async (_label, overrides, key) => {
    const fixture = await cloudFixture(overrides);
    const chain = stubChain();
    await expect(
      startCloudServer({
        env: fixture.env,
        argv: ["node", "cloud-main.ts"],
        logger: quietLogger(),
        ...chain.options,
      }),
    ).rejects.toMatchObject({ key });
    expect(chain.getChainId).not.toHaveBeenCalled();
  });

  it("refuses an RPC pointer whose host is not allowlisted, without contacting it", async () => {
    const fixture = await cloudFixture({}, { rpcUrl: "https://rpc.testnet.arc.network" });
    const chain = stubChain();
    await expect(
      startCloudServer({
        env: fixture.env,
        argv: ["node"],
        logger: quietLogger(),
        ...chain.options,
      }),
    ).rejects.toMatchObject({ key: "deploy.allowedRpcHosts" });
    expect(chain.getChainId).not.toHaveBeenCalled();
  });

  it("refuses an RPC that reports a chain the deployment file does not name", async () => {
    const fixture = await cloudFixture();
    const chain = stubChain(31337);
    await expect(
      startCloudServer({
        env: fixture.env,
        argv: ["node"],
        logger: quietLogger(),
        ...chain.options,
      }),
    ).rejects.toThrow(/RPC reports chain 31337/);
  });

  it("refuses a deployment on any chain but Arc testnet, even when the RPC agrees", async () => {
    const fixture = await cloudFixture({}, { deploymentChainId: 31337 });
    const chain = stubChain(31337);
    await expect(
      startCloudServer({
        env: fixture.env,
        argv: ["node"],
        logger: quietLogger(),
        ...chain.options,
      }),
    ).rejects.toMatchObject({ key: "chainId" });
  });

  it("refuses a database URL that carries a password", async () => {
    const url = new URL(database.getUrl());
    url.password = "in-the-url";
    const fixture = await cloudFixture({}, { databaseUrl: url.toString() });
    const chain = stubChain();
    await expect(
      startCloudServer({
        env: fixture.env,
        argv: ["node"],
        logger: quietLogger(),
        ...chain.options,
      }),
    ).rejects.toThrow(/CZAR_DATABASE_URL must not carry a password/);
  });

  it("refuses a secret-looking environment variable or argument (D78)", async () => {
    const fixture = await cloudFixture();
    const chain = stubChain();
    await expect(
      startCloudServer({
        env: { ...fixture.env, CZAR_ANTHROPIC_SECRET: "x" },
        argv: ["node"],
        logger: quietLogger(),
        ...chain.options,
      }),
    ).rejects.toThrow(/looks like a secret/);
    await expect(
      startCloudServer({
        env: fixture.env,
        argv: ["node", "cloud-main.ts", "--password=x"],
        logger: quietLogger(),
        ...chain.options,
      }),
    ).rejects.toThrow(/looks like a secret/);
  });

  it("refuses to start without its signer token file", async () => {
    const fixture = await cloudFixture({}, { signerToken: false });
    await expect(start(fixture)).rejects.toThrow(/signer token file unavailable for server/);
  });
});

describe("server cloud entry point starts (SCR-170 §3)", () => {
  it("starts on 127.0.0.1 and /health answers over HTTP", async () => {
    const fixture = await cloudFixture();
    const running = await start(fixture);
    expect(running.chainId).toBe(ARC_TESTNET);
    const address = running.server.address();
    if (address === null || typeof address === "string") throw new Error("not listening");
    expect(address.address).toBe("127.0.0.1");
    expect(address.port).toBe(Number(fixture.env[SERVER_PORT_POINTER]));
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    await running.stop();
    expect(running.server.listening).toBe(false);
  });

  it("with models.provider = none, no model client is constructed and no key file is read", async () => {
    const fixture = await cloudFixture({ "models.provider": '"none"' });
    const readSecretFile = vi.fn(async () => "unused");
    const running = await start(fixture, { readSecretFile });
    expect(running.modelClient).toBeUndefined();
    expect(readSecretFile).not.toHaveBeenCalled();
  });

  it("with models.provider = anthropic, the adapter is injected and reads its key file once", async () => {
    const fixture = await cloudFixture({ "models.provider": '"anthropic"' });
    const readSecretFile = vi.fn(async () => "fake-model-key-for-tests\n");
    const modelFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: '{"answer":"ok"}' }],
            usage: { input_tokens: 10, output_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const running = await start(fixture, { readSecretFile, modelFetch });
    expect(running.modelClient).toBeDefined();
    expect(readSecretFile).not.toHaveBeenCalled();
    const request = {
      prompt: "P-01" as const,
      promptHash: await computePromptHash("P-01"),
      input: { text: "data" },
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["answer"],
        properties: { answer: { type: "string" } },
      },
    };
    const callOptions = {
      maxTotalTokens: 4_000,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    };
    await running.modelClient?.complete(request, callOptions);
    await running.modelClient?.complete(request, callOptions);
    expect(modelFetch).toHaveBeenCalledTimes(2);
    expect(readSecretFile).toHaveBeenCalledTimes(1);
    expect(readSecretFile).toHaveBeenCalledWith(
      join(fixture.credentials, "server", "anthropic-api-key"),
    );
  });
});

describe("cloud database pool (SCR-170 §4)", () => {
  it("reads the password from the file, and the connection string carries none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "czar-server-pool-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const passwordFile = join(dir, "db-password");
    await writeOwnerOnly(passwordFile, "from-the-file\n");
    const pool = cloudDatabasePool("postgres://czar_api@127.0.0.1:5432/czar", passwordFile);
    cleanups.push(() => pool.end());
    const options = pool.options as { connectionString?: string; password?: unknown };
    expect(options.connectionString).toBe("postgres://czar_api@127.0.0.1:5432/czar");
    expect(typeof options.password).toBe("function");
    await expect((options.password as () => Promise<string>)()).resolves.toBe("from-the-file");
  });

  it("refuses a connection string with a password", () => {
    expect(() =>
      cloudDatabasePool("postgres://czar_api:pw@127.0.0.1:5432/czar", "/nowhere"),
    ).toThrow(/must not carry a password/);
  });
});
