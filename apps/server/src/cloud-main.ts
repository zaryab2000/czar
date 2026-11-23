// The server's cloud entry point (SCR-170 §3). It builds the same `createServerMain(...)` composition
// `local-main.ts` builds, through the exported `createLocalServerMain`, with real service URLs from the
// cloud parameter file. `main.ts`, `local-main.ts`, `app.ts` and every route file are untouched, so
// local behaviour is unchanged.
//
// No secret reaches this process through its arguments or environment (D70, D78): the database
// password, the signer socket token and the model API key are files under
// `<deploy.credentialFilesDir>/server/` (SCR-170 §4). The model adapter is injected only when
// `models.provider = anthropic` (SCR-170 §6); the default `none` leaves it out exactly as
// `local-main.ts` does.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARC_TESTNET_CHAIN_ID,
  cloudPoolOptions,
  type Config,
  loadConfigFile,
  parameterEnvironment,
  validateCloudConfig,
} from "@czar/config";
import { createLogger, type Logger } from "@czar/logging";
import { assertNoSecretInProcess, createSignerClient, fileSignerIdentity } from "@czar/signer";
import { createSafeFetchFromConfig } from "@czar/x402";
import { Pool } from "pg";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { closeHttpServer, createServerHttpAdapter } from "#src/cloud-http";
import { createLocalServerMain, listenOnLoopback } from "#src/local-main";
import type { ServerMain } from "#src/main";
import { createAnthropicModelClient } from "#src/models/anthropic";
import type { ModelClient } from "#src/models/proxy";
import { createFileObjectStore } from "#src/object-store";

/** The pointer naming the cloud parameter file; a pointer, never a secret (SCR-170 §3). */
export const CLOUD_CONFIG_POINTER = "CZAR_CLOUD_CONFIG";
/**
 * The Arc RPC URL the server's own chain clients use: the pointer `local-main.ts` reads. Left out,
 * the server uses `app.arcRpcUrl`. Every RPC URL the server uses must have a host in
 * `deploy.allowedRpcHosts`.
 */
export const RPC_URL_POINTER = "CZAR_ARC_RPC_URL";
/** The database URL, without a password (SCR-170 §4). */
export const DATABASE_URL_POINTER = "CZAR_DATABASE_URL";
/** The loopback port; the same pointer `local-main.ts` reads. */
export const SERVER_PORT_POINTER = "CZAR_SERVER_PORT";
/** The server's own credential folder under `deploy.credentialFilesDir` (SCR-170 §4). */
export const SERVER_CREDENTIAL_FOLDER = "server";
export const DB_PASSWORD_FILE = "db-password";
export const SIGNER_TOKEN_FILE = "signer-token";
/** Caddy forwards `/v1/*` and `/health` to `127.0.0.1:3000` (SCR-170 §2); as `local-main.ts`. */
export const DEFAULT_SERVER_PORT = 3000;
/** The Gateway API path the pullback and pocket-recovery paths post to (A2-30, SCR-130). */
const GATEWAY_TRANSFER_PATH = "/v1/transfer";
/** `User-Agent` product token for the server's outbound `safeFetch`. */
const SAFE_FETCH_VERSION = "czar-server/cloud";
const MAX_PORT = 65535;

export interface CloudServerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly argv?: readonly string[];
  readonly logger?: Logger;
  /** Replaces the RPC-backed clients the cloud process builds from the RPC URL. */
  readonly publicClient?: PublicClient;
  readonly walletClient?: WalletClient;
  /** Reads the model API key file; injected in tests so the read can be counted. */
  readonly readSecretFile?: (path: string) => Promise<string>;
  /** The model adapter's `fetch`; injected in tests so no request reaches a provider. */
  readonly modelFetch?: typeof fetch;
}

export interface RunningCloudServer {
  readonly root: ServerMain;
  readonly server: Server;
  readonly chainId: number;
  /** The injected model adapter, or undefined when `models.provider = none`. */
  readonly modelClient: ModelClient | undefined;
  stop(): Promise<void>;
}

interface CloudDeployment {
  readonly chainId: number;
  readonly CzarVaultFactory: Address;
  readonly gatewayMinter: Address;
  readonly gatewayDomain: number;
}

function requireEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "")
    throw new Error(`refusing to start: ${name} is not set`);
  return value.trim();
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_SERVER_PORT;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > MAX_PORT)
    throw new RangeError(`${SERVER_PORT_POINTER} must be an integer from 1 to ${MAX_PORT}.`);
  return port;
}

/**
 * The database pool every cloud entry builds (SCR-170 §4): the connection string carries no password,
 * and node-postgres reads it from the file through its supported password function, so it is never a
 * URL, a parameter or a variable.
 */
export function cloudDatabasePool(connectionString: string, passwordFile: string): Pool {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`refusing to start: ${DATABASE_URL_POINTER} is not a URL`);
  }
  if (url.password !== "")
    throw new Error(`refusing to start: ${DATABASE_URL_POINTER} must not carry a password`);
  return new Pool(cloudPoolOptions(url, passwordFile));
}

async function readCloudDeployment(path: string): Promise<CloudDeployment> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  return {
    chainId: requireSafeInteger(manifest["chainId"], "chainId"),
    CzarVaultFactory: requireAddress(manifest["CzarVaultFactory"], "CzarVaultFactory"),
    gatewayMinter: requireAddress(manifest["gatewayMinter"], "gatewayMinter"),
    gatewayDomain: requireSafeInteger(manifest["gatewayDomain"], "gatewayDomain"),
  };
}

function requireAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value))
    throw new Error(`the deployment file has no valid ${label} address`);
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`the deployment file has no valid ${label}`);
  return value;
}

/** Every RPC URL the server uses: its own clients' URL and the published `app.arcRpcUrl`. */
function serverRpcUrls(config: Config, pointer: string | undefined): readonly [string, string[]] {
  const published = config.has("app.arcRpcUrl") ? String(config.get("app.arcRpcUrl")) : undefined;
  const own = pointer ?? published;
  if (own === undefined)
    throw new Error(`refusing to start: set ${RPC_URL_POINTER} or app.arcRpcUrl`);
  const all = published === undefined || published === own ? [own] : [own, published];
  return [own, all];
}

/** Starts the cloud server: the local composition, real service URLs, and secrets from files. */
export async function startCloudServer(
  options: CloudServerOptions = {},
): Promise<RunningCloudServer> {
  const env = options.env ?? process.env;
  assertNoSecretInProcess(options.argv ?? process.argv, env);
  const config: Config = await loadConfigFile(requireEnv(env, CLOUD_CONFIG_POINTER), {
    env: parameterEnvironment(env),
  });
  const pointer = env[RPC_URL_POINTER]?.trim();
  const [rpcUrl, rpcUrls] = serverRpcUrls(config, pointer === "" ? undefined : pointer);

  // Checked twice on purpose, as the cloud signer does: once before any RPC call, with the chain id
  // this stage is allowed to use, so an unallowlisted host is refused without being contacted; then
  // again with the chain id the RPC actually reports (SCR-170 §3).
  validateCloudConfig({ config, role: "server", chainId: ARC_TESTNET_CHAIN_ID, rpcUrls });

  const databaseUrl = requireEnv(env, DATABASE_URL_POINTER);
  const port = parsePort(env[SERVER_PORT_POINTER]);
  const credentialFilesDir = String(config.get("deploy.credentialFilesDir"));
  const serverCredentials = resolve(credentialFilesDir, SERVER_CREDENTIAL_FOLDER);
  const deployment = await readCloudDeployment(
    resolve(String(config.get("deploy.deploymentFile"))),
  );

  const publicClient = options.publicClient ?? createPublicClient({ transport: http(rpcUrl) });
  const walletClient = options.walletClient ?? createWalletClient({ transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== deployment.chainId)
    throw new Error(
      `refusing to start: the RPC reports chain ${chainId}, the deployment file ${deployment.chainId}`,
    );
  validateCloudConfig({ config, role: "server", chainId, rpcUrls });

  const logger = options.logger ?? createLogger({ service: "server", component: "CZ-15" });
  const readSecretFile = options.readSecretFile ?? ((path: string) => readFile(path, "utf8"));
  const modelClient =
    config.get("models.provider") === "anthropic"
      ? createAnthropicModelClient({
          config,
          readSecretFile,
          ...(options.modelFetch === undefined ? {} : { fetchFn: options.modelFetch }),
        })
      : undefined;
  const socketGroupGid = config.has("signer.socketGroupGid")
    ? Number(config.get("signer.socketGroupGid"))
    : undefined;

  const pool = cloudDatabasePool(databaseUrl, resolve(serverCredentials, DB_PASSWORD_FILE));
  try {
    const root = await createLocalServerMain({
      pool,
      config,
      logger,
      ...(modelClient === undefined ? {} : { modelClient }),
      createSigner: () =>
        createSignerClient({
          socketPath: String(config.get("signer.socketPath")),
          service: "server",
          identity: fileSignerIdentity(credentialFilesDir, {
            services: [SERVER_CREDENTIAL_FOLDER],
            fileName: SIGNER_TOKEN_FILE,
          }),
          ...(socketGroupGid === undefined ? {} : { socketGroupGid }),
        }),
      publicClient,
      walletClient,
      safeFetch: createSafeFetchFromConfig(config, SAFE_FETCH_VERSION),
      objects: createFileObjectStore(resolve(String(config.get("deploy.objectStorePath")))),
      rpcUrl,
      factoryAddress: deployment.CzarVaultFactory,
      gatewayMinter: deployment.gatewayMinter,
      gatewayDomain: deployment.gatewayDomain,
      gatewayTransferUrl: `${String(config.get("chain.gatewayApiBaseUrl")).replace(/\/+$/, "")}${GATEWAY_TRANSFER_PATH}`,
      indexerUrl: String(config.get("deploy.indexerUrl")),
      clock: { now: () => new Date() },
      random: { bytes: (size) => randomBytes(size) },
    });
    const server = createServerHttpAdapter(root, logger);
    try {
      await listenOnLoopback(server, port);
    } catch (error) {
      await root.close();
      throw error;
    }
    let stopping: Promise<void> | undefined;
    return {
      root,
      server,
      chainId,
      modelClient,
      stop() {
        stopping ??= (async () => {
          try {
            await root.close();
          } finally {
            try {
              await closeHttpServer(server);
            } finally {
              await pool.end();
            }
          }
        })();
        return stopping;
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await startCloudServer();
  const shutdown = () => void running.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
