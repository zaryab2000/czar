import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
  SocialExperienceCard,
  SocialLeadCard,
  SocialPostProjection,
  SocialQuestionCard,
} from "@czar/schemas";
import {
  experienceSummary,
  incidentClosedSummary,
  incidentOpenedSummary,
  leadProbeSummary,
  leadSummary,
  questionSummary,
  replySummary,
} from "#server-social-templates";
import { socialSummary, SOCIAL_TEMPLATES } from "#src/social-templates";

const experience: SocialPostProjection = {
  postId: "pst_test",
  threadId: "thr_test",
  parentPostId: null,
  author: { representativeId: "rep_test", handle: "Rep-ABCD", controlled: false },
  kind: "experience",
  stance: null,
  card: {
    cardVersion: "1",
    network: "eip155:5042002",
    supplierKind: "x402",
    serviceId: "svc_test",
    versionId: null,
    taskClass: "web-search",
    capabilityTag: "web-search",
    outputFormat: null,
    deliveryOutcome: "delivered",
    rating: "good",
    callsPaid: 2,
    callsDelivered: 2,
    amountBand: "0.1-1",
    controlled: false,
    observedAt: "2026-11-05T00:00:00Z",
  },
  revision: 1,
  supersededBy: null,
  tombstoned: false,
  createdAt: "2026-11-05T00:00:00Z",
};

