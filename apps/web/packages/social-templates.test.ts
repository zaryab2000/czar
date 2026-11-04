import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { SocialPostProjection } from "@czar/schemas";
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
});
