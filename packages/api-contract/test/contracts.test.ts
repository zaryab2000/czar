import { readFileSync, readdirSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as formats from "ajv-formats";
import type { Plugin } from "ajv";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  apiContracts,
  compileContracts,
  resolveReference,
  validateRecordedExchange,
} from "#/index";
import type { ContractDocument } from "#/types";

describe("OpenAPI contracts", () => {
  it("resolves every internal and file reference in both documents", () => {
    expect(() => compileContracts()).not.toThrow();
  });

  it("registers every unique public and local operationId", () => {
    const contracts = compileContracts();
    const ids = [...contracts.keys()];
    expect(ids).toContain("createPayRequest");
    expect(ids).toContain("createQuote");
    expect(ids).toContain("completeModelCall");
    expect(ids).toContain("getJobBrief");
    expect(ids).toContain("getLocalSoul");
    expect(new Set(ids).size).toBe(ids.length);
    for (const [document, filename] of [
      ["public", "openapi.yaml"],
      ["local", "local-openapi.yaml"],
    ] as const) {
      const parsed = load(
        readFileSync(
          new URL(`../../../docs/specs/02-data-and-protocol/api/${filename}`, import.meta.url),
          "utf8",
        ),
      ) as { paths: Record<string, Record<string, { operationId?: string }>> };
      const expected = Object.values(parsed.paths)
        .flatMap((path) =>
          Object.entries(path)
            .filter(([method]) =>
              ["get", "put", "post", "delete", "patch", "options", "head"].includes(method),
            )
            .map(([, operation]) => operation.operationId),
        )
        .filter((id): id is string => typeof id === "string");
      const actual = [...contracts]
        .filter(([, contract]) => contract.document === document)
        .map(([id]) => id);
      expect(actual.toSorted()).toEqual(expected.toSorted());
    }
  });

  it("keeps MCP pay and quote schemas compatible with their route schemas", () => {
    const docs = readFileSync(
      new URL("../../../docs/specs/02-data-and-protocol/mcp/czar-mcp-tools.md", import.meta.url),
      "utf8",
    );
    for (const [heading, operationId, component, requestFixture, responseFixture] of [
      [
        "### 2.3 `quote`",
        "createQuote",
        "QuoteRequest",
        { capability: "test" },
        {
          quoteId: "qte_00000000000000000000000000",
          planId: "pln_00000000000000000000000000",
          stepIndex: 0,
          kind: "x402-exact",
          unitAmount: "1",
          expectedCalls: 1,
          stepCap: "1",
          routingReason: "test",
          approvalNeeded: false,
          expiresAt: "2026-10-21T00:00:00Z",
        },
      ],
      [
        "### 2.4 `pay`",
        "createPayRequest",
        "PayRequest",
        {
          payRequestId: `prq_${"a".repeat(32)}`,
          idempotencyKey: "00000000-0000-4000-8000-000000000000",
          objectiveId: "obj_00000000000000000000000000",
          planId: "pln_00000000000000000000000000",
          stepIndex: 0,
        },
        { payRequestId: `prq_${"a".repeat(32)}`, status: "accepted" },
      ],
    ] as const) {
      const start = docs.indexOf(heading);
      const end = docs.indexOf("\n### ", start + heading.length);
      const section = docs.slice(start, end < 0 ? undefined : end);
      const blocks = [...section.matchAll(/```json\s*([\s\S]*?)```/g)].map((match) => match[1]!);
      expect(blocks).toHaveLength(2);
      const mcpRequest = JSON.parse(blocks[0]!) as object;
      const mcpResponse = JSON.parse(blocks[1]!) as object;
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      const addFormats = formats.default as unknown as Plugin<undefined>;
      addFormats(ajv);
      const schemaDirectory = new URL(
        "../../../docs/specs/02-data-and-protocol/schemas/",
        import.meta.url,
      );
      for (const filename of readdirSync(schemaDirectory).filter((name) =>
        name.endsWith(".schema.json"),
      )) {
        ajv.addSchema(
          JSON.parse(readFileSync(new URL(filename, schemaDirectory), "utf8")) as object,
        );
      }
      const route = apiContracts.get(operationId);
      const mcpRequestValidator = ajv.compile(mcpRequest);
      const mcpResponseValidator = ajv.compile(mcpResponse);
      expect(route?.request?.(requestFixture)).toBe(true);
      expect(mcpRequestValidator(requestFixture)).toBe(true);
      expect(route?.request?.({ ...requestFixture, category: "forbidden" })).toBe(false);
      expect(mcpRequestValidator({ ...requestFixture, category: "forbidden" })).toBe(false);
      expect(route?.responses.get("200")?.(responseFixture)).toBe(true);
      expect(mcpResponseValidator(responseFixture)).toBe(true);
      expect(route?.responses.get("200")?.({ ...responseFixture, category: "forbidden" })).toBe(
        false,
      );
      expect(mcpResponseValidator({ ...responseFixture, category: "forbidden" })).toBe(false);
      expect(resolveReference(`#/components/schemas/${component}`)).toBeDefined();
    }
  });

  it("uses the canonical objective status enum", () => {
    const schema = resolveReference("#/components/schemas/ObjectiveStatusValue") as {
      enum: string[];
    };
    expect(schema.enum).toContain("opening");
    expect(schema.enum).not.toContain("approved");
  });

  it("validates completeModelCall replay-not-stored errors as 409", () => {
    const response = apiContracts.get("completeModelCall")?.responses.get("409");
    expect(response).toBeDefined();
    expect(
      response?.({
        type: "about:blank",
        title: "Conflict",
        status: 409,
        czarCode: "replay-not-stored",
        retryable: false,
      }),
    ).toBe(true);
  });

  it("validates getJobBrief using its external job-brief schema", () => {
    expect(apiContracts.get("getJobBrief")?.responses.get("200")).toBeDefined();
  });

  it("validates a recorded exchange and reports request and response errors", () => {
    const result = validateRecordedExchange("createPayRequest", {
      requestBody: { invalid: true },
      responseStatus: 200,
      responseBody: { invalid: true },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.startsWith("request"))).toBe(true);
    expect(result.errors.some((error) => error.startsWith("response"))).toBe(true);
  });

  it("accepts declared empty responses and rejects undeclared status codes", () => {
    expect(validateRecordedExchange("deletePushSubscription", { responseStatus: 204 }).valid).toBe(
      true,
    );
    expect(
      validateRecordedExchange("deletePushSubscription", {
        responseStatus: 204,
        responseBody: {},
      }).valid,
    ).toBe(false);
    expect(validateRecordedExchange("deletePushSubscription", { responseStatus: 299 }).valid).toBe(
      false,
    );
  });

  it.each([
    ["public", "openapi.yaml"],
    ["local", "local-openapi.yaml"],
  ] as const satisfies readonly (readonly [ContractDocument, string])[])(
    "can load and report the %s contract document (%s)",
    (_kind, filename) => {
      expect(
        readFileSync(
          new URL(`../../../docs/specs/02-data-and-protocol/api/${filename}`, import.meta.url),
          "utf8",
        ),
      ).toContain("openapi: 3.1.0");
    },
  );
});
