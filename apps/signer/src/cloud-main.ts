// The signer's cloud entry point (SCR-170 §3). `startSignerProcess` in `main.ts` refuses any backend
// but `local-keystore`, so this file composes `createSigner`, `startSignerSocket` and
// `startGasRefillJob` itself; `main.ts` and `local-main.ts` are not touched and local behaviour is
// unchanged. No secret reaches this process through its arguments or environment (D70, D78): the
// database password is a file, the socket tokens are files and the signing keys never leave Cloud KMS.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type PublicClient } from "viem";
import { Pool } from "pg";
import {
  ARC_TESTNET_CHAIN_ID,
  cloudPoolOptions,
  type Config,
  loadConfigFile,
  parameterEnvironment,
  validateCloudConfig,
} from "@czar/config";
import type { Address, Domain } from "@czar/hashing";
import { createLogger, type Logger } from "@czar/logging";
import { openGcpKmsBackend } from "./gcp-kms-backend.ts";
import { metadataAccessToken } from "./gcp-auth.ts";
import { fileSignerIdentity } from "./file-identity.ts";
import { startGasRefillJob } from "./gas-refill.ts";
import { GAS_LOW_KEYS, createSignerMetrics, type SignerMetrics } from "./metrics.ts";
import { assertNoSecretInProcess } from "./passphrase.ts";
import { postgresAudit, type AuditQueryExecutor } from "./postgres-audit.ts";
import { createPostgresProjection } from "./postgres-projection.ts";
import {
  createLocalSignerPolicy,
  createRpcGasRefillAdapters,
  createRpcTransactionPreparer,
} from "./runtime-adapters.ts";
import { createSigner, type Signer, type SignerAlertPort } from "./service.ts";
import { startSignerSocket } from "./socket.ts";

/** The pointer naming the cloud parameter file; a pointer, never a secret (SCR-170 §3). */
export const CLOUD_CONFIG_POINTER = "CZAR_CLOUD_CONFIG";
/** The Arc testnet RPC URL this process uses; its host must be in `deploy.allowedRpcHosts`. */
export const RPC_URL_POINTER = "CZAR_SIGNER_RPC_URL";
/** The database URL, without a password (SCR-170 §4). */
export const DATABASE_URL_POINTER = "CZAR_DATABASE_URL";
/** The file under the signer's credential folder holding its database password (SCR-170 §4). */
export const DB_PASSWORD_FILE = "db-password";
/** The signer's own credential folder, and the folder holding the client tokens it expects. */
export const SIGNER_CREDENTIAL_FOLDER = "signer";
export const CLIENT_TOKENS_FOLDER = "client-tokens";

/**
 * Every merchant service the cloud runs (CZ-20 §5.8, §5.8a). The signer only ever hands out
 * `K10:<service>` for a service in this list, so it is named here rather than derived.
 */
export const CLOUD_MERCHANT_SERVICES: readonly string[] = [
  "czar-search",
  "czar-spot",
  "czar-extract",
  "lab-search-steady",
  "lab-search-flaky",
  "lab-search-slow",
  "lab-extract-schemabreak",
  "lab-extract-drift",
  "lab-spot-payee-swap",
];

/** Every chain read and write the cloud signer makes; the RPC-backed client in production. */
export type CloudChainClient = Pick<
  PublicClient,
  | "getChainId"
  | "estimateGas"
  | "prepareTransactionRequest"
  | "getBalance"
  | "sendRawTransaction"
  | "waitForTransactionReceipt"
  | "getBlock"
  | "getBlockNumber"
  | "getTransactionReceipt"
  | "readContract"
>;

export interface CloudSignerDatabase extends AuditQueryExecutor {
  end?(): Promise<void>;
}

export interface CloudSignerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly argv?: readonly string[];
  /** Replaces the RPC-backed client; the cloud process builds one from the RPC pointer. */
  readonly chain?: CloudChainClient;
  /** Replaces the `pg.Pool` the cloud process builds from the URL pointer and the password file. */
  readonly database?: CloudSignerDatabase;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
}

export interface RunningCloudSigner {
  readonly signer: Signer;
  readonly metrics: SignerMetrics;
  readonly chainId: number;
  readonly keyRefs: readonly string[];
  stop(): Promise<void>;
}

function requireEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "")
    throw new Error(`refusing to start: ${name} is not set`);
  return value.trim();
}

function requireAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !/^0x[\da-fA-F]{40}$/.test(value))
    throw new Error(`the deployment file has no valid ${label} address`);
  return value.toLowerCase() as Address;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`the deployment file has no valid ${label}`);
  return value;
}

/**
 * The gas-refill and signer alert port in the cloud: a structured log event, never the message text
 * (cross-cutting §4 drops free text, and `keyId` is the one field on the allowlist). Delivering alerts
 * anywhere else is PM-051.
 */
export function logAlertPort(logger: Pick<Logger, "error">): SignerAlertPort {
  return async (message: string) => {
    const keyId = GAS_LOW_KEYS.find((key) => message.includes(key));
    if (keyId === undefined) logger.error("signer_alert_raised");
    else logger.error("signer_gas_low", { keyId });
  };
}

