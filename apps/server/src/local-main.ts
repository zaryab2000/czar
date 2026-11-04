import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadConfigFile, parameterEnvironment, validateLocalOnlyConfig } from "@czar/config";
import { createLogger, type Logger } from "@czar/logging";
import { createSignerClient } from "@czar/signer";
import { createSafeFetchFromConfig } from "@czar/x402";
import { Pool } from "pg";
import { createPublicClient, createWalletClient, http, isAddress, type Address } from "viem";
import { createFileObjectStore } from "#src/object-store";
import { createServerMain, type ServerMain, type ServerMainOptions } from "#src/main";
import {
  createIndexerOpeningLookup,
  type OpeningWatcherDependencies,
} from "#src/objectives/opening-watcher";
import { createViemVaultDirectChain } from "#src/payer/viem-chain";

const ARC_CHAIN_ID = 5042002;
const DEFAULT_SERVER_PORT = 3000;

interface LocalDeployment {
  readonly chainId: number;
  readonly CzarVaultFactory: Address;
  readonly gatewayMinter: Address;
  readonly gatewayDomain: number;
}

export type LocalServerMainOptions = Omit<
  ServerMainOptions,
  "appReadOptions" | "chainForVault" | "planner"
> & {
  readonly rpcUrl: string;
  readonly factoryAddress: Address;
  readonly indexerUrl: string;
  readonly openingLookup?: OpeningWatcherDependencies["lookup"];
};

export interface LocalLauncherPointers {
  readonly configPath?: string;
  readonly databaseUrl?: string;
  readonly rpcUrl?: string;
  readonly serverPort?: string;
  readonly objectStorePath?: string;
  readonly indexerUrl?: string;
}

export function readLocalLauncherPointers(environment: NodeJS.ProcessEnv): LocalLauncherPointers {
  return {
    ...(environment["CZAR_LOCAL_CONFIG"] ? { configPath: environment["CZAR_LOCAL_CONFIG"] } : {}),
    ...(environment["CZAR_DATABASE_URL"] ? { databaseUrl: environment["CZAR_DATABASE_URL"] } : {}),
    ...(environment["CZAR_ARC_RPC_URL"] ? { rpcUrl: environment["CZAR_ARC_RPC_URL"] } : {}),
    ...(environment["CZAR_SERVER_PORT"] ? { serverPort: environment["CZAR_SERVER_PORT"] } : {}),
    ...(environment["CZAR_LOCAL_OBJECT_STORE_PATH"]
      ? { objectStorePath: environment["CZAR_LOCAL_OBJECT_STORE_PATH"] }
      : {}),
    ...(environment["CZAR_INDEXER_URL"] ? { indexerUrl: environment["CZAR_INDEXER_URL"] } : {}),
  };
}

export async function createLocalServerMain(options: LocalServerMainOptions): Promise<ServerMain> {
  const { rpcUrl, factoryAddress, indexerUrl, openingLookup, ...serverOptions } = options;
  return createServerMain({
    ...serverOptions,
    appReadOptions: {
      rpcUrl,
      factoryAddress,
      indexerUrl,
    },
    chainForVault: (vault) =>
      createViemVaultDirectChain({
        client: options.publicClient,
        vault,
        usdc: options.config.get("chain.usdcAddress") as Address,
      }),
    planner: {
      openingLookup:
        openingLookup ??
        createIndexerOpeningLookup(indexerUrl, Number(options.config.get("fetch.timeoutMs"))),
    },
  });
}

