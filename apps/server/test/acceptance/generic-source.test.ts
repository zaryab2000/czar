import { describe, expect, it } from "vitest";
import type { PlannerService } from "#src/planner/ports";
import { createPlannerProfileSource } from "#src/main";

const DATA_PROFILE = `prof_${"a".repeat(32)}`;
const GENERIC_PROFILE = `prof_${"b".repeat(32)}`;

function service(source: string, outputSchema?: Record<string, unknown>): PlannerService {
  return {
    serviceId: `svc_${"a".repeat(32)}`,
    resource: { url: "https://merchant.example/search", method: "GET" },
    accepts: [],
    extensions: {
      czar: {
        claim: { status: "unclaimed" },
        evidence: null,
        source,
        card: outputSchema ? { outputSchema } : {},
      },
    },
  };
}

describe("planner acceptance profile source", () => {
  const source = createPlannerProfileSource({
    profileIdFor(taskClass: string) {
      if (taskClass === "data-json") return DATA_PROFILE;
      if (taskClass === "generic-delivery") return GENERIC_PROFILE;
      throw new RangeError(`Unsupported ${taskClass}`);
    },
  } as never);

  it("uses the generic profile for Circle data without an output schema", () => {
    expect(source.profileIdFor("data-json.search", service("circle-registry"))).toBe(
      GENERIC_PROFILE,
    );
    expect(
      source.profileIdFor("data-json.search", service("circle-registry", { example: {} })),
    ).toBe(GENERIC_PROFILE);
  });

  it("uses task-class schema validation when a Circle output schema is present", () => {
    const schema = { type: "object", required: ["answer"] };
    expect(source.profileIdFor("data-json.search", service("circle-registry", schema))).toBe(
      DATA_PROFILE,
    );
  });

  it("limits generic fallback to Circle candidates", () => {
    expect(() => source.profileIdFor("code-review", service("czar-registered"))).toThrow(
      "Unsupported code-review",
    );
    expect(source.profileIdFor("code-review", service("circle-registry"))).toBe(GENERIC_PROFILE);
  });
});
