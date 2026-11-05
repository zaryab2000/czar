import { loadConfig } from "@czar/config";
import { encodeBase64Json, type SafeFetch } from "@czar/x402";
import { describe, expect, it } from "vitest";
import { runDemoCheck } from "#src/social/demo-check";
import { runDemoSeed } from "#src/social/demo-seed";
import { socialWorkerPass } from "#src/social/worker-main";
import { setupDatabase } from "#test/db";

const pool = setupDatabase();
const now = new Date();
const quickId = `svc_${"a".repeat(32)}`;
const deepId = `svc_${"b".repeat(32)}`;
const network = "eip155:5042002";
const asset = "0x3600000000000000000000000000000000000000";

function registration(name: string) {
  return {
    serviceName: name,
    resource: { url: `https://merchant.example/v1/${name}`, method: "POST" },
    probeInput: { body: { query: "czar probe" } },
    capabilities: ["code-review"],
  };
}

const safeFetch: SafeFetch = async (url) => {
  const resourceUrl = new URL(url).origin + new URL(url).pathname;
  const payTo = resourceUrl.includes("quick") ? `0x${"1".repeat(40)}` : `0x${"2".repeat(40)}`;
  return {
    status: 402,
    url: resourceUrl,
    headers: {
      "payment-required": encodeBase64Json({
        x402Version: 2,
        resource: { url: resourceUrl },
        accepts: [
          {
            scheme: "exact",
            network,
            amount: "50000",
            asset,
            payTo,
            maxTimeoutSeconds: 300,
            extra: {},
          },
        ],
      }),
    },
    body: Buffer.from(""),
  };
};

describe("SCR-183 demo seed command", () => {
  it("refuses to seed before the audit task-class mapping is installed", async () => {
    const config = loadConfig({ envFile: { "selection.paymentNetwork": network } });
    await expect(runDemoSeed(pool(), config, now, safeFetch)).rejects.toThrow(
      "requires SCR-182 code-review audit task-class mapping",
    );
  });

  it("probes both merchants, seeds evidence, and stores A then B as ranked", async () => {
    const config = loadConfig({
      envFile: {
        "selection.paymentNetwork": network,
        "planner.capabilityToTaskClass": { "code-review": "smart-contract-audit" },
        "selection.czarRegisteredServices": {
          [quickId]: registration("czar-audit-quick"),
          [deepId]: registration("czar-audit-deep"),
        },
      },
    });
    await runDemoSeed(pool(), config, now, safeFetch);
    const check = await runDemoCheck(pool(), config);
    expect(check.controlledRepresentatives).toBe(3);
    expect(check.activeClassSubscriptions).toBe(3);
    expect(check.openAuditIncidents).toBe(0);
    expect(check.startingRank).toEqual([quickId, deepId]);
    expect(check.experiencePosts).toBe(0);
    const workerNow = new Date(now.getTime() + 60_000);
    for (let pass = 0; pass < 30; pass += 1) {
      await socialWorkerPass(pool(), config, workerNow);
    }
    const afterWorker = await runDemoCheck(pool(), config);
    expect(afterWorker.experiencePosts).toBe(3);
    expect(afterWorker.passed).toBe(true);
  });
});
