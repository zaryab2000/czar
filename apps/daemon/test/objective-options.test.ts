import { describe, expect, it } from "vitest";
import { parseObjectiveOptions } from "#src/objective-options";

const tags = ["web-search", "page-extract"];
const required = ["Find prices", "--subject", "Acme", "--field", "monthly price"];

describe("manual objective options", () => {
  it("builds a schema-valid TaskSpec with documented defaults", () => {
    const parsed = parseObjectiveOptions(required, tags);
    expect(parsed.capabilities).toEqual(["web-search"]);
    expect(parsed.minutesSaved).toBe(0);
    expect(parsed.hourlyBand).toBe("A");
    expect(parsed.taskSpec).toEqual({
      schemaVersion: "1.1",
      kind: "list-fill",
      topic: "Find prices",
      subjects: [{ label: "Acme" }],
      fields: ["monthly price"],
      sourceTrust: "user-prompt",
    });
  });

  it("preserves repeatable values and accepts an atomic-unit spending limit", () => {
    const parsed = parseObjectiveOptions(
      [...required, "--subject", "Beta", "--capability", "page-extract", "--max-total", "1000000"],
      tags,
    );
    expect(parsed.taskSpec.subjects).toEqual([{ label: "Acme" }, { label: "Beta" }]);
    expect(parsed.capabilities).toEqual(["page-extract"]);
    expect(parsed.maxTotal).toBe("1000000");
  });

  it.each([
    [[], /usage/],
    [["goal"], /subject/],
    [[...required, "--capability", "unknown"], /capability/],
    [[...required, "--max-total", "1.2"], /Amount6/],
    [[...required, "--minutes-saved", "-1"], /nonnegative/],
    [[...required, "--kind", "other"], /kind/],
    [[...required, "--field", "x".repeat(65)], /TaskSpec/],
  ])("rejects malformed or out-of-contract options", (argv, message) => {
    expect(() => parseObjectiveOptions(argv as string[], tags)).toThrow(message as RegExp);
  });

  it("does not echo secret user text in validation errors", () => {
    const secret = "ghp_123456789012345678901234567890123456";
    expect(() => parseObjectiveOptions([secret], tags)).toThrow(/subject/);
    try {
      parseObjectiveOptions([secret], tags);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
