import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { orderCandidates } from "#src/selection/ranking/order";

const versionId = `ver_${"a".repeat(32)}`;
const worked = JSON.parse(
  readFileSync(new URL("../fixtures/worked-example.json", import.meta.url), "utf8"),
) as {
  suppliers: Array<{ serviceId: string; good: number; bad: number }>;
  afterCorrection: { good: number; bad: number };
};
const candidate = (letter: string, good: number, bad: number) => ({
  serviceId: `svc_${letter.repeat(32)}`,
  versionId,
  priceAtomic: "25",
  good,
  bad,
  ownersRated: good + bad > 0 ? 1 : 0,
  ownersBad: bad > 0 ? 1 : 0,
  computedAt: new Date("2026-10-31T00:00:00Z"),
  healthFacts: [] as string[],
  injectionBlocked: false,
});

describe("SCR-160 registered ranking", () => {
  it("reproduces the worked order, correction, H1, and H4 cases", () => {
    const m1 = { ...candidate("a", 5, 0), ...worked.suppliers[0] };
    const m2 = { ...candidate("b", 9, 1), ...worked.suppliers[1] };
    const m3 = { ...candidate("c", 0, 0), ...worked.suppliers[2] };
    const first = orderCandidates([m1, m2, m3], 1.959964);
    expect(first.ranked.map((row) => row.service_id)).toEqual([m2.serviceId, m1.serviceId]);
    expect(first.ranked.map((row) => row.score)).toEqual([
      expect.closeTo(0.5958, 4),
      expect.closeTo(0.5655, 4),
    ]);
    expect(first.unverified).toEqual([{ service_id: m3.serviceId, reason: "unrated", n_eff: 0 }]);

    const corrected = orderCandidates([m1, { ...m2, ...worked.afterCorrection }, m3], 1.959964);
    expect(corrected.ranked.map((row) => row.service_id)).toEqual([m1.serviceId, m2.serviceId]);

    const flagged = orderCandidates(
      [{ ...m1, healthFacts: ["settled-not-delivered"] }, { ...m2, ...worked.afterCorrection }, m3],
      1.959964,
    );
    expect(flagged.ranked[0]?.badges).toContain("health-flagged");
    expect(flagged.ranked[0]?.features).toMatchObject({
      health_facts: ["settled-not-delivered"],
    });

    const blocked = orderCandidates([m1, { ...m2, injectionBlocked: true }, m3], 1.959964);
    expect(blocked.ranked.map((row) => row.service_id)).toEqual([m1.serviceId]);
    expect(blocked.excluded).toContainEqual({
      service_id: m2.serviceId,
      gate: "health-blocked",
      detail: "injection-blocked",
    });
  });

  it("uses live price then service id as exact-score ties and explains owner evidence", () => {
    const a = candidate("a", 2, 0);
    const b = { ...candidate("b", 2, 0), priceAtomic: "20", ownersRated: 2 };
    const c = { ...candidate("c", 2, 0), priceAtomic: "20" };
    const ordered = orderCandidates([c, a, b], 1.959964);
    expect(ordered.ranked.map((row) => row.service_id)).toEqual([
      b.serviceId,
      c.serviceId,
      a.serviceId,
    ]);
    expect(ordered.ranked[0]?.explanation).toBe("2 owners rated it: 2 good, 0 bad.");
    expect(ordered.ranked[1]?.explanation).toBe("2 rating(s) from people who paid: 2 good, 0 bad.");
  });

  it("keeps unrated health facts for planner approval without schema-invalid badges", () => {
    const unrated = { ...candidate("a", 0, 0), healthFacts: ["job-failed"] };
    const ordered = orderCandidates([unrated], 1.959964);
    expect(ordered.unverified).toEqual([
      { service_id: unrated.serviceId, reason: "unrated", n_eff: 0 },
    ]);
    expect(ordered.ranked).toEqual([]);
  });
});