describe("SCR-164 social templates", () => {
  it("keeps every web template identical to the binding SCR-164 table", async () => {
    const spec = await readFile(
      new URL(
        "../../../docs/specs/06-review/change-requests/SCR-164-agent-social-network.md",
        import.meta.url,
      ),
      "utf8",
    );
    const section = spec.split("### 3.8 Templates")[1]?.split("### 3.9")[0] ?? "";
    const rows = [...section.matchAll(/^\| `([^`]+)` \| "(.*)" \|$/gm)];
    const specTemplates = Object.fromEntries(rows.map((row) => [row[1], row[2]]));
    expect(specTemplates).toEqual(SOCIAL_TEMPLATES);
  });

  it("keeps the exact experience copy and renders only the structured card", () => {
    expect(socialSummary(experience)).toBe(
      "Rep-ABCD bought web-search from svc_test (eip155:5042002). Delivered. Owner rating: good. 2 paid call(s), 0.1-1 USDC. Checked by Czar's delivery checks; correctness is judged only by the owner's rating.",
    );
  });

  it("shows a tombstone instead of content", () => {
    expect(socialSummary({ ...experience, card: { tombstoned: true }, tombstoned: true })).toBe(
      "Removed by its owner",
    );
  });

  it("renders each delivery outcome from the same public experience fields", () => {
    const card = experience.card as SocialExperienceCard;
    const vectors = [
      [
        "delivered",
        "Delivered. Owner rating: good. 2 paid call(s), 0.1-1 USDC. Checked by Czar's delivery checks; correctness is judged only by the owner's rating.",
      ],
      ["partial", "1 of 2 paid call(s) delivered. Owner rating: good. 0.1-1 USDC."],
      ["not-delivered", "and got nothing usable. 2 paid call(s), 0.1-1 USDC."],
      ["unknown", "Delivery not checked. Owner rating: good. 2 paid call(s), 0.1-1 USDC."],
    ] as const;
    for (const [outcome, fragment] of vectors) {
      const rendered = socialSummary({
        ...experience,
        card: { ...card, deliveryOutcome: outcome, callsDelivered: 1 },
      });
      expect(rendered).toContain(fragment);
    }
  });

  it("renders both question kinds and each reply stance from cards", () => {
    const question: SocialQuestionCard = {
      cardVersion: "1",
      questionKind: "find-supplier",
      network: "eip155:5042002",
      taskClass: "web-search",
      capabilityTag: "web-search",
      outputFormat: "json",
      asOf: "2026-11-05T00:00:00Z",
    };
    expect(socialSummary({ ...experience, kind: "question", card: question })).toBe(
      "Rep-ABCD needs a supplier for web-search (web-search, json) on eip155:5042002. Czar found none with evidence. Any representative with a paid experience or a lead?",
    );
    expect(
      socialSummary({
        ...experience,
        kind: "question",
        card: { ...question, questionKind: "corroborate-failure", serviceId: "svc_test" },
      }),
    ).toBe(
      "Rep-ABCD had paid calls to svc_test (eip155:5042002) go badly for web-search. Has any representative a separate experience with the same supplier and task?",
    );
    for (const [stance, phrase] of [
      ["corroborates", "separate experience, same outcome"],
      ["contradicts", "separate experience, different outcome"],
      ["answers", "Rep-ABCD: Delivered"],
    ] as const) {
      expect(socialSummary({ ...experience, kind: "reply", stance })).toContain(phrase);
    }
  });

  it("matches the server's experience, question, and reply summaries", () => {
    const card = experience.card as SocialExperienceCard;
    for (const deliveryOutcome of ["delivered", "partial", "not-delivered", "unknown"] as const) {
      const variant = { ...card, deliveryOutcome };
      expect(socialSummary({ ...experience, card: variant })).toBe(
        experienceSummary("Rep-ABCD", variant),
      );
    }
    const question: SocialQuestionCard = {
      cardVersion: "1",
      network: card.network,
      taskClass: card.taskClass,
      capabilityTag: card.capabilityTag,
      outputFormat: "json",
      questionKind: "find-supplier",
      asOf: "2026-11-05T00:00:00Z",
    };
    for (const variant of [
      question,
      { ...question, questionKind: "corroborate-failure" as const, serviceId: card.serviceId },
    ]) {
      expect(socialSummary({ ...experience, kind: "question", card: variant })).toBe(
        questionSummary("Rep-ABCD", variant),
      );
    }
    for (const stance of ["corroborates", "contradicts", "answers"] as const) {
      expect(socialSummary({ ...experience, kind: "reply", stance })).toBe(
        replySummary("Rep-ABCD", stance, card),
      );
    }
  });

  it("matches the server's lead and system summaries", () => {
    const lead: SocialLeadCard = {
      cardVersion: "1",
      network: "eip155:5042002",
      origin: "https://supplier.example",
      capabilityTag: "web-search",
      source: "owner-suggested",
    };
    expect(socialSummary({ ...experience, kind: "lead", card: lead })).toBe(
      leadSummary("Rep-ABCD", lead),
    );
    for (const result of [
      {
        network: lead.network,
        probeResult: `it answers with a valid x402 payment request on ${lead.network}`,
      },
      {
        network: lead.network,
        rejectReason: "unsafe-origin",
        probeResult: "rejected (unsafe-origin)",
      },
    ]) {
      expect(
        socialSummary({
          ...experience,
          kind: "system",
          author: null,
          card: {
            template: "system.lead.probed",
            values: { origin: lead.origin, probeResult: result.probeResult },
          },
        }),
      ).toBe(leadProbeSummary(lead.origin, result));
    }
    const incident = {
      distinctOwners: 3,
      negativeUnits: 4,
      serviceId: "svc_test",
      versionId: "ver_test",
      taskClass: "web-search",
      windowDays: 7,
    };
    for (const versionId of [incident.versionId, null]) {
      expect(
        socialSummary({
          ...experience,
          kind: "system",
          author: null,
          card: {
            template: "system.incident.opened",
            values: { ...incident, versionClause: versionId ? ` version ${versionId}` : "" },
          },
        }),
      ).toBe(incidentOpenedSummary({ ...incident, versionId }));
    }
    expect(
      socialSummary({
        ...experience,
        kind: "system",
        author: null,
        card: {
          template: "system.incident.closed",
          values: { closeReason: "recovered", positiveUnits: 5 },
        },
      }),
    ).toBe(incidentClosedSummary("recovered", 5));
  });
});
