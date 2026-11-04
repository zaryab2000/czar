import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfigFile,
  parameterEnvironment,
  validateLocalOnlyConfig,
  type Config,
} from "@czar/config";
import { Pool } from "pg";
import { consumeSocialBatch } from "#src/social/consumer";
import { runSocialInbox, type RunHooks } from "#src/social/runtime/run";
import { expireQuestions, refreshSubscriptions } from "#src/social/router";

export interface SocialHousekeepingHooks extends RunHooks {
  evaluateIncidents?(pool: Pool, config: Config, now: Date): Promise<void>;
  probeLeads?(pool: Pool, config: Config, now: Date): Promise<void>;
}

/** Open a worker pool whose every connection assumes only the social database role. */
export function createSocialPool(databaseUrl: string, maxConnections: number): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: maxConnections,
    onConnect: async (client) => {
      await client.query("SET ROLE czar_social");
    },
  });
}

/** Execute a bounded consumer and runner pass with no model dependency. */
export async function socialWorkerPass(
  pool: Pool,
  config: Config,
  now: Date,
  hooks: RunHooks = {},
): Promise<void> {
  if (!config.get("social.enabled")) return;
  await consumeSocialBatch(pool, Number(config.get("social.consumerBatch")), config);
  const workers = Number(config.get("social.workerConcurrency"));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      await runSocialInbox(pool, config, { bytes: randomBytes }, now, hooks);
    }),
  );
}

/** Refresh subscriptions and expire questions in one atomic housekeeping transaction. */
export async function socialHousekeepingPass(
  pool: Pool,
  config: Config,
  now: Date,
  hooks: SocialHousekeepingHooks = {},
): Promise<void> {
  if (!config.get("social.enabled")) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await refreshSubscriptions(client, config, now, Number(config.get("social.subscriptionDays")));
    await expireQuestions(client, now);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await hooks.evaluateIncidents?.(pool, config, now);
  await hooks.probeLeads?.(pool, config, now);
}

/** Start the local-only worker after configuration and migration preflight. */
export async function startSocialWorker(hooks: SocialHousekeepingHooks = {}): Promise<void> {
  const configPath = process.env["CZAR_LOCAL_CONFIG"] ?? "../../env/local.toml";
  const databaseUrl = process.env["CZAR_DATABASE_URL"];
  if (!databaseUrl) throw new Error("CZAR_DATABASE_URL is required for the social worker.");
  const config = await loadConfigFile(configPath, {
    env: parameterEnvironment(process.env),
  });
  await validateLocalOnlyConfig({
    config,
    overlayPath: configPath,
    arcRpcUrl: process.env["CZAR_ARC_RPC_URL"] ?? "http://127.0.0.1:8545",
  });
  const pool = createSocialPool(databaseUrl, Number(config.get("social.workerConcurrency")) + 2);
  try {
    await pool.query("SELECT 1 FROM social_inbox LIMIT 1");
    const controller = new AbortController();
    const stop = () => {
      controller.abort();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    let nextHousekeeping = 0;
    while (!controller.signal.aborted) {
      const now = new Date();
      await socialWorkerPass(pool, config, now, hooks);
      if (now.getTime() >= nextHousekeeping) {
        await socialHousekeepingPass(pool, config, now, hooks);
        nextHousekeeping =
          now.getTime() + Number(config.get("social.housekeepingMinutes")) * 60_000;
      }
      await new Promise((done) => setTimeout(done, Number(config.get("social.consumerPollMs"))));
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startSocialWorker();
}
