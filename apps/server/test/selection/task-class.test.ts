// BR-01 / SCR-182 §5: the audit capability has its own task class, so audit evidence stays apart
// from every other kind of code review (SCR-160 §9.1).
import { describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { taskClassFor } from "#src/selection/task-class";

describe("taskClassFor", () => {
  const config = loadConfig();

  it("maps code-review to smart-contract-audit", () => {
    expect(taskClassFor("code-review", config)).toBe("smart-contract-audit");
  });

  it("keeps the existing mappings and the identity for an unmapped capability", () => {
    expect(taskClassFor("web-search", config)).toBe("data-json.search");
    expect(taskClassFor("page-extract", config)).toBe("data-json.extract");
    expect(taskClassFor("translate", config)).toBe("translate");
  });
});
