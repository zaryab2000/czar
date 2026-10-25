import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "@czar/logging";
import { setupDatabase } from "#test/db";
import {
  makeObjectiveSubmission,
  seedDevice,
  testAppConfig,
  TEST_DEVICE_ID,
  TEST_USER_ID,
} from "#test/fixtures";
import { testSigner } from "#test/payer/test-signer";
import { createLocalServerMain } from "#src/local-main";
import { createPlannerPocketKeySource, createPlannerProfileSource } from "#src/main";

const getPool = setupDatabase();

describe("server composition root", () => {
  it("maps paid planner task classes to the seeded acceptance profile and K4 owner", async () => {
    const profileIdFor = vi.fn((taskClass: string) => {
      if (taskClass !== "data-json") throw new RangeError(`Unsupported ${taskClass}`);
      return "prof_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    });
    const profiles = createPlannerProfileSource({ profileIdFor } as never);
    expect(profiles.profileIdFor("data-json.search")).toBe(profileIdFor("data-json"));
    expect(profiles.profileIdFor("data-json.extract")).toBe(profileIdFor("data-json"));
    expect(() => profiles.profileIdFor("local")).toThrow("local-template-v1 profile ID");

    const address = "0x0000000000000000000000000000000000000005" as const;
    const createPocketKey = vi.fn(async (_caller: string) => address);
    const pocketKeys = createPlannerPocketKeySource({ createPocketKey } as never);
    await expect(pocketKeys.createPocketKey("pln_test")).resolves.toBe(address);
    expect(createPocketKey).toHaveBeenCalledWith("cz-15");
  });

  beforeAll(async () => {
    await seedDevice(getPool());
    await getPool().query("DELETE FROM profiles WHERE task_class='data-json'");
  });

  it("migrates and seeds acceptance before constructing the in-process T-035 signer", async () => {
    const order: string[] = [];
    const logLines: string[] = [];
    const gatewayStatus = vi.fn(async () => "completed" as const);
    const vault = "0x0000000000000000000000000000000000000001" as const;
    const factory = "0x0000000000000000000000000000000000000002" as const;
    const watchContractEvent = vi.fn(() => vi.fn());
    await getPool().query("UPDATE users SET vault=$1 WHERE user_id=$2", [vault, TEST_USER_ID]);
    const signer = Object.assign(await testSigner(), {
      retirePocketKey: vi.fn(async () => ({ destroyAfterMs: 0 })),
    });
    const root = await createLocalServerMain({
      pool: getPool(),
      config: testAppConfig(),
      logger: createLogger({
        service: "server",
        component: "CZ-15",
        sink: (line) => logLines.push(line),
      }),
      modelClient: { complete: vi.fn() },
      publicClient: {
        getBlockNumber: vi.fn(async () => 0n),
        readContract: vi.fn(async () => factory),
        watchContractEvent,
      } as never,
      walletClient: { sendRawTransaction: vi.fn(async () => `0x${"11".repeat(32)}`) } as never,
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
      objects: {
        put: async () => "body-ref",
        get: async () => new Uint8Array(),
        delete: async () => undefined,
      },
      chain: {
        stepUsed: vi.fn(async () => 0n),
        envelopeCapacity: vi.fn(async () => ({ cap: 10_000n, exposure: 0n })),
        reserve: vi.fn(),
        settle: vi.fn(),
        authorizationState: vi.fn(),
        isSettled: vi.fn(),
        finalize: vi.fn(),
      },
      safeFetch: vi.fn(),
      gatewayStatus,
      settlement: { isSettled: async () => false },
      receiptInput: vi.fn(() => ({}) as never),
      rpcUrl: "http://127.0.0.1:8549",
      factoryAddress: "0x0000000000000000000000000000000000000001",
      indexerUrl: "http://127.0.0.1:42069",
      openingLookup: { envelopeByPlanHash: vi.fn(async () => null) },
      revisePlanSubjects: async () => null,
      clock: { now: () => new Date("2026-10-21T00:00:00Z") },
      random: { bytes: (length: number) => Buffer.alloc(length, 7) },
    });

    order.push("http");
    expect(order).toEqual(["signer", "http"]);
    expect(logLines.some((line) => line.includes("planner_volume_source_missing"))).toBe(false);
    expect((await root.app.request("/not-found")).status).toBe(404);
    expect(root.executePayerStep).toBeTypeOf("function");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(watchContractEvent).not.toHaveBeenCalled();
    await getPool().query("UPDATE users SET vault=NULL WHERE user_id=$1", [TEST_USER_ID]);
    await root.close();

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
    await getPool().query(
      `INSERT INTO step_executions(plan_id,step_index,attempt,phase,payload)
       VALUES($1,0,0,'pocket.paid[0]',$2::jsonb)`,
      [planId, JSON.stringify({ nonce: `0x${"11".repeat(32)}`, index: 0, transferId: "tr_1" })],
    );
    const statuses = await root.executePocketNanopayments({
      planId,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      plan: { network: "eip155:5042002" },
      pocket: "0x0000000000000000000000000000000000000005",
      steps: [
        {
          stepIndex: 0,
          kind: "gateway-nano",
          expectedCalls: 1,
          stepCap: "1000",
          callInputs: [{ callIndex: 0, input: {}, subjectIndex: 0 }],
        },
      ] as never,
    });
    expect(statuses).toEqual(["completed"]);
    expect(gatewayStatus).toHaveBeenCalledWith({
      pocket: "0x0000000000000000000000000000000000000005",
      nonce: `0x${"11".repeat(32)}`,
      transferId: "tr_1",
    });
    await expect(
      root.closePocket(
        {
          planId,
          stepIndex: 0,
          attempt: 0,
          vault: "0x0000000000000000000000000000000000000001",
          pocket: "0x0000000000000000000000000000000000000005",
        },
        {
          isClosed: async () => true,
          hasPendingPullback: async () => false,
          writeOffPocket: async () => "writeoff",
          sweepableNativeBalance: async () => 0n,
          pocketBalances: async () => ({ native: 0n, usdc: 0n, gateway: 0n }),
          sendPocketTransaction: async () => "sweep",
        },
      ),
    ).resolves.toMatchObject({ state: "retiring", sweptNative: "0" });
    expect(signer.retirePocketKey).toHaveBeenCalledWith(
      "cz-15",
      "0x0000000000000000000000000000000000000005",
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
