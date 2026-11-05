import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARC_TESTNET_CHAIN_ID,
  cloudPoolOptions,
  loadConfigFile,
  parameterEnvironment,
  validateCloudConfig,
} from "@czar/config";
import { assertNoSecretInProcess } from "@czar/signer";
import { Pool } from "pg";
import { createPublicClient, http } from "viem";
import {
  socialWorkerHooks,
  socialWorkerPass,
  runScheduledSocialHousekeeping,
} from "#src/social/worker-main";

const CONFIG_POINTER = "CZAR_CLOUD_CONFIG";
const DATABASE_POINTER = "CZAR_DATABASE_URL";
const RPC_POINTER = "CZAR_ARC_RPC_URL";

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`refusing to start: ${name} is not set`);
  return value;
}

/** Start the code-only social worker with cloud guards and file-backed database credentials. */
export async function startCloudSocialWorker(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  assertNoSecretInProcess(process.argv, env);
  const config = await loadConfigFile(required(env, CONFIG_POINTER), {
    env: parameterEnvironment(env),
  });
  const databaseUrl = required(env, DATABASE_POINTER);
  const rpcUrl = required(env, RPC_POINTER);
  validateCloudConfig({
    config,
    role: "server",
    chainId: ARC_TESTNET_CHAIN_ID,
    rpcUrls: [rpcUrl],
  });
  const url = new URL(databaseUrl);
  if (url.password) throw new Error(`refusing to start: ${DATABASE_POINTER} carries a password`);
  if (url.username !== "czar_api")
    throw new Error(`refusing to start: ${DATABASE_POINTER} must use czar_api`);
  const passwordFile = resolve(
    String(config.get("deploy.credentialFilesDir")),
    "social-worker",
    "db-password",
  );
  try {
    await access(passwordFile, constants.R_OK);
  } catch {
    throw new Error("refusing to start: social-worker/db-password is missing or unreadable");
  }
  const chainId = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
  validateCloudConfig({ config, role: "server", chainId, rpcUrls: [rpcUrl] });
  const pool = new Pool({
    ...cloudPoolOptions(url, passwordFile),
    max: Number(config.get("social.workerConcurrency")) + 2,
    onConnect: async (client) => {
      await client.query("SET ROLE czar_social");
    },
  });
  try {
    await pool.query("SELECT 1 FROM social_inbox LIMIT 1");
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const schedule = { nextHousekeepingAt: 0, nextIncidentAt: 0 };
    while (!controller.signal.aborted) {
      const now = new Date();
      await socialWorkerPass(pool, config, now, socialWorkerHooks);
      await runScheduledSocialHousekeeping(pool, config, now, schedule, socialWorkerHooks);
      await new Promise((done) => setTimeout(done, Number(config.get("social.consumerPollMs"))));
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startCloudSocialWorker();
}
