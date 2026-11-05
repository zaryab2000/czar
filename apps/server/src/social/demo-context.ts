import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { cloudPoolOptions, loadConfigFile, parameterEnvironment, type Config } from "@czar/config";
import { assertNoSecretInProcess } from "@czar/signer";
import { Pool } from "pg";
import { assertDemoCommand } from "#src/social/demo-guard";

export interface DemoContext {
  readonly config: Config;
  readonly pool: Pool;
}

/** Open the VM's password-file-backed database only after all demo guards pass. */
export async function openDemoContext(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DemoContext> {
  assertNoSecretInProcess(["node", "demo-command", ...args], environment);
  const configPath = environment["CZAR_CLOUD_CONFIG"];
  if (!configPath) throw new Error("Demo command requires CZAR_CLOUD_CONFIG.");
  const config = await loadConfigFile(configPath, {
    env: parameterEnvironment(environment),
  });
  assertDemoCommand(args, config);

  const databaseUrl = environment["CZAR_DATABASE_URL"];
  if (!databaseUrl) throw new Error("Demo command requires CZAR_DATABASE_URL.");
  const url = new URL(databaseUrl);
  if (url.password || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Demo database URL must use loopback with no password in the URL.");
  }
  const passwordFile = resolve(
    String(config.get("deploy.credentialFilesDir")),
    "server/db-password",
  );
  await access(passwordFile);
  return { config, pool: new Pool(cloudPoolOptions(url, passwordFile)) };
}
