import {
  loadConfigFile,
  parameterEnvironment,
  validateLocalOnlyConfig,
  type Config,
} from "@czar/config";
import { Pool } from "pg";

export interface ControlledLocalContext {
  config: Config;
  pool: Pool;
}

/** Refuse fixture writes outside the explicit local configuration and loopback DB. */
export async function controlledLocalContext(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ControlledLocalContext> {
  const configPath = environment["CZAR_LOCAL_CONFIG"] ?? "../../env/local.toml";
  const databaseUrl = environment["CZAR_DATABASE_URL"];
  if (!databaseUrl) throw new Error("CZAR_DATABASE_URL is required for controlled fixtures.");
  const hostname = new URL(databaseUrl).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    throw new Error("Controlled fixtures require a loopback PostgreSQL host.");
  }
  const config = await loadConfigFile(configPath, {
    env: parameterEnvironment(environment),
  });
  await validateLocalOnlyConfig({
    config,
    overlayPath: configPath,
    arcRpcUrl: environment["CZAR_ARC_RPC_URL"] ?? "http://127.0.0.1:8545",
  });
  return { config, pool: new Pool({ connectionString: databaseUrl }) };
}
