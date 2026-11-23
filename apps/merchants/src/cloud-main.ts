// The merchants' cloud entry point (SCR-170 §3). It runs the same runtime `local-main.ts` runs, through
// PM-042's `createAlphaMerchantServer`, so the cloud serves `czar-search`, `czar-spot` and
// `czar-extract` while the local process keeps serving `czar-search` alone. `local-main.ts`, the
// payment code and the seller code are untouched.
//
// The Facilitator base URL is `merchants.facilitatorBaseUrl` from the cloud parameter file, read by the
// runtime exactly as today. The K10 `payTo` addresses come from the signer socket exactly as today; only
// the socket token is a file instead of a keychain item (SCR-170 §4). No secret reaches this process
// through its arguments or environment (D70, D78).
import { readFile } from "node:fs/promises";
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
import {
  assertNoSecretInProcess,
  createSignerClient,
  fileSignerIdentity,
  type SignerClient,
} from "@czar/signer";
import type { SafeFetch } from "@czar/x402";
import { Pool } from "pg";
import { createPublicClient, http, type PublicClient } from "viem";
import { createAlphaMerchantServer } from "./alpha-services.ts";
import { migrateMerchant } from "./migrate.ts";
import { postgresPaymentIdStore } from "./postgres-payment-id-store.ts";
import type { MerchantRuntime } from "./runtime.ts";

/** The pointer naming the cloud parameter file; a pointer, never a secret (SCR-170 §3). */
export const CLOUD_CONFIG_POINTER = "CZAR_CLOUD_CONFIG";
/**
 * The Arc RPC URL this process confirms the chain through: the pointer `local-main.ts` reads. Its host
 * must be in `deploy.allowedRpcHosts`.
 */
export const RPC_URL_POINTER = "CZAR_ARC_RPC_URL";
/** The database URL, without a password (SCR-170 §4). */
export const DATABASE_URL_POINTER = "CZAR_DATABASE_URL";
/** The loopback port; the pointer the runtime already reads. */
export const MERCHANT_PORT_POINTER = "CZAR_MERCHANT_PORT";
/** The merchants' own credential folder under `deploy.credentialFilesDir` (SCR-170 §4). */
export const MERCHANTS_CREDENTIAL_FOLDER = "merchants";
export const DB_PASSWORD_FILE = "db-password";
export const SIGNER_TOKEN_FILE = "signer-token";
/** Caddy forwards `https://merchants.<domain>` to `127.0.0.1:8787` (SCR-170 §2), as the runtime does. */
export const DEFAULT_MERCHANT_PORT = 8787;
const MAX_PORT = 65535;
const MS_PER_HOUR = 60 * 60 * 1000;
/** `User-Agent: Czar/<version>` for the shared extract and spot `safeFetch`. */
const MERCHANT_VERSION = "0.0.0";

export type CloudMerchantChainClient = Pick<PublicClient, "getChainId">;

export interface CloudMerchantOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly argv?: readonly string[];
  readonly logger?: Logger;
  /** Replaces the RPC-backed client the cloud process builds from the RPC pointer. */
  readonly chain?: CloudMerchantChainClient;
  /** Replaces the shared `safeFetch` `createAlphaMerchantServer` would build. */
  readonly safeFetch?: SafeFetch;
  /** The Facilitator client's `fetch`. */
  readonly fetchFn?: typeof fetch;
}

export interface RunningCloudMerchant {
  readonly runtime: MerchantRuntime;
  readonly chainId: number;
  stop(): Promise<void>;
}

function requireEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "")
    throw new Error(`refusing to start: ${name} is not set`);
  return value.trim();
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MERCHANT_PORT;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > MAX_PORT)
    throw new RangeError(`${MERCHANT_PORT_POINTER} must be an integer from 1 to ${MAX_PORT}.`);
  return port;
}

