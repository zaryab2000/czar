import { describe, expect, it } from "vitest";
import { sanitizeExtensions } from "@czar/x402";

const info = {
  input: { type: "http", method: "GET" },
  output: { type: "json" },
};

describe("bazaar extension sanitization", () => {
  it("keeps the schema only when the declaration validates", () => {
    const schema = {
      type: "object",
      properties: {
        input: { type: "object" },
        output: { type: "object" },
      },
    };

    expect(sanitizeExtensions({ bazaar: { info, schema } }).bazaar).toEqual({ info, schema });
  });

  it("drops a schema with an external reference", () => {
    const result = sanitizeExtensions({
      bazaar: { info, schema: { $ref: "https://invalid.example/schema.json" } },
    });

    expect(result.bazaar).toBeUndefined();
    expect(result.dropped).toContain("bazaar");
  });

  it("drops a schema larger than the §11.3 limit", () => {
    const schema = { type: "object", description: "x".repeat(8 * 1024) };

    const result = sanitizeExtensions({ bazaar: { info, schema } });

    expect(result.bazaar).toBeUndefined();
    expect(result.dropped).toContain("bazaar");
  });
});
