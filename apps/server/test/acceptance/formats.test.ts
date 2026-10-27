import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { runInRestrictedContext } from "#src/acceptance/context";

const config = loadConfig();

const executor = await readFile(
  new URL("../../src/acceptance/executor/checks.js", import.meta.url),
  "utf8",
);

function structuralResult(bodyText: string, outputFormat: string): string {
  const bodyBytes = Buffer.byteLength(bodyText, "utf8");
  const result = runInRestrictedContext(executor, {
    paid: true,
    responseArrived: true,
    statusCode: 200,
    elapsedMs: 1,
    maxTimeoutSeconds: 5,
    bodyText,
    bodyBytes,
    mimeType: outputFormat === "json" ? "application/json" : "text/plain",
    expectedKeys: [],
    deliveredAsIs: true,
    outputFormat,
    parsed: { parseOk: true, value: bodyText },
    schemaState: "absent",
    schemaValid: false,
    shapeHash: null,
    historyShapeHash: null,
    deliveryLimitMs: Number(config.get("acceptance.deliveryTimeoutMs")),
    maxBodyBytes: Number(config.get("acceptance.maxBodyBytes")),
  }) as { name: string; result: string }[];
  return result.find((check) => check.name === "structural")!.result;
}

describe("delivered-as-is output formats", () => {
  it.each([
    [
      "markdown-table",
      "| Name | Price |\n| --- | --- |\n| Ada | 12 |",
      "| Name | Price |\nAda | 12",
    ],
    ["csv", "name,price\nAda,12", 'name,"unterminated'],
    ["json", '{"name":"Ada"}', "{not-json"],
    ["markdown-list", "- item", "plain item"],
    ["prose", "A short result.", " \n "],
  ] as const)("checks %s as a pure format rule", (format, valid, invalid) => {
    expect(structuralResult(valid, format)).not.toBe("fail");
    expect(structuralResult(invalid, format)).toBe("fail");
  });
});
