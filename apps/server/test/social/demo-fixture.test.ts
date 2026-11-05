import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { validateSchema } from "@czar/schemas";
import { evaluateIncidents } from "#src/social/incidents";
import { refreshSupplierCounts } from "#src/selection/ranking/counts";
import { rankingPolicyVersion } from "#src/selection/ranking/decision";
import { orderCandidates } from "#src/selection/ranking/order";
import { buildDemoFixture } from "#src/social/demo-fixture";
import { seedControlledFixtures } from "#src/social/controlled-fixtures";
import { setupDatabase } from "#test/db";
import { createTestContext } from "#test/fixtures";

const pool = setupDatabase();
const now = new Date("2026-11-05T12:00:00Z");
const quickId = `svc_${"a".repeat(32)}`;
const deepId = `svc_${"b".repeat(32)}`;

const supplier = (serviceId: string, payTo: string) => ({
  serviceId,
  payTo,
  resource: { url: `https://merchants.example.com/v1/audit/${serviceId}`, method: "POST" as const },
});

describe("SCR-183 controlled audit history", () => {
  beforeAll(async () => {
    const fixture = buildDemoFixture({
      quick: supplier(quickId, `0x${"1".repeat(40)}`),
      deep: supplier(deepId, `0x${"2".repeat(40)}`),
    });
    await seedControlledFixtures(pool(), fixture, {
      count: 3,
      network: fixture.network,
      consentTextVersion: "1",
      now,
      random: createTestContext(pool()).random,
      versionFor: async () => `ver_${"a".repeat(32)}`,
    });
  });
  it("builds 26 separately rated outcomes for three labelled controlled owners", () => {
    const fixture = buildDemoFixture({
      quick: supplier(`svc_${"a".repeat(32)}`, `0x${"1".repeat(40)}`),
      deep: supplier(`svc_${"b".repeat(32)}`, `0x${"2".repeat(40)}`),
    });
    expect(fixture.network).toBe("eip155:5042002");
    expect(fixture.owners.map((owner) => owner.handle)).toEqual([
      "Rep-CZ01",
      "Rep-CZ02",
      "Rep-CZ03",
    ]);
    expect(
      fixture.owners.every((owner) => owner.controlled && owner.sharing === "structured"),
    ).toBe(true);
    expect(fixture.experiences).toHaveLength(26);
    expect(fixture.experiences.every((item) => validateSchema("task-spec", item.taskSpec))).toBe(
      true,
    );
    expect(fixture.experiences.every((item) => item.observations.length === 1)).toBe(true);

    const count = (supplierKey: string, value: string) =>
      fixture.experiences.filter(
        (item) => item.supplier === supplierKey && item.rating.value === value,
      ).length;
    expect([count("quick", "good"), count("quick", "bad")]).toEqual([18, 2]);
    expect([count("deep", "good"), count("deep", "bad")]).toEqual([5, 1]);
    const recentBad = fixture.experiences.filter(
      (item) => item.rating.value === "bad" && item.observations[0]!.settledDaysAgo <= 14,
    );
    expect(recentBad.map((item) => item.owner).toSorted()).toEqual(["test-three", "test-two"]);
    expect(fixture.noSupplier).toBeUndefined();
  });

  it("starts with A first, B second, and no open incident", async () => {
    const config = loadConfig({ envFile: { "social.incidentsCountControlled": true } });
    const confidenceZ = Number(config.get("selection.confidenceZ"));
    expect(
      await refreshSupplierCounts({
        pool: pool(),
        network: "eip155:5042002",
        policyVersion: rankingPolicyVersion({
          confidenceZ,
          consecutiveFailures: Number(config.get("health.consecutiveFailures")),
        }),
        confidenceZ,
        workerId: "demo-fixture-test",
        leaseSeconds: 30,
        now,
      }),
    ).toBe(true);
    const counts = await pool().query<{
      service_id: string;
      good: number;
      bad: number;
      lower_bound: number;
    }>(
      `SELECT service_id,good,bad,lower_bound FROM supplier_counts
       WHERE task_class='smart-contract-audit' ORDER BY service_id`,
    );
    expect(counts.rows.map(({ service_id, good, bad }) => [service_id, good, bad])).toEqual([
      [quickId, 18, 2],
      [deepId, 5, 1],
    ]);
    const ordered = orderCandidates(
      counts.rows.map((row) => ({
        serviceId: row.service_id,
        versionId: `ver_${"a".repeat(32)}`,
        priceAtomic: "50000",
        good: row.good,
        bad: row.bad,
        lowerBound: row.lower_bound,
        ownersRated: 3,
        ownersBad: 2,
        computedAt: now,
        healthFacts: [],
        injectionBlocked: false,
      })),
      confidenceZ,
      now,
    );
    expect(ordered.ranked.map((row) => row.service_id)).toEqual([quickId, deepId]);
    expect(ordered.unverified).toEqual([]);
    await evaluateIncidents(pool(), config, now);
    const incidents = await pool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM social_incidents WHERE state='open'",
    );
    expect(incidents.rows[0]?.count).toBe("0");
  });
});
