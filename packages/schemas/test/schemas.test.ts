import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertNoLocalOnly,
  LocalOnlyFieldError,
  privacyClassOf,
  SchemaValidationError,
  schemaMetadata,
  validateObjectiveSubmission,
  validateSchema,
} from "@czar/schemas";
import type { SchemaName } from "@czar/schemas";

const schemaDirectory = new URL(
  "../../../docs/specs/02-data-and-protocol/schemas/",
  import.meta.url,
);
const exampleDirectory = new URL(
  "../../../docs/specs/02-data-and-protocol/examples/",
  import.meta.url,
);
const examples = readdirSync(fileURLToPath(exampleDirectory)).filter((filename) =>
  filename.endsWith(".json"),
);

describe("JSON Schema validators", () => {
  it("compiles every canonical schema", () => {
    expect(schemaMetadata).toHaveLength(
      readdirSync(fileURLToPath(schemaDirectory)).filter((filename) =>
        filename.endsWith(".schema.json"),
      ).length - 1,
    );
  });

  it.each(examples)("validates the %s protocol example", (filename) => {
    const schemaName = exampleSchemaName(filename);
    const value = JSON.parse(readFileSync(new URL(filename, exampleDirectory), "utf8")) as unknown;
    expect(validateSchema(schemaName, value)).toBe(true);
  });

  it("validates the ObjectiveSubmission example and rejects undeclared evidence", () => {
    const example = readExample("objective-submission.example.json") as Record<string, unknown>;
    expect(validateObjectiveSubmission(example)).toBe(true);
    expect(() => assertNoLocalOnly(example)).not.toThrow();
    expect(() => assertNoLocalOnly({ ...example, evidence: [] })).toThrow(SchemaValidationError);
  });

  it("resolves privacy annotations through nested and cross-file references", () => {
    expect(privacyClassOf("objective-submission", "goal")).toBe("redacted-to-server");
    expect(privacyClassOf("objective-submission", "taskSpec.topic")).toBe("redacted-to-server");
    expect(privacyClassOf("receipt", "payment.rail")).toBe("public");
    expect(privacyClassOf("objective", "evidence")).toBe("local-only");
  });

  it("rejects a valid local-only object at the sender boundary", () => {
    const objective = readExample("objective.example.json");
    expect(() => assertNoLocalOnly(objective, "objective")).toThrow(LocalOnlyFieldError);
  });
});

function exampleSchemaName(filename: string): SchemaName {
  const basename = filename.replace(/\.example(?:\.[a-z0-9-]+)?\.json$/, "");
  const schemaName = basename.replace(/\.v(\d+)$/, "-v$1");
  if (!schemaMetadata.some((metadata) => metadata.name === schemaName)) {
    throw new Error(`No schema is registered for example "${filename}".`);
  }
  return schemaName as SchemaName;
}

function readExample(filename: string): unknown {
  return JSON.parse(readFileSync(new URL(filename, exampleDirectory), "utf8")) as unknown;
}
