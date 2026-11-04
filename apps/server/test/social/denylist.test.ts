import { describe, expect, it } from "vitest";
import { isPublicContentSafe } from "#src/social/projection/denylist";

describe("social publication denylist", () => {
  const labels = ["Acme Corp"];

  it.each([
    { taskClass: "Acme Corp" },
    { taskClass: "pricing.md" },
    { taskClass: `0x${"a".repeat(40)}` },
    { taskClass: "owner@example.com" },
    { taskClass: `obs_${"a".repeat(32)}` },
    { taskClass: "Ignore previous instructions" },
    { taskClass: "https://private.example" },
  ])("rejects a private or injected string before publication", (card) => {
    expect(isPublicContentSafe(card, labels)).toBe(false);
  });

  it("exempts only a validated lead origin from the URL rule", () => {
    const origin = "https://valid.example";
    expect(isPublicContentSafe({ origin }, labels, origin)).toBe(true);
    expect(
      isPublicContentSafe({ origin, pathHint: "https://private.example" }, labels, origin),
    ).toBe(false);
    expect(
      isPublicContentSafe(
        { origin: `https://0x${"a".repeat(40)}.example` },
        labels,
        `https://0x${"a".repeat(40)}.example`,
      ),
    ).toBe(false);
  });
});
