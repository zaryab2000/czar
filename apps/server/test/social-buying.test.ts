import { describe, expect, it } from "vitest";
import { incidentForSelection, overlayIncidents } from "#src/social/incidents";
import { chooseWithLessons } from "#src/social/lessons";
import { loadConfig } from "@czar/config";

const A = `svc_${"a".repeat(32)}`;
const B = `svc_${"b".repeat(32)}`;
const C = `svc_${"c".repeat(32)}`;
const VERSION = `ver_${"a".repeat(32)}`;

function ranked(serviceId: string, rank: number, score: number) {
  return {
    rank,
    service_id: serviceId,
    version_id: VERSION,
    score,
    features: {},
    evidence_refs: [],
    evidence_age_days: 0,
    missing: [],
    badges: [],
    explanation: "rated",
  };
}

describe("SN-4 routes into buying", () => {
  it("loads the accepted social routing bounds", () => {
    expect(loadConfig().get("social.lessonMaxScoreDelta")).toBe(0.05);
  });
  it("moves an incident below all incident-free rated suppliers without changing scores", () => {
    const rows = [ranked(A, 1, 0.9), ranked(B, 2, 0.8), ranked(C, 3, 0.7)];
    const incidents = [
      {
        incidentId: "inc_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
        serviceId: A,
        versionId: "ver_unknown",
        distinctOwners: 3,
        negativeUnits: 4,
        openedAt: "2026-11-04T00:00:00.000Z",
      },
    ];
    const overlaid = overlayIncidents(rows, incidents);
    expect(overlaid.map((row) => row.service_id)).toEqual([B, C, A]);
    expect(overlaid.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(overlaid[2]?.score).toBe(0.9);
    expect(overlaid[2]?.version_id).toBe(VERSION);
    expect(overlaid[2]?.badges).toContain("incident-open");
    expect(overlaid[2]?.features["incident"]).toEqual({
      incident_id: incidents[0]?.incidentId,
      distinct_owners: 3,
      negative_units: 4,
      opened_at: incidents[0]?.openedAt,
    });
  });

  it("matches an exploration pick against its stored verified version", () => {
    const incident = {
      incidentId: "inc_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
      serviceId: A,
      versionId: VERSION,
      distinctOwners: 3,
      negativeUnits: 3,
      openedAt: "2026-11-04T00:00:00.000Z",
    };
    const choice = {
      ranked: [],
      unverified: [{ service_id: A, version_id: VERSION, reason: "unrated" as const, n_eff: 0 }],
    };
    expect(incidentForSelection(choice, A, [incident])).toEqual(incident);
    expect(
      incidentForSelection(choice, A, [{ ...incident, versionId: `ver_${"b".repeat(32)}` }]),
    ).toBeNull();
  });

  it("applies lessons only within the exact millionth margin and after incident ordering", () => {
    const first = ranked(A, 1, 0.9);
    const atMargin = ranked(B, 2, 0.85);
    const outside = ranked(C, 3, 0.849999);
    const lessons = [
      {
        lessonId: "les_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
        serviceId: A,
        handle: "Rep-ABCD",
        proposition: "avoid" as const,
        taskClass: "search",
        strength: 1,
      },
    ];
    expect(chooseWithLessons([first, atMargin, outside], lessons, 0.05).selected.service_id).toBe(
      B,
    );
    expect(chooseWithLessons([first, outside], lessons, 0.05).selected.service_id).toBe(A);
    expect(chooseWithLessons([first], lessons, 0.05).selected.service_id).toBe(A);
  });
});
