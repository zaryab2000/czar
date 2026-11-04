import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { serviceVersionId } from "@czar/hashing";
import { readPaymentRequired } from "@czar/x402";
import {
  seedControlledFixtures,
  type ControlledFixture,
  type SupplierFixture,
} from "#src/social/controlled-fixtures";
import { controlledLocalContext } from "#src/social/controlled-local";

function argumentsForSeed(args: string[]): { count: number; network: string } {
  const countIndex = args.indexOf("--count");
  const networkIndex = args.indexOf("--network");
  if (countIndex < 0 || networkIndex < 0 || args.length !== 4) {
    throw new Error("Usage: social:seed-controlled --count 3 --network eip155:5042002");
  }
  const count = Number(args[countIndex + 1]);
  const network = args[networkIndex + 1];
  if (count !== 3 || !network || !/^eip155:[0-9]+$/.test(network)) {
    throw new Error("Controlled fixture requires count 3 and a valid network.");
  }
  return { count, network };
}

async function versionFromBareProbe(
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
  const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5_000) });
  const result = readPaymentRequired({
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
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

/** Seed only after local overlay, loopback DB, and unpaid 402 preflight pass. */
export async function main(args: string[]): Promise<void> {
  const { count, network } = argumentsForSeed(args);
  const { config, pool } = await controlledLocalContext();
  try {
    const fixture = JSON.parse(
      await readFile(
        new URL("../test/social/fixtures/controlled-evidence.json", import.meta.url),
        "utf8",
      ),
    ) as ControlledFixture;
    const origins = config.get("fetch.localMerchantOrigins") as string[];
    await seedControlledFixtures(pool, fixture, {
      count,
      network,
      consentTextVersion: String(config.get("social.consentTextVersion")),
      now: new Date(),
      random: { bytes: randomBytes },
      versionFor: (supplier) => versionFromBareProbe(supplier, network, origins),
    });
    process.stdout.write("Seeded three controlled representatives and fixture evidence.\n");
  } finally {
    await pool.end();
  }
}

await main(process.argv.slice(2));
