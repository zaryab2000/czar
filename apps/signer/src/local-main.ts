import { readFile } from "node:fs/promises";
import { loadConfigFile, parameterEnvironment } from "@czar/config";
import type { Address, Domain } from "@czar/hashing";
import { Pool } from "pg";
import { createPublicClient, http } from "viem";
import { createLocalSignerAdapters, createLocalSignerPolicy } from "./runtime-adapters.ts";
import { createPostgresProjection } from "./postgres-projection.ts";
import { startSignerProcess } from "./main.ts";

const chainId = 5042002;
const rpcUrl = process.env["CZAR_SIGNER_RPC_URL"] ?? "http://127.0.0.1:8545";
const databaseUrl =
  process.env["CZAR_DATABASE_URL"] ?? "postgres://postgres@127.0.0.1:15433/postgres";
const config = await loadConfigFile(
  process.env["CZAR_LOCAL_CONFIG"] ?? new URL("../../../env/local.toml", import.meta.url),
  { env: parameterEnvironment(process.env) },
);
const chain = createPublicClient({ transport: http(rpcUrl) });
const manifestPath =
  process.env["CZAR_SIGNER_DEPLOYMENT_PATH"] ??
  new URL("../../../deployments/arc-local.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  chainId?: number;
  CzarVaultFactory?: string;
  OpenEvidenceLog?: string;
};
if (manifest.chainId !== chainId || (await chain.getChainId()) !== chainId)
  throw new Error(`Local signer requires deployment and RPC chain id ${chainId}`);
const factory = requireAddress(manifest.CzarVaultFactory, "CzarVaultFactory");
const openEvidenceLog = requireAddress(manifest.OpenEvidenceLog, "OpenEvidenceLog");
const database = new Pool({ connectionString: databaseUrl });
const network = {
  chainId,
  usdc: "0x3600000000000000000000000000000000000000" as Address,
  gatewayWallet: "0x0077777d7eba4688bdef3e311b846f25870a19b9" as Address,
  gatewayMinter: "0x0022222abe238cc2c7bb1f21003f0a260052475b" as Address,
  gatewayDomain: 26,
  jobEscrow: "0x0747eef0706327138c69792bf28cd525089e4583" as Address,
  openEvidenceLog,
  nanoDomain: {
    name: "GatewayWalletBatched",
    version: "1",
    chainId,
    verifyingContract: "0x0077777d7eba4688bdef3e311b846f25870a19b9" as Address,
  } satisfies Domain,
  merchantServices: ["czar-search"],
};
const projection = createPostgresProjection({
  database,
  chain,
  factory,
});
const adapters = createLocalSignerAdapters({
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
