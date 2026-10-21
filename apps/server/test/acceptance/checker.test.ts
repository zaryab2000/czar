import { keccak256 } from "viem";
import { profileId, reportHash } from "@czar/hashing";
import { createLogger } from "@czar/logging";
import { loadConfig } from "@czar/config";
import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createAcceptanceChecker } from "#src/acceptance/index";
import type { AcceptanceCheckInput } from "#src/acceptance/types";
import { setupDatabase } from "#test/db";

const getPool = setupDatabase();
const ADDRESS = "0x1111111111111111111111111111111111111111";
const SERVICE_ID = "svc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROFILE = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
};

async function makeChecker(
  options: {
    readonly config?: ReturnType<typeof loadConfig>;
    readonly outputSchema?: () => Promise<Readonly<Record<string, unknown>> | null>;
    readonly history?: () => Promise<string | null>;
    readonly lines?: string[];
  } = {},
) {
  const checker = await createAcceptanceChecker({
    pool: getPool(),
    config: options.config ?? loadConfig(),
    logger: createLogger({
      service: "server",
      component: "CZ-16",
      sink: (line) => options.lines?.push(line),
    }),
    ports: {
      outputSchema: { forService: options.outputSchema ?? (async () => PROFILE) },
      shapeHistory: { forService: options.history ?? (async () => null) },
      validatorIdentity: { address: async () => ADDRESS },
      clock: { now: () => new Date("2026-10-21T00:00:00.000Z") },
    },
  });
  return checker;
}

function inputFor(
  checker: Awaited<ReturnType<typeof makeChecker>>,
  sequence = 1,
  overrides: Partial<AcceptanceCheckInput> = {},
): AcceptanceCheckInput {
  const profile = checker.profileIdFor("data-json");
  return {
    obsId: "obs_" + String(sequence).padStart(32, "0"),
    profileId: profile,
    envelopeRef: "eip155:5042002:" + ADDRESS + ":1",
    stepIndex: 0,
    serviceId: SERVICE_ID,
    step: {
      stepIndex: 0,
      stepId: "stp_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
      kind: "x402-exact",
      capability: "web-search",
      unitAmount: "1000",
      expectedCalls: 1,
      stepCap: "1000",
      routingReason: "vault-direct",
      acceptanceProfileId: profile,
      inputTemplate: { expectedKeys: ["name"] },
    },
    bodyText: '{"name":"Ada"}',
    statusCode: 200,
    responseArrived: true,
    elapsedMs: 12,
    maxTimeoutSeconds: 5,
    mimeType: "application/json",
    paid: true,
    screen: { available: true, label: "none" },
    ...overrides,
  };
}

