import { describe, expect, it } from "vitest";
import { mapCircleInput } from "#src/selection/discovery/circle-input";

function schema(constant: Record<string, unknown>) {
  return {
    body: {
      type: "object",
      required: ["query", "mode"],
      properties: { query: { type: "string" }, mode: constant },
    },
  };
}

function textBody(query: Record<string, unknown>) {
  return {
    body: {
      type: "object",
      required: ["query"],
      properties: { query },
    },
  };
}

describe("SCR-187 CD-08 Circle input schema", () => {
  it("uses one free-text query field and fills other fields from defaults or examples", () => {
    const result = mapCircleInput(
      {
        queryParams: {
          type: "object",
          required: ["query", "limit", "safe"],
          properties: {
            query: { type: "string" },
            limit: { type: "number", default: 5 },
            safe: { type: "boolean", example: false },
            locale: { type: "string", example: "en" },
            ignored: { type: "string" },
          },
        },
      },
      "GET",
    );
    expect(result).toEqual({
      freeTextKey: "query",
      fixedInputs: { limit: 5, safe: false, locale: "en" },
      inputFields: [
        { name: "query", type: "string" },
        { name: "limit", type: "number" },
        { name: "safe", type: "boolean" },
        { name: "locale", type: "string" },
      ],
    });
  });

  it("maps a POST body and accepts a whole-schema example for required constants", () => {
    expect(
      mapCircleInput(
        {
          body: {
            type: "object",
            required: ["prompt", "model", "temperature"],
            example: { model: "small", temperature: 0.2 },
            properties: {
              prompt: { type: "string" },
              model: { type: "string" },
              temperature: { type: "number" },
            },
          },
        },
        "POST",
      ),
    ).toEqual({
      freeTextKey: "prompt",
      fixedInputs: { model: "small", temperature: 0.2 },
      inputFields: [
        { name: "prompt", type: "string" },
        { name: "model", type: "string" },
        { name: "temperature", type: "number" },
      ],
    });
  });

  it("refuses schema-less or unfillable calls", () => {
    expect(mapCircleInput(undefined, "GET")).toBeNull();
    expect(mapCircleInput({ body: { type: "object", properties: {} } }, "GET")).toBeNull();
    expect(
      mapCircleInput(
        {
          body: {
            type: "object",
            required: ["prompt", "format"],
            properties: { prompt: { type: "string" }, format: { type: "string" } },
          },
        },
        "POST",
      ),
    ).toBeNull();
    expect(
      mapCircleInput(
        {
          body: {
            type: "object",
            required: ["prompt", "options"],
            properties: {
              prompt: { type: "string" },
              options: { type: "object", default: { unsafe: true } },
            },
          },
        },
        "POST",
      ),
    ).toBeNull();
    expect(
      mapCircleInput(
        {
          body: {
            type: "object",
            required: ["inputKeys"],
            properties: { inputKeys: { type: "string" } },
          },
        },
        "POST",
      ),
    ).toBeNull();
  });

  it("refuses examples that do not match their declared type or enum", () => {
    expect(mapCircleInput(schema({ type: "boolean", default: "true" }), "POST")).toBeNull();
    expect(
      mapCircleInput(schema({ type: "string", enum: ["fast", "slow"], example: "unsafe" }), "POST"),
    ).toBeNull();
    expect(mapCircleInput(schema({ type: "number", default: Infinity }), "POST")).toBeNull();
  });

  it("refuses unbounded or malformed input keys", () => {
    const properties: Record<string, Record<string, unknown>> = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`field${index}`, { type: "string", default: "x" }]),
    );
    properties["query"] = { type: "string" };
    expect(
      mapCircleInput({ body: { type: "object", required: ["query"], properties } }, "POST"),
    ).toBeNull();
    expect(
      mapCircleInput(
        {
          body: {
            type: "object",
            required: ["query", "bad-key"],
            properties: {
              query: { type: "string" },
              "bad-key": { type: "string", default: "value" },
            },
          },
        },
        "POST",
      ),
    ).toBeNull();
  });

  it("ignores optional fields without examples and never includes example-only extra keys", () => {
    const optional = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`unused${index}`, { type: "object" }]),
    );
    expect(
      mapCircleInput(
        {
          body: {
            type: "object",
            required: ["query", "limit"],
            example: { limit: 3, injected: "must not send" },
            properties: {
              query: { type: "string" },
              limit: { type: "integer" },
              ...optional,
            },
          },
        },
        "POST",
      ),
    ).toEqual({
      freeTextKey: "query",
      fixedInputs: { limit: 3 },
      inputFields: [
        { name: "query", type: "string" },
        { name: "limit", type: "integer" },
      ],
    });
  });

  it("keeps a declared free-text length limit and refuses fixed-choice free text", () => {
    expect(mapCircleInput(textBody({ type: "string", maxLength: 10 }), "POST")).toEqual({
      freeTextKey: "query",
      freeTextMaxLength: 10,
      fixedInputs: {},
      inputFields: [{ name: "query", type: "string" }],
    });
    expect(mapCircleInput(textBody({ type: "string", enum: ["a", "b"] }), "POST")).toBeNull();
    expect(mapCircleInput(textBody({ type: "string", pattern: "^[0-9]+$" }), "POST")).toBeNull();
  });
});
