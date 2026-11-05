import { randomBytes } from "node:crypto";
import type { Config } from "@czar/config";
import { createSafeFetchFromConfig, type SafeFetch } from "@czar/x402";
import type { Pool } from "pg";
import { createRegisteredSelection } from "#src/selection/registered/index";
import { refreshSupplierCounts } from "#src/selection/ranking/counts";
import { rankingPolicyVersion } from "#src/selection/ranking/decision";
import { taskClassFor } from "#src/selection/task-class";
import { seedControlledFixtures, replayControlledFixtures } from "#src/social/controlled-fixtures";
import { auditTaskSpec, buildDemoFixture } from "#src/social/demo-fixture";
import { socialHousekeepingPass } from "#src/social/worker-main";

interface DemoService {
  readonly serviceId: string;
  readonly payTo: string;
  readonly resource: { readonly url: string; readonly method: "POST" };
  readonly versionId: string;
}

/** Resolve a named demo merchant through the registered selection catalog. */
export function serviceIdFor(config: Config, name: string): string {
  const registered = config.get("selection.czarRegisteredServices") as Record<
    string,
    { serviceName?: unknown }
  >;
  const ids = Object.entries(registered)
    .filter(([, value]) => value.serviceName === name)
    .map(([id]) => id);
  if (ids.length !== 1) throw new Error(`Demo needs one registered ${name} service.`);
  return ids[0]!;
}

async function resolveService(
  selection: ReturnType<typeof createRegisteredSelection>,
  pool: Pool,
  serviceId: string,
  probedAt: Date,
): Promise<DemoService> {
  const service = await selection.directory.get(serviceId);
  const offers = service?.accepts.filter((item) => item.network === "eip155:5042002") ?? [];
  if (!service || service.resource.method !== "POST" || offers.length !== 1) {
    throw new Error(`Demo service ${serviceId} needs one verified Arc testnet 402 offer.`);
  }
  const version = await pool.query<{ version_id: string }>(
    `SELECT version_id FROM service_versions
     WHERE network='eip155:5042002' AND service_id=$1 AND last_seen_at=$2`,
    [serviceId, probedAt],
  );
  if (version.rows.length !== 1) {
    throw new Error(`Demo service ${serviceId} has no unique fresh verified version.`);
  }
  return {
    serviceId,
    payTo: offers[0]!.payTo,
    resource: { url: service.resource.url, method: "POST" },
    versionId: version.rows[0]!.version_id,
  };
}

/** Seed controlled evidence through the existing outbox and refresh the starting rank. */
export async function runDemoSeed(
  pool: Pool,
  config: Config,
  now = new Date(),
  safeFetch: SafeFetch = createSafeFetchFromConfig(config, "czar-server/demo-seed"),
): Promise<void> {
  if (taskClassFor("code-review", config) !== "smart-contract-audit") {
    throw new Error("Demo seed requires SCR-182 code-review audit task-class mapping.");
  }
  const selection = createRegisteredSelection({
    config,
    pool,
    safeFetch,
    now: () => now,
  });
  const quick = await resolveService(
    selection,
    pool,
    serviceIdFor(config, "czar-audit-quick"),
    now,
  );
  const deep = await resolveService(selection, pool, serviceIdFor(config, "czar-audit-deep"), now);
  const fixture = buildDemoFixture({ quick, deep });
  const versions = new Map([
    [quick.serviceId, quick.versionId],
    [deep.serviceId, deep.versionId],
  ]);
  await seedControlledFixtures(pool, fixture, {
    count: 3,
    network: fixture.network,
    consentTextVersion: String(config.get("social.consentTextVersion")),
    now,
    random: { bytes: randomBytes },
    versionFor: async (supplier) => versions.get(supplier.serviceId)!,
  });
  await replayControlledFixtures(pool);
  await socialHousekeepingPass(pool, config, now);
  const confidenceZ = Number(config.get("selection.confidenceZ"));
  const refreshed = await refreshSupplierCounts({
    pool,
    network: fixture.network,
    policyVersion: rankingPolicyVersion({
      confidenceZ,
      consecutiveFailures: Number(config.get("health.consecutiveFailures")),
    }),
    confidenceZ,
    workerId: "demo-seed",
    leaseSeconds: Number(config.get("selection.snapshotRefreshSeconds")),
    now,
  });
  if (!refreshed) throw new Error("Demo seed could not acquire the ranking refresh lease.");
  const taskSpec = auditTaskSpec();
  const decision = await selection.rank.rank({
    taskClass: "smart-contract-audit",
    capability: "code-review",
    taskSpec,
    networks: [fixture.network],
    rails: ["x402-exact", "gateway-batched", "erc8183-job"],
    max_price_atomic: String(config.get("planner.defaultMaxUnitAtomic")),
    unknown_policy: "exclude",
  });
  if (
    decision.ranked[0]?.service_id !== quick.serviceId ||
    decision.ranked[1]?.service_id !== deep.serviceId
  ) {
    throw new Error("Demo seed did not produce A first and B second in ranked services.");
  }
}
