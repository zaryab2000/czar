import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { seedControlledFixtures, type ControlledFixture } from "#src/social/controlled-fixtures";
import { controlledLocalContext, versionFromBareProbe } from "#src/social/controlled-local";

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
