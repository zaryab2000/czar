import {
  loadConfigFile,
  parameterEnvironment,
  validateLocalOnlyConfig,
  type Config,
} from "@czar/config";
import { serviceVersionId } from "@czar/hashing";
import { readPaymentRequired } from "@czar/x402";
import { Pool } from "pg";
import type { SupplierFixture } from "#src/social/controlled-fixtures";

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

async function boundedResponseBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > 16 * 1024) {
      await reader.cancel();
      throw new Error("Controlled supplier 402 body exceeds 16 KiB.");
    }
    parts.push(next.value);
  }
  return Buffer.concat(parts, length).toString("utf8");
}

/** Read one unpaid declaration without following redirects or reading an unbounded body. */
export async function versionFromBareProbe(
  supplier: SupplierFixture,
  network: string,
  allowedOrigins: readonly string[],
): Promise<string> {
  const url = new URL(supplier.resource.url);
  if (!allowedOrigins.includes(url.origin) || url.hostname !== "127.0.0.1") {
    throw new Error(`Controlled supplier ${supplier.key} is outside the local allowlist.`);
  }
  for (const [key, value] of Object.entries(supplier.probeInput?.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 402 || new URL(response.url).origin !== url.origin) {
    throw new Error(`Controlled supplier ${supplier.key} did not return a direct 402.`);
  }
  const result = readPaymentRequired({
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await boundedResponseBody(response),
  });
  const offers = result.ok
    ? result.paymentRequired.accepts.filter((offer) => offer.network === network)
    : [];
  if (!result.ok || offers.length !== 1 || result.resource.url !== supplier.resource.url) {
    throw new Error(`Controlled supplier ${supplier.key} did not return one valid bare 402.`);
  }
  return serviceVersionId({
    payTo: offers[0]!.payTo.toLowerCase(),
    resource: supplier.resource,
    schema: result.extensions.bazaar?.schema ?? null,
  });
}