/** The URL carries no password; node-postgres reads it from the file (SCR-170 §4). */
function cloudDatabasePool(connectionString: string, passwordFile: string): Pool {
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

async function readDeploymentChainId(path: string): Promise<number> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const chainId = manifest["chainId"];
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId < 0)
    throw new Error("the deployment file has no valid chainId");
  return chainId;
}

/** Starts the cloud merchants: the alpha service list, K10 from the signer socket, secrets from files. */
export async function startCloudMerchant(
  options: CloudMerchantOptions = {},
): Promise<RunningCloudMerchant> {
  const env = options.env ?? process.env;
  assertNoSecretInProcess(options.argv ?? process.argv, env);
  const config: Config = await loadConfigFile(requireEnv(env, CLOUD_CONFIG_POINTER), {
    env: parameterEnvironment(env),
  });
  const rpcUrl = requireEnv(env, RPC_URL_POINTER);

  // Checked twice on purpose, as the cloud signer does: once before any RPC call, so an unallowlisted
  // host is refused without being contacted; then with the chain id the RPC reports (SCR-170 §3).
  validateCloudConfig({
    config,
    role: "merchants",
    chainId: ARC_TESTNET_CHAIN_ID,
    rpcUrls: [rpcUrl],
  });

  const databaseUrl = requireEnv(env, DATABASE_URL_POINTER);
  const port = parsePort(env[MERCHANT_PORT_POINTER]);
  const deploymentChainId = await readDeploymentChainId(
    resolve(String(config.get("deploy.deploymentFile"))),
  );
  const chain: CloudMerchantChainClient =
    options.chain ?? createPublicClient({ transport: http(rpcUrl) });
  const chainId = await chain.getChainId();
  if (chainId !== deploymentChainId)
    throw new Error(
      `refusing to start: the RPC reports chain ${chainId}, the deployment file ${deploymentChainId}`,
    );
  validateCloudConfig({ config, role: "merchants", chainId, rpcUrls: [rpcUrl] });

  const credentialFilesDir = String(config.get("deploy.credentialFilesDir"));
  const merchantCredentials = resolve(credentialFilesDir, MERCHANTS_CREDENTIAL_FOLDER);
  const socketGroupGid = config.has("signer.socketGroupGid")
    ? Number(config.get("signer.socketGroupGid"))
    : undefined;
  const pool = cloudDatabasePool(databaseUrl, resolve(merchantCredentials, DB_PASSWORD_FILE));
  try {
    await migrateMerchant(pool);
    let signer: SignerClient;
    try {
      signer = await createSignerClient({
        socketPath: String(config.get("signer.socketPath")),
        service: "merchants",
        identity: fileSignerIdentity(credentialFilesDir, {
          services: [MERCHANTS_CREDENTIAL_FOLDER],
          fileName: SIGNER_TOKEN_FILE,
        }),
        ...(socketGroupGid === undefined ? {} : { socketGroupGid }),
      });
    } catch (error) {
      throw new Error("merchant_signer_unavailable", { cause: error });
    }
    const store = postgresPaymentIdStore({
      pool,
      ttlMs: Number(config.get("merchants.paymentIdTtlHours")) * MS_PER_HOUR,
      maxBytes: Number(config.get("merchants.cacheMaxBytes")),
    });
    const logger = options.logger ?? createLogger({ service: "merchants", component: "CZ-20" });
    const runtime = await createAlphaMerchantServer({
      config,
      signer,
      store,
      logger,
      port,
      host: "127.0.0.1",
      drainTimeoutMs: Number(config.get("merchants.drainTimeoutMs")),
      version: MERCHANT_VERSION,
      credentialFolder: merchantCredentials,
      ...(options.safeFetch === undefined ? {} : { safeFetch: options.safeFetch }),
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    });
    let stopping: Promise<void> | undefined;
    return {
      runtime,
      chainId,
      stop() {
        stopping ??= runtime.stop().finally(() => pool.end());
        return stopping;
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await startCloudMerchant();
  const shutdown = () => void running.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
