import { loadConfig } from "@czar/config";
import { describe, expect, it } from "vitest";
import { runSandboxedChecks, type SandboxInput } from "#src/acceptance/sandbox";

const input: SandboxInput = {
  paid: true,
  responseArrived: true,
  statusCode: 200,
  elapsedMs: 1,
  maxTimeoutSeconds: 5,
  bodyText: "{}",
  bodyBytes: 2,
  mimeType: "application/json",
  expectedKeys: [],
  historyShapeHash: null,
  deliveredAsIs: false,
};

const config = loadConfig({ envFile: { "acceptance.sandboxTimeoutMs": 2_000 } });

describe("acceptance sandbox worker", () => {
  it("terminates an infinite check and isolates memory exhaustion from the server", async () => {
    const looping = await runSandboxedChecks({
      executorSource: "globalThis.runAcceptanceChecks = () => { while (true) {} };",
      input,
      outputSchema: null,
      config,
    });
    expect(looping.timedOut).toBe(true);
    expect(looping.limits).toEqual(["sandbox-timeout"]);
    expect(looping.checks.every((check) => check.result === "inconclusive")).toBe(true);

    const allocating = await runSandboxedChecks({
      executorSource:
        "globalThis.runAcceptanceChecks = () => { const chunks = []; while (true) chunks.push(new Array(200000).fill(chunks.length)); };",
      input,
      outputSchema: null,
      config,
    });
    expect(allocating.timedOut).toBe(true);
    expect(allocating.limits).toEqual(["sandbox-timeout"]);
    expect(allocating.checks.every((check) => check.result === "inconclusive")).toBe(true);

    const recovered = await runSandboxedChecks({
      executorSource:
        "globalThis.runAcceptanceChecks = () => [{name:'delivery',result:'pass'},{name:'structural',result:'pass'},{name:'requirement',result:'not_checked'}];",
      input,
      outputSchema: null,
      config,
    });
    expect(recovered.timedOut).toBe(false);
    expect(recovered.checks).toHaveLength(3);
  });
});
