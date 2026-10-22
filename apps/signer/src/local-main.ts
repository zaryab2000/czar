import { readFile } from "node:fs/promises";
import { loadConfigFile, parameterEnvironment } from "@czar/config";
import type { Address, Domain } from "@czar/hashing";
import { Pool } from "pg";
import { createPublicClient, http } from "viem";
import { createLocalSignerAdapters, createLocalSignerPolicy } from "./runtime-adapters.ts";
import { createPostgresProjection } from "./postgres-projection.ts";
import { startSignerProcess } from "./main.ts";

const chainId = 5042002;
const config = await loadConfigFile(
  process.env["CZAR_LOCAL_CONFIG"] ?? new URL("../../../env/local.toml", import.meta.url),
  { env: parameterEnvironment(process.env) },
);
const rpcUrl =
  process.env["CZAR_SIGNER_RPC_URL"] ?? `http://127.0.0.1:${config.get("signer.local.rpcPort")}`;
const databaseUrl =
  process.env["CZAR_DATABASE_URL"] ??
  `postgres://postgres@127.0.0.1:${config.get("signer.local.dbPort")}/postgres`;
const chain = createPublicClient({ transport: http(rpcUrl) });
const manifestPath =
  process.env["CZAR_SIGNER_DEPLOYMENT_PATH"] ??
  new URL("../../../deployments/arc-local.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  chainId?: number;
  CzarVaultFactory?: string;
  OpenEvidenceLog?: string;
  usdc?: string;
  gatewayWallet?: string;
  gatewayMinter?: string;
  gatewayDomain?: number;
  jobEscrow?: string;
};
if (manifest.chainId !== chainId || (await chain.getChainId()) !== chainId)
  throw new Error(`Local signer requires deployment and RPC chain id ${chainId}`);
const factory = requireAddress(manifest.CzarVaultFactory, "CzarVaultFactory");
const openEvidenceLog = requireAddress(manifest.OpenEvidenceLog, "OpenEvidenceLog");
const usdc = requireAddress(manifest.usdc, "usdc");
const gatewayWallet = requireAddress(manifest.gatewayWallet, "gatewayWallet");
const gatewayMinter = requireAddress(manifest.gatewayMinter, "gatewayMinter");
const jobEscrow = requireAddress(manifest.jobEscrow, "jobEscrow");
const gatewayDomain = requireNonNegativeSafeInteger(manifest.gatewayDomain, "gatewayDomain");
const database = new Pool({ connectionString: databaseUrl });
const network = {
  chainId,
  usdc,
  gatewayWallet,
  gatewayMinter,
  gatewayDomain,
  jobEscrow,
  openEvidenceLog,
  nanoDomain: {
    name: "GatewayWalletBatched",
    version: "1",
    chainId,
    verifyingContract: gatewayWallet,
  } satisfies Domain,
  merchantServices: ["czar-search"],
};
const projection = createPostgresProjection({
  config,
  database,
  chain,
  factory,
});
const adapters = createLocalSignerAdapters({
  rpcUrl,
  postgres: database,
  client: chain,
  chainId,
  alert: async (message) => process.emitWarning(message),
});
const policy = createLocalSignerPolicy();
const running = await startSignerProcess({
  config,
  projection,
  network,
  ...policy,
  ...adapters,
});

const shutdown = async () => {
  await running.stop();
  await database.end();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function requireAddress(value: string | undefined, label: string): Address {
  if (value === undefined || !/^0x[\da-fA-F]{40}$/.test(value))
    throw new Error(`Local deployment manifest has no valid ${label} address`);
  return value as Address;
}

function requireNonNegativeSafeInteger(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Local deployment manifest has no valid ${label}`);
  return value;
}