export async function startLocalServer() {
  const environment = process.env;
  const pointers = readLocalLauncherPointers(environment);
  const configPath =
    pointers.configPath ?? fileURLToPath(new URL("../../../env/local.toml", import.meta.url));
  const config = await loadConfigFile(configPath, {
    env: parameterEnvironment(environment),
  });
  const rpcUrl = pointers.rpcUrl ?? `http://127.0.0.1:${config.get("signer.local.rpcPort")}`;
  await validateLocalOnlyConfig({
    config,
    overlayPath: String(configPath),
    arcRpcUrl: rpcUrl,
  });
  const indexerUrl = requiredPointer(pointers.indexerUrl, "CZAR_INDEXER_URL");
  const databaseUrl =
    pointers.databaseUrl ??
    `postgres://postgres@127.0.0.1:${config.get("signer.local.dbPort")}/postgres`;
  const objectStorePath = resolve(
    pointers.objectStorePath ?? join(homedir(), "Library/Application Support/Czar/objects"),
  );
  const port = parsePort(pointers.serverPort);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const deployment = await readLocalDeployment();
    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    const walletClient = createWalletClient({ transport: http(rpcUrl) });
    await assertLocalChain(publicClient, deployment);
    const logger = createLogger({ service: "server", component: "CZ-15" });
    const root = await createLocalServerMain({
      pool,
      config,
      logger,
      createSigner: () =>
        createSignerClient({
          socketPath: String(config.get("signer.socketPath")),
          service: "server",
        }),
      publicClient,
      walletClient,
      safeFetch: createSafeFetchFromConfig(config, "czar-server/local"),
      objects: createFileObjectStore(objectStorePath),
      rpcUrl,
      factoryAddress: deployment.CzarVaultFactory,
      gatewayMinter: deployment.gatewayMinter,
      gatewayDomain: deployment.gatewayDomain,
      indexerUrl,
      clock: { now: () => new Date() },
      random: { bytes: (size) => randomBytes(size) },
    });
    const server = createHttpServer(root, logger);
    try {
      await listenOnLoopback(server, port);
    } catch (error) {
      await root.close();
      throw error;
    }
    return createRunningServer(server, pool, root);
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function readLocalDeployment(): Promise<LocalDeployment> {
  const path = new URL("../../../deployments/arc-local.json", import.meta.url);
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  return {
    chainId: requireChainId(manifest["chainId"]),
    CzarVaultFactory: requireAddress(manifest["CzarVaultFactory"], "CzarVaultFactory"),
    gatewayMinter: requireAddress(manifest["gatewayMinter"], "gatewayMinter"),
    gatewayDomain: requireSafeInteger(manifest["gatewayDomain"], "gatewayDomain"),
  };
}

async function assertLocalChain(
  client: ReturnType<typeof createPublicClient>,
  deployment: LocalDeployment,
): Promise<void> {
  const rpcChainId = await client.getChainId();
  if (deployment.chainId !== ARC_CHAIN_ID || rpcChainId !== ARC_CHAIN_ID)
    throw new Error("Local server requires an Arc deployment and RPC chain id 5042002.");
}

function createHttpServer(root: ServerMain, logger: Logger): Server {
  return createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const method = incoming.method ?? "GET";
      const body = method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(incoming);
      const response = await root.app.request(
        new Request(`http://localhost${incoming.url ?? "/"}`, {
          method,
          headers,
          ...(body === undefined ? {} : ({ body: body as never, duplex: "half" } as RequestInit)),
        }),
        undefined,
        { remoteAddr: incoming.socket.remoteAddress },
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      logger.error("server_http_adapter_failure", { rule: "http-adapter", state: "error" });
      outgoing.writeHead(503, { "content-type": "application/json" });
      outgoing.end('{"status":"unavailable"}');
    }
  });
}

function createRunningServer(server: Server, pool: Pool, root: ServerMain) {
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      try {
        await root.close();
      } finally {
        try {
          await closeServer(server);
        } finally {
          await pool.end();
        }
      }
    })();
    return stopping;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  return { root, server, stop };
}

export function listenOnLoopback(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

function requiredPointer(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} must be set by the local launcher.`);
  return value;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SERVER_PORT;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new RangeError("CZAR_SERVER_PORT must be an integer from 1 to 65535.");
  return port;
}

function requireAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value))
    throw new Error(`Local deployment manifest has no valid ${label} address.`);
  return value;
}

function requireChainId(value: unknown): number {
  return requireSafeInteger(value, "chainId");
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Local deployment manifest has no valid ${label}.`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startLocalServer();
}
