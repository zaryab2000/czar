// BR-01 / SCR-182 §5, §6: the planner knows the audit capability.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig, PARAMETERS } from "@czar/config";

describe("planner keys for the audit capability (SCR-182)", () => {
  const config = loadConfig();

  it("maps code-review to the smart-contract-audit task class", () => {
    const mapping = config.get("planner.capabilityToTaskClass") as Record<string, string>;
    expect(mapping["code-review"]).toBe("smart-contract-audit");
    // The existing mappings are untouched.
    expect(mapping["web-search"]).toBe("data-json.search");
    expect(mapping["page-extract"]).toBe("data-json.extract");
  });

  it("gives code-review a spending category the owner already has limits for", () => {
    const mapping = config.get("planner.categoryByCapability") as Record<string, string>;
    expect(mapping["code-review"]).toBe("research");
  });

  it("caps a paid-call input at 1000 characters, and 2000 for code-review", () => {
    expect(config.get("planner.inputMaxChars")).toEqual({ default: 1000, "code-review": 2000 });
  });

  it("registers planner.inputMaxChars as an object parameter with a source and a reason", () => {
    const spec = PARAMETERS.find((parameter) => parameter.key === "planner.inputMaxChars");
    expect(spec?.type).toBe("object");
    expect(spec?.unit).toBe("chars");
    expect(spec?.source).toContain("SCR-182");
    expect(spec?.reason).not.toBe("");
  });

  it("keeps the audit input cap equal to the longest taskSpec.context the schema allows", () => {
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../docs/specs/02-data-and-protocol/schemas/task-spec.schema.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ) as { properties: { context: { maxLength: number } } };
    const caps = config.get("planner.inputMaxChars") as Record<string, number>;
    expect(caps["code-review"]).toBe(schema.properties.context.maxLength);
  });
});
