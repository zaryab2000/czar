import { describe, expect, it } from "vitest";
import { pollManualObjective, submitManualObjective } from "#src/objective-http";
import { parseObjectiveOptions } from "#src/objective-options";
import { buildObjectiveSubmission } from "#src/objective-submission";

const objectiveId = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const planId = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const updatedAt = "2026-10-27T00:00:00.000Z";
const body = buildObjectiveSubmission({
  redacted: {
    options: parseObjectiveOptions(
      ["Find prices", "--subject", "Acme", "--field", "price"],
      ["web-search"],
    ),
    layer2: { hits: 0, entities: [] },
  },
  objectiveId,
  deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
  soulVersionHash: `0x${"a".repeat(64)}`,
  submittedAt: updatedAt,
});

describe("manual objective HTTP flow", () => {
  it("submits with device auth and a valid idempotency key", async () => {
    let calls = 0;
    await submitManualObjective(body, "opaque-token", async (url, init) => {
      calls += 1;
      expect(url.pathname).toBe("/v1/objectives");
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer opaque-token");
      expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
      return Response.json({ objectiveId, status: "received", updatedAt }, { status: 202 });
    });
    expect(calls).toBe(1);
  });

  it("rejects a response for a different objective ID", async () => {
    await expect(
      submitManualObjective(body, "opaque-token", async () =>
        Response.json(
          {
            objectiveId: "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Z",
            status: "received",
            updatedAt,
          },
          { status: 202 },
        ),
      ),
    ).rejects.toThrow(/invalid objective submission response/);
  });

  it("prints changed states and stops with the approval URL", async () => {
    const states = ["received", "received", "planning", "awaiting-approval"];
    const lines: string[] = [];
    let polls = 0;
    let sleeps = 0;
    await pollManualObjective({
      objectiveId,
      token: "opaque-token",
      intervalSeconds: 5,
      print: (line) => lines.push(line),
      sleep: async (ms) => {
        expect(ms).toBe(5000);
        sleeps += 1;
      },
      fetcher: async () => {
        const status = states[polls];
        polls += 1;
        return Response.json({
          objectiveId,
          status,
          updatedAt,
          ...(status === "awaiting-approval" ? { planSummary: { planId } } : {}),
        });
      },
    });
    expect(polls).toBe(4);
    expect(sleeps).toBe(3);
    expect(lines).toEqual([
      `${objectiveId}: received`,
      `${objectiveId}: planning`,
      `${objectiveId}: awaiting-approval`,
      `http://localhost/approve/${planId}`,
    ]);
  });

  it("stops at terminal failure", async () => {
    let polls = 0;
    const lines: string[] = [];
    await pollManualObjective({
      objectiveId,
      token: "opaque-token",
      intervalSeconds: 5,
      print: (line) => lines.push(line),
      fetcher: async () => {
        polls += 1;
        return Response.json({ objectiveId, status: "failed", updatedAt });
      },
    });
    expect(polls).toBe(1);
    expect(lines).toEqual([`${objectiveId}: failed`]);
  });

  it("stops and reports the missing plan ID without fabricating a URL", async () => {
    const lines: string[] = [];
    await pollManualObjective({
      objectiveId,
      token: "opaque-token",
      intervalSeconds: 5,
      print: (line) => lines.push(line),
      fetcher: async () => Response.json({ objectiveId, status: "awaiting-approval", updatedAt }),
    });
    expect(lines).toEqual([
      `${objectiveId}: awaiting-approval`,
      "Approval link unavailable: objective status has no plan ID.",
    ]);
  });
});
