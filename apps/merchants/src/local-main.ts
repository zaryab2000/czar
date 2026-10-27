import { loadConfigFile, parameterEnvironment, validateLocalOnlyConfig } from "@czar/config";
import { createLogger } from "@czar/logging";
import { createSignerClient, type SignerClient } from "@czar/signer";
import { Pool } from "pg";
import { createMerchantServer } from "./runtime.ts";
import { postgresPaymentIdStore } from "./postgres-payment-id-store.ts";
import { migrateMerchant } from "./migrate.ts";

export async function startLocalMerchant() {
  const localConfigPath =
    process.env["CZAR_LOCAL_CONFIG"] ?? new URL("../../../env/local.toml", import.meta.url);
  const config = await loadConfigFile(localConfigPath, { env: parameterEnvironment(process.env) });
  const rpcUrl =
    process.env["CZAR_ARC_RPC_URL"] ?? `http://127.0.0.1:${config.get("signer.local.rpcPort")}`;
  await validateLocalOnlyConfig({ config, overlayPath: localConfigPath, arcRpcUrl: rpcUrl });

  const databasePort = Number(config.get("signer.local.dbPort"));
  const pool = new Pool({
    connectionString:
      process.env["CZAR_DATABASE_URL"] ?? `postgres://postgres@127.0.0.1:${databasePort}/postgres`,
  });
  try {
    await migrateMerchant(pool);
    let signer: SignerClient;
    try {
      signer = await createSignerClient({
        socketPath: String(config.get("signer.socketPath")),
        service: "merchants",
      });
    } catch (error) {
      throw new Error("merchant_signer_unavailable", { cause: error });
    }
    const store = postgresPaymentIdStore({
      pool,
      ttlMs: Number(config.get("merchants.paymentIdTtlHours")) * 60 * 60 * 1000,
      maxBytes: Number(config.get("merchants.cacheMaxBytes")),
    });
    const logger = createLogger({ service: "merchants", component: "CZ-20" });
    const runtime = await createMerchantServer({
      config,
      signer,
      store,
      logger,
      drainTimeoutMs: Number(config.get("merchants.drainTimeoutMs")),
    });
    let stopping: Promise<void> | undefined;
    const stop = () => {
      stopping ??= runtime.stop().then(() => pool.end());
      return stopping;
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    return { runtime, stop };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1])) {
  await startLocalMerchant();
}