describe("acceptance checker", () => {
  it("validates JSON, seeds the data-json profile, and stores a recomputable report", async () => {
    const lines: string[] = [];
    const checker = await makeChecker({ lines });
    const result = await checker.check(inputFor(checker));

    expect(result.report.decision).toBe("pass");
    expect(result.report.checks.map((check) => [check.name, check.result])).toEqual([
      ["delivery", "pass"],
      ["structural", "pass"],
      ["requirement", "pass"],
    ]);
    expect(result.report.reportHash).toBe(reportHash({ ...result.report }));
    const stored = await getPool().query<{
      report: Record<string, unknown>;
      profile_id: string;
      code_hash: string;
    }>(
      "SELECT report, profile_id, method_version AS code_hash FROM acceptance_reports WHERE report_hash=$1",
      [result.report.reportHash],
    );
    expect(stored.rows[0]?.profile_id).toBe(result.report.profile_id);
    expect(reportHash(stored.rows[0]!.report)).toBe(result.report.reportHash);
    const profile = await getPool().query<{ json: Record<string, unknown>; code_hash: string }>(
      'SELECT "json" AS json, code_hash FROM profiles WHERE profile_id=$1',
      [checker.profileIdFor("data-json")],
    );
    expect(profile.rows[0]?.json).toMatchObject({ task_class: "data-json", version: 1 });
    expect(profileId(profile.rows[0]!.json)).toBe(checker.profileIdFor("data-json"));
    const executor = await readFile(
      new URL("../../src/acceptance/executor/checks.js", import.meta.url),
    );
    expect(checker.codeHash).toBe(keccak256(executor));
    expect(profile.rows[0]?.code_hash).toBe(checker.codeHash);
    expect(await checker.getProfileId("data-json")).toBe(checker.profileIdFor("data-json"));
    expect(checker.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(lines.join("\n")).not.toContain("Ada");
  });

  it("fails delivery when the body exceeds acceptance.maxBodyBytes", async () => {
    const checker = await makeChecker({
      config: loadConfig({ envFile: { "acceptance.maxBodyBytes": 12 } }),
    });
    const result = await checker.check(inputFor(checker, 2));
    expect(result.report.decision).toBe("fail");
    expect(result.report.checks[0]).toMatchObject({ name: "delivery", result: "fail" });
  });

  it("keeps no-schema/no-history structural results inconclusive and never passes them", async () => {
    const checker = await makeChecker({
      outputSchema: async () => null,
      history: async () => null,
    });
    const result = await checker.check(inputFor(checker, 3));
    expect(result.report.checks[1]).toMatchObject({
      name: "structural",
      result: "inconclusive",
      detail: { parseOk: true },
    });
    expect(result.report.decision).toBe("inconclusive");
  });

  it("quarantines injection and unavailable screens without running any checks", async () => {
    const schema = vi.fn(async () => PROFILE);
    const history = vi.fn(async () => null);
    const checker = await makeChecker({ outputSchema: schema, history });
    const injection = await checker.check(
      inputFor(checker, 4, { screen: { available: true, label: "injection-suspect" } }),
    );
    const unavailable = await checker.check(inputFor(checker, 5, { screen: { available: false } }));

    expect(injection.report).toMatchObject({
      decision: "inconclusive",
      flags: ["injection-quarantined"],
    });
    expect(unavailable.report).toMatchObject({
      decision: "inconclusive",
      limits: ["no-correctness-check", "screen-unavailable"],
    });
    expect(injection.report.checks.every((check) => check.result === "not_checked")).toBe(true);
    expect(unavailable.report.checks.every((check) => check.result === "not_checked")).toBe(true);
    expect(schema).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  it("never fetches remote schema references", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Test server did not bind a port.");
    try {
      const checker = await makeChecker({
        outputSchema: async () => ({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $ref: "http://127.0.0.1:" + address.port + "/remote-schema.json",
        }),
      });
      const result = await checker.check(inputFor(checker, 6));
      expect(requests).toBe(0);
      expect(result.report.checks[1]).toMatchObject({
        result: "inconclusive",
        detail: { schemaDropped: true },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects output schemas above acceptance.schemaMaxBytes without validating them", async () => {
    const checker = await makeChecker({
      config: loadConfig({ envFile: { "acceptance.schemaMaxBytes": 64 } }),
    });
    const result = await checker.check(inputFor(checker, 13));
    expect(result.report.checks[1]).toMatchObject({
      name: "structural",
      result: "inconclusive",
      detail: { parseOk: true, schemaDropped: true },
    });
    expect(result.report.decision).toBe("inconclusive");
  });

  it("uses the minimum of merchant and configured delivery timeouts", async () => {
    const checker = await makeChecker({
      config: loadConfig({ envFile: { "acceptance.deliveryTimeoutMs": 10 } }),
    });
    const result = await checker.check(inputFor(checker, 7, { elapsedMs: 11 }));
    expect(result.report.checks[0]).toMatchObject({
      result: "fail",
      detail: { reason: "delivery-timeout" },
    });
    expect(result.report.decision).toBe("fail");
  });

  it("reports a missing expected output key as a requirement failure", async () => {
    const checker = await makeChecker();
    const result = await checker.check(inputFor(checker, 8, { bodyText: '{"other":"value"}' }));
    expect(result.report.checks[2]).toMatchObject({ name: "requirement", result: "fail" });
  });

  it("marks delivery not_checked when the step was unpaid", async () => {
    const checker = await makeChecker();
    const result = await checker.check(inputFor(checker, 9, { paid: false }));
    expect(result.report.checks[0]?.result).toBe("not_checked");
    expect(result.report.decision).toBe("inconclusive");
  });

  it("marks a paid attempt with no response as delivery inconclusive", async () => {
    const checker = await makeChecker();
    const result = await checker.check(
      inputFor(checker, 11, { responseArrived: false, statusCode: null, bodyText: null }),
    );
    expect(result.report.checks[0]).toMatchObject({
      name: "delivery",
      result: "inconclusive",
      detail: { reason: "no-response" },
    });
    expect(result.report.decision).toBe("inconclusive");
  });

  it.each([
    { statusCode: 503, bodyText: "{}", reason: "http-status" },
    { statusCode: 200, bodyText: "", reason: "empty-body" },
  ])("fails delivery for status/body edge cases ($reason)", async (scenario) => {
    const checker = await makeChecker();
    const { reason, ...override } = scenario;
    const result = await checker.check(inputFor(checker, 12, override));
    expect(result.report.checks[0]).toMatchObject({
      name: "delivery",
      result: "fail",
      detail: { reason },
    });
  });

  it("turns a sandbox timeout into an inconclusive report with its limit", async () => {
    const checker = await makeChecker({
      config: loadConfig({ envFile: { "acceptance.sandboxTimeoutMs": 1 } }),
    });
    const result = await checker.check(inputFor(checker, 10));
    expect(result.report.decision).toBe("inconclusive");
    expect(result.report.limits).toContain("sandbox-timeout");
  });
});
