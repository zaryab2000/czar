// The indexer's cloud branch (SCR-170 §3). The indexer has no entry file of its own: `ponder start`
// loads `ponder.config.ts` and then `src/index.ts`. Each of those takes a branch through this module
// only when the pointer `CZAR_CLOUD_CONFIG` is set; with it unset neither file changes behaviour.
//
// - `ponder.config.ts` loads the cloud config, refuses an RPC host outside `deploy.allowedRpcHosts`
//   before Ponder can contact it (Ponder's `eth_chainId` diagnostic runs before any indexing file
//   loads), and sets the Postgres database: the URL pointer carries no password, and node-postgres
//   reads the password from `<deploy.credentialFilesDir>/indexer/db-password` (SCR-170 §4).
// - `register-external-events.ts` runs the full guard, confirming the chain id with `eth_chainId`, in
//   place of `validateLocalOnlyConfig`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ARC_TESTNET_CHAIN_ID,
  cloudPoolOptions,
  type CloudPoolOptions,
  type Config,
  loadConfig,
  parameterEnvironment,
  parseParameterToml,
  validateCloudConfig,
} from "@czar/config";
import { createPublicClient, http } from "viem";

/** The pointer naming the cloud parameter file; a pointer, never a secret (SCR-170 §3). */
export const CLOUD_CONFIG_POINTER = "CZAR_CLOUD_CONFIG";
/** The database URL, without a password (SCR-170 §4); the pointer the cloud signer reads. */
export const DATABASE_URL_POINTER = "CZAR_DATABASE_URL";
/** The indexer's own credential folder under `deploy.credentialFilesDir` (SCR-170 §4). */
export const INDEXER_CREDENTIAL_FOLDER = "indexer";
export const DB_PASSWORD_FILE = "db-password";

type Environment = Readonly<Record<string, string | undefined>>;

/** The cloud parameter file's path, or undefined when the pointer is unset (the local stack). */
export function cloudConfigPointer(env: Environment): string | undefined {
  const value = env[CLOUD_CONFIG_POINTER];
  if (value === undefined) return undefined;
  if (value.trim() === "") throw new Error(`refusing to start: ${CLOUD_CONFIG_POINTER} is empty`);
  return value.trim();
}

/** Loads the cloud parameter file synchronously, as `ponder.config.ts` loads the local one. */
export function loadCloudIndexerConfig(path: string, env: Environment): Config {
  return loadConfig({
    envFile: parseParameterToml(readFileSync(path, "utf8")),
    env: parameterEnvironment(env),
  });
}

/**
 * The host check, before any network call: the chain id is the one this stage may use, so a host
 * outside `deploy.allowedRpcHosts` is refused without being contacted.
 */
export function refuseUnsafeCloudConfig(config: Config, rpcUrl: string): void {
  validateCloudConfig({
    config,
    role: "indexer",
    chainId: ARC_TESTNET_CHAIN_ID,
    rpcUrls: [rpcUrl],
  });
}

export interface CloudDatabaseConfig {
  readonly kind: "postgres";
  readonly poolConfig: CloudPoolOptions;
}

/**
 * Ponder's `database` for the cloud: no password in the URL; node-postgres reads it from the file.
 *
 * The URL is split into fields and no `connectionString` is given. Ponder passes
 * `{ connectionString, ...poolConfig }` to node-postgres, which parses the string over the options,
 * and a URL with no password writes `password: null` over the password function (PR #225).
 */
export function cloudDatabaseConfig(config: Config, env: Environment): CloudDatabaseConfig {
  const connectionString = env[DATABASE_URL_POINTER]?.trim();
  if (connectionString === undefined || connectionString === "")
    throw new Error(`refusing to start: ${DATABASE_URL_POINTER} is not set`);
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`refusing to start: ${DATABASE_URL_POINTER} is not a URL`);
  }
  if (url.password !== "")
    throw new Error(`refusing to start: ${DATABASE_URL_POINTER} must not carry a password`);
  const passwordFile = resolve(
    String(config.get("deploy.credentialFilesDir")),
    INDEXER_CREDENTIAL_FOLDER,
    DB_PASSWORD_FILE,
  );
  return { kind: "postgres", poolConfig: cloudPoolOptions(url, passwordFile) };
}

export interface CloudIndexerGuardOptions {
  readonly config: Config;
  readonly rpcUrl: string;
  /** The deployment file the handlers read; its `chainId` must match the RPC's. */
  readonly deploymentPath: string;
}

/** The full guard: host check first, then the chain id the RPC reports against the deployment file. */
export async function guardCloudIndexer(options: CloudIndexerGuardOptions): Promise<void> {
  const { config, rpcUrl } = options;
  refuseUnsafeCloudConfig(config, rpcUrl);
  const manifest = JSON.parse(readFileSync(options.deploymentPath, "utf8")) as Record<
    string,
    unknown
  >;
  const deploymentChainId = manifest["chainId"];
  if (
    typeof deploymentChainId !== "number" ||
    !Number.isSafeInteger(deploymentChainId) ||
    deploymentChainId < 0
  )
    throw new Error("the deployment file has no valid chainId");
  const chainId = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
  if (chainId !== deploymentChainId)
    throw new Error(
      `refusing to start: the RPC reports chain ${chainId}, the deployment file ${deploymentChainId}`,
    );
  validateCloudConfig({ config, role: "indexer", chainId, rpcUrls: [rpcUrl] });
}
