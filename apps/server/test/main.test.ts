import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { createLogger } from "@czar/logging";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_DEVICE_ID, TEST_USER_ID } from "#test/fixtures";
import { testSigner } from "#test/payer/test-signer";
import { createServerMain } from "#src/main";

const getPool = setupDatabase();

describe("server composition root", () => {
  beforeAll(async () => {
    await seedDevice(getPool());
    await getPool().query("DELETE FROM profiles WHERE task_class='data-json'");
  });

  it("migrates and seeds acceptance before constructing the in-process T-035 signer", async () => {
    const order: string[] = [];
    const signer = await testSigner();
    const root = await createServerMain({
      pool: getPool(),
      config: loadConfig(),
      logger: createLogger({ service: "server", component: "CZ-15", sink: () => undefined }),
      modelClient: { complete: vi.fn() },
      createSigner: async () => {
        const profiles = await getPool().query(
          "SELECT profile_id FROM profiles WHERE task_class='data-json'",
        );
        expect(profiles.rowCount).toBe(1);
        order.push("signer");
        return signer;
      },
      acceptancePorts: {
        outputSchema: { forService: async () => null },
        shapeHistory: { forService: async () => null },
        validatorIdentity: {
          address: async () => "0x0000000000000000000000000000000000000007",
        },
        clock: { now: () => new Date("2026-10-21T00:00:00Z") },
      },
      objects: { put: async () => "body-ref", get: async () => new Uint8Array() },
      chain: {
        reserve: vi.fn(),
        settle: vi.fn(),
        authorizationState: vi.fn(),
        isSettled: vi.fn(),
        finalize: vi.fn(),
      },
      safeFetch: vi.fn(),
      settlement: { isSettled: async () => false },
      receiptInput: vi.fn(() => ({}) as never),
      clock: { now: () => new Date("2026-10-21T00:00:00Z") },
      random: { bytes: (length: number) => Buffer.alloc(length, 7) },
    });

    order.push("http");
    expect(order).toEqual(["signer", "http"]);
    expect((await root.app.request("/not-found")).status).toBe(404);
    expect(root.executePayerStep).toBeTypeOf("function");

    const objective = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y");
    const planId = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
    await getPool().query(
      `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state)
       VALUES ($1,$2,$3,$4::jsonb,$5,'received')`,
      [
        objective.objectiveId,
        TEST_USER_ID,
        TEST_DEVICE_ID,
        JSON.stringify(objective),
        objective.objectiveHash,
      ],
    );
    await getPool().query(
      `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
       VALUES ($1,$2,'{}',$3,$4,'offered')`,
      [planId, objective.objectiveId, `0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`],
    );
    await getPool().query(
      "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,'{}','queued')",
      [planId],
    );
    const payerResult = await root.executePayerStep({
      planId,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      envelopeId: 1n,
      envelopeExpiresAt: new Date("2026-10-22T00:00:00Z"),
      vault: "0x0000000000000000000000000000000000000001",
      plan: {} as never,
      step: {
        stepIndex: 0,
        stepId: "stp_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
        kind: "local",
        capability: "summarize",
        unitAmount: "0",
        expectedCalls: 0,
        stepCap: "0",
        routingReason: "local-template",
        acceptanceProfileId: "prof_00000000000000000000000000000000",
      },
      userId: TEST_USER_ID,
      deviceId: TEST_DEVICE_ID,
    });
    expect(payerResult).toMatchObject({ state: "handed_off" });
    await expect(
      getPool().query("SELECT state FROM steps WHERE plan_id=$1 AND step_index=0", [planId]),
    ).resolves.toMatchObject({ rows: [{ state: "handed_off" }] });
  });
});
