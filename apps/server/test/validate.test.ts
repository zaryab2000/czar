import { describe, expect, it } from "vitest";
import { resolveReference } from "@czar/api-contract";
import {
  CURSOR_MAX_LENGTH,
  OBJECTIVE_ID_PATTERN,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  PAGE_LIMIT_MIN,
  OBJECTIVE_STATUS_VALUES,
} from "#src/http/validate";

describe("request parameter constants", () => {
  it("params_matchOpenApi", () => {
    const limit = resolveReference("#/components/parameters/Limit") as {
      schema: { minimum: number; maximum: number; default: number };
    };
    const cursor = resolveReference("#/components/parameters/Cursor") as {
      schema: { maxLength: number };
    };
    const status = resolveReference("#/components/schemas/ObjectiveStatusValue") as {
      enum: string[];
    };
    const path = resolveReference("#/paths/~1v1~1objectives~1{objectiveId}/get/parameters/0") as {
      schema: { pattern: string };
    };
    expect(PAGE_LIMIT_MIN).toBe(limit.schema.minimum);
    expect(PAGE_LIMIT_MAX).toBe(limit.schema.maximum);
    expect(PAGE_LIMIT_DEFAULT).toBe(limit.schema.default);
    expect(CURSOR_MAX_LENGTH).toBe(cursor.schema.maxLength);
    expect(OBJECTIVE_STATUS_VALUES).toEqual(status.enum);
    expect(OBJECTIVE_ID_PATTERN).toBe(path.schema.pattern);
  });
});