/** Starts the cloud signer: Cloud KMS keys, file-based socket tokens, and the gas refill loop. */
export async function startCloudSigner(
  options: CloudSignerOptions = {},
): Promise<RunningCloudSigner> {
  const env = options.env ?? process.env;
  assertNoSecretInProcess(options.argv ?? process.argv, env);
  const logger = options.logger ?? createLogger({ service: "signer", component: "CZ-27" });
  const config: Config = await loadConfigFile(requireEnv(env, CLOUD_CONFIG_POINTER), {
    env: parameterEnvironment(env),
  });
  const rpcUrl = requireEnv(env, RPC_URL_POINTER);

  // Checked twice on purpose: once before any RPC call, with the chain id this stage is allowed to
  // use, so an unallowlisted host is refused without being contacted; then again with the chain id
  // the RPC actually reports (SCR-170 §3).
  validateCloudConfig({ config, role: "signer", chainId: ARC_TESTNET_CHAIN_ID, rpcUrls: [rpcUrl] });

  const deploymentPath = resolve(String(config.get("deploy.deploymentFile")));
  const deployment = JSON.parse(await readFile(deploymentPath, "utf8")) as Record<string, unknown>;
  const deploymentChainId = requireNonNegativeSafeInteger(deployment["chainId"], "chainId");
  const chain: CloudChainClient = options.chain ?? createPublicClient({ transport: http(rpcUrl) });
  const chainId = await chain.getChainId();
  if (chainId !== deploymentChainId)
    throw new Error(
      `refusing to start: the RPC reports chain ${chainId}, the deployment file ${deploymentChainId}`,
    );
  validateCloudConfig({ config, role: "signer", chainId, rpcUrls: [rpcUrl] });

  const credentialFilesDir = String(config.get("deploy.credentialFilesDir"));
  const signerCredentials = resolve(credentialFilesDir, SIGNER_CREDENTIAL_FOLDER);
  const database: CloudSignerDatabase =
    options.database ??
    new Pool(
      cloudPoolOptions(
        new URL(requireEnv(env, DATABASE_URL_POINTER)),
        resolve(signerCredentials, DB_PASSWORD_FILE),
      ),
    );

  const gatewayWallet = requireAddress(deployment["gatewayWallet"], "gatewayWallet");
  const network = {
    chainId,
    usdc: requireAddress(deployment["usdc"], "usdc"),
    gatewayWallet,
    gatewayMinter: requireAddress(deployment["gatewayMinter"], "gatewayMinter"),
    gatewayDomain: requireNonNegativeSafeInteger(deployment["gatewayDomain"], "gatewayDomain"),
    jobEscrow: requireAddress(deployment["jobEscrow"], "jobEscrow"),
    openEvidenceLog: requireAddress(deployment["OpenEvidenceLog"], "OpenEvidenceLog"),
    nanoDomain: {
      name: "GatewayWalletBatched",
      version: "1",
      chainId,
      verifyingContract: gatewayWallet,
    } satisfies Domain,
    merchantServices: CLOUD_MERCHANT_SERVICES,
  };

  const backend = await openGcpKmsBackend({
    config,
    token: metadataAccessToken({
      metadataTokenUrl: String(config.get("deploy.metadataTokenUrl")),
      timeoutMs: Number(config.get("kms.signTimeoutMs")),
      logger,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    logger,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  const audit = postgresAudit(database);
  const alert = logAlertPort(logger);
  const projection = createPostgresProjection({
    config,
    database,
    chain,
    factory: requireAddress(deployment["CzarVaultFactory"], "CzarVaultFactory"),
  });
  const policy = createLocalSignerPolicy();
  const signer = createSigner({
    backend,
    projection,
    network,
    config,
    audit,
    callers: policy.callers,
    prepareTransaction: createRpcTransactionPreparer({ chainId, rpcUrl, client: chain }),
    alert,
    logger,
  });

  const socketGroupGid = config.has("signer.socketGroupGid")
    ? Number(config.get("signer.socketGroupGid"))
    : undefined;
  const stopSocket = await startSignerSocket({
    socketPath: String(config.get("signer.socketPath")),
    signer,
    audit,
    identity: fileSignerIdentity(resolve(signerCredentials, CLIENT_TOKENS_FOLDER)),
    allowedCallers: policy.allowedCallers,
    ...(socketGroupGid === undefined ? {} : { socketGroupGid }),
  });

  const metrics = createSignerMetrics();
  const stopRefill = startGasRefillJob(
    {
      ...createRpcGasRefillAdapters({ client: chain }),
      config,
      signer,
      alert,
      metrics,
      logger,
      keyAddress: (key) => {
        const address = backend.address(key);
        if (address === undefined) throw new Error(`Cloud KMS holds no ${key} key`);
        return address;
      },
    },
    () => {
      logger.error("signer_gas_refill_pass_failed");
    },
  );

  return {
    signer,
    metrics,
    chainId,
    keyRefs: backend.keyRefs(),
    async stop() {
      stopRefill();
      await stopSocket();
      await database.end?.();
    },
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await startCloudSigner();
  const shutdown = () => void running.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
