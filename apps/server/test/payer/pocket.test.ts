import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculatePocketFunding,
  drainPocketsAfterHalt,
  executePocketPreparation,
  payGatewaySteps,
  refreshGatewayStatuses,
  readPlanPocketKey,
  sweepAndRetirePocketKey,
} from "#src/payer/pocket";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";
import { loadConfig } from "@czar/config";
import { buildTree, pocketLeaf } from "@czar/hashing";
import { buildPaymentRequired, encodePaymentRequired } from "@czar/x402";

const getPool = setupDatabase();
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const POCKET = "0x0000000000000000000000000000000000000001";

beforeAll(async () => {
  await seedDevice(getPool());
  const submission = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y");
  await getPool().query(
    `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state)
     VALUES ($1,$2,$3,$4::jsonb,$5,'received') ON CONFLICT (objective_id) DO NOTHING`,
    [
      submission.objectiveId,
      TEST_USER_ID,
      submission.deviceId,
      JSON.stringify(submission),
      submission.objectiveHash,
    ],
  );
  await getPool().query(
    `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES ($1,$2,'{}',$3,$4,'offered') ON CONFLICT (plan_id) DO NOTHING`,
    [PLAN_ID, submission.objectiveId, `0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`],
  );
});

beforeEach(async () => {
  await getPool().query("DELETE FROM step_executions");
  await getPool().query("DELETE FROM plan_pocket_keys WHERE plan_id=$1", [PLAN_ID]);
  await getPool().query("DELETE FROM plan_pocket_keys WHERE lower(pocket_address)=lower($1)", [
    POCKET,
  ]);
  await getPool().query("DELETE FROM steps WHERE plan_id=$1", [PLAN_ID]);
  await getPool().query(
    "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,'{}','queued')",
    [PLAN_ID],
  );
});

describe("pocket funding", () => {
  it("drains every funded pocket when frozen or guardian-paused", async () => {
    const pullback = vi.fn(async (pocket: string) => pocket);
    const listFundedPockets = vi.fn(
      async () =>
        [
          "0x0000000000000000000000000000000000000001",
          "0x0000000000000000000000000000000000000002",
        ] as const,
    );
    await expect(
      drainPocketsAfterHalt(
        { vault: "0x0000000000000000000000000000000000000003", event: "Frozen" },
        { listFundedPockets, pullback },
      ),
    ).resolves.toEqual([
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
    ]);
    expect(listFundedPockets).toHaveBeenCalledOnce();
    expect(pullback).toHaveBeenCalledTimes(2);
  });

  it("continues draining funded pockets after one pullback failure", async () => {
    const pulls: string[] = [];
    await expect(
      drainPocketsAfterHalt(
        { vault: "0x0000000000000000000000000000000000000003", event: "Frozen" },
        {
          listFundedPockets: async () => [
            "0x0000000000000000000000000000000000000001",
            "0x0000000000000000000000000000000000000002",
          ],
          pullback: async (pocket) => {
            pulls.push(pocket);
            if (pocket.endsWith("01")) throw new Error("fixture failure");
          },
        },
      ),
    ).rejects.toThrow("failed for 1 funded pocket(s)");
    expect(pulls).toHaveLength(4);
  });

  it("retries only the pockets whose halt pullback failed", async () => {
    const first = "0x0000000000000000000000000000000000000001" as const;
    const second = "0x0000000000000000000000000000000000000002" as const;
    let failures = 0;
    const pullback = vi.fn(async (pocket: string) => {
      if (pocket === first && failures === 0) {
        failures += 1;
        throw new Error("temporary pullback failure");
      }
    });

    await expect(
      drainPocketsAfterHalt(
        { vault: "0x0000000000000000000000000000000000000003", event: "Frozen" },
        { listFundedPockets: async () => [first, second], pullback },
      ),
    ).resolves.toEqual([first, second]);
    expect(pullback.mock.calls.map(([pocket]) => pocket)).toEqual([first, second, first]);
  });

  it("sweeps gas and retires a pocket key only after every balance is zero", async () => {
    let nativeBalance = 20_000n;
    const chain = {
      isClosed: vi.fn(async () => false),
      hasPendingPullback: vi.fn(async () => false),
      writeOffPocket: vi.fn(async () => "write-off-tx"),
      sweepableNativeBalance: vi.fn(async () => nativeBalance),
      pocketBalances: vi.fn(async () => ({ native: nativeBalance, usdc: 0n, gateway: 0n })),
      sendPocketTransaction: vi.fn(async () => {
        nativeBalance = 0n;
        return "sweep-tx";
      }),
    };
    const signer = {
      sign: vi.fn(async () => ({ signedTransaction: "0x1234" as const })),
      retirePocketKey: vi.fn(async () => ({ destroyAfterMs: 1_900_000_000_000 })),
    };
    await expect(
      sweepAndRetirePocketKey(
        {
          planId: PLAN_ID,
          stepIndex: 0,
          attempt: 0,
          vault: POCKET as `0x${string}`,
          pocket: POCKET as `0x${string}`,
        },
        { pool: getPool(), signer, chain },
      ),
    ).resolves.toMatchObject({ state: "retiring", sweptNative: "20000" });
    expect(chain.writeOffPocket).toHaveBeenCalledOnce();
    expect(chain.sendPocketTransaction).toHaveBeenCalledOnce();
    expect(signer.retirePocketKey).toHaveBeenCalledOnce();
  });

  it("caps funding by both gateway step totals and the plan pocket basis points", () => {
    expect(
      calculatePocketFunding({
        stepCaps: [400_000n, 300_000n],
        pocketCapBps: 2_500,
        planCap: 1_000_000n,
      }),
    ).toBe(250_000n);
  });

  it("loads the plan-to-pocket link persisted by the planner", async () => {
    const linkedPlanId = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
    await getPool().query(
      `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
       VALUES ($1,$2,$3::jsonb,$4,$5,'offered')`,
      [
        linkedPlanId,
        "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
        JSON.stringify({ pocket: POCKET }),
        `0x${"03".repeat(32)}`,
        `0x${"04".repeat(32)}`,
      ],
    );
    await expect(readPlanPocketKey(getPool(), linkedPlanId)).resolves.toBe(POCKET);
  });

  it("pocket_killResume_matrix_neverRegistersDelegatesOrFundsTwice", async () => {
    await getPool().query("INSERT INTO plan_pocket_keys (plan_id,pocket_address) VALUES ($1,$2)", [
      PLAN_ID,
      POCKET,
    ]);
    let registered = false;
    let granted = 0n;
    let delegated = false;
    let funded = false;
    let failAfter: "register" | "gas" | "delegate" | "fund" | undefined = "register";
    const stopAfter = (phase: typeof failAfter) => {
      if (failAfter !== phase) return;
      failAfter = undefined;
      throw new Error(`simulated executor exit after ${phase}`);
    };
    const chain = {
      isRegistered: vi.fn(async () => registered),
      registerPocket: vi.fn(async () => {
        stopAfter("register");
        registered = true;
        return "register-tx";
      }),
      pocketGasGranted: vi.fn(async () => granted),
      grantPocketGas: vi.fn(async () => {
        stopAfter("gas");
        granted = 20_000n;
        return "gas-tx";
      }),
      isDelegateReady: vi.fn(async () => delegated),
      addDelegate: vi.fn(async () => {
        stopAfter("delegate");
        delegated = true;
        return "delegate-tx";
      }),
      isFunded: vi.fn(async () => funded),
      fundPocket: vi.fn(async () => {
        stopAfter("fund");
        funded = true;
        return "fund-tx";
      }),
    };
    const input = {
      planId: PLAN_ID,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000002:1",
      envelopeId: 1n,
      vault: "0x0000000000000000000000000000000000000002" as const,
      plan: {
        payeeRoot: buildTree([pocketLeaf(POCKET as `0x${string}`)]).root,
        payeeLeaves: [{ payee: POCKET, kind: 4 as const, stepIndex: 4294967295, stepCap: "0" }],
        pocketCapBps: 2500,
        cap: "1000000",
        steps: [{ stepIndex: 0, kind: "gateway-nano" as const, stepCap: "250000" }],
      },
      attempt: 0,
    };
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign: vi.fn(async () => ({ signedTransaction: "0x1234" as const })) },
      chain,
      now: () => new Date("2026-10-22T00:00:00Z"),
    };

    for (const phase of ["register", "gas", "delegate", "fund"] as const) {
      await expect(executePocketPreparation(input, dependencies)).rejects.toThrow(
        `simulated executor exit after ${phase}`,
      );
      failAfter =
        phase === "fund"
          ? undefined
          : ({ register: "gas", gas: "delegate", delegate: "fund" } as const)[phase];
    }
    await expect(executePocketPreparation(input, dependencies)).resolves.toMatchObject({
      pocket: POCKET,
      funded: "250000",
    });
    expect(chain.registerPocket).toHaveBeenCalledTimes(2);
    expect(chain.grantPocketGas).toHaveBeenCalledTimes(2);
    expect(chain.addDelegate).toHaveBeenCalledTimes(2);
    expect(chain.fundPocket).toHaveBeenCalledTimes(2);
  });

  it("sends four Gateway calls and records pending then completed fixture status", async () => {
    const payTo = "0x0000000000000000000000000000000000000003";
    const encodedRequired = encodePaymentRequired({
      ...buildPaymentRequired({
        url: "http://127.0.0.1:4021/data",
        description: "Gateway fixture",
        serviceName: "fixture",
        tags: [],
        network: "eip155:5042002",
        amount: "1000",
        payTo,
        maxTimeoutSeconds: 30,
      }),
      accepts: [
        {
          scheme: "exact",
          network: "eip155:5042002",
          amount: "1000",
          asset: "0x3600000000000000000000000000000000000000",
          payTo,
          maxTimeoutSeconds: 30,
          extra: { name: "GatewayWalletBatched" },
        },
      ],
    });
    let callNumber = 0;
    const safeFetch = vi.fn(async () => {
      callNumber += 1;
      return callNumber % 2 === 1
        ? {
            status: 402,
            url: "http://127.0.0.1:4021/data",
            headers: { "payment-required": encodedRequired },
            body: new Uint8Array(),
          }
        : {
            status: 200,
            url: "http://127.0.0.1:4021/data",
            headers: {},
            body: new TextEncoder().encode("ok"),
          };
    });
    const input = {
      planId: PLAN_ID,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000002:1",
      plan: { network: "eip155:5042002", payeeLeaves: [], steps: [] },
      pocket: POCKET as `0x${string}`,
      acceptedDependencies: [],
      steps: [
        {
          stepIndex: 0,
          stepId: "stp_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
          kind: "gateway-nano" as const,
          capability: "lookup",
          payee: payTo,
          unitAmount: "1000",
          expectedCalls: 4,
          stepCap: "4000",
          routingReason: "below-pocket-threshold",
          acceptanceProfileId: "prof_00000000000000000000000000000000",
          resource: { url: "http://127.0.0.1:4021/data", method: "GET" as const },
          callInputs: [0, 1, 2, 3].map((callIndex) => ({ callIndex, input: { n: callIndex } })),
        },
      ],
      attempt: 0,
    };
    let statusPoll = 0;
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: {
        sign: vi.fn(async () => ({
          signature: `0x${"ab".repeat(65)}` as const,
          digest: `0x${"cd".repeat(32)}` as const,
        })),
      },
      safeFetch,
      now: () => new Date("2026-10-22T00:00:00Z"),
      gatewayStatus: vi.fn(async (): Promise<"pending" | "completed"> =>
        ++statusPoll <= 4 ? "pending" : "completed",
      ),
    };
    await payGatewaySteps(input, dependencies);
    expect(safeFetch).toHaveBeenCalledTimes(8);
    expect(await refreshGatewayStatuses(input, dependencies)).toEqual(Array(4).fill("pending"));
    expect(await refreshGatewayStatuses(input, dependencies)).toEqual(Array(4).fill("completed"));
  });

  it("retries a failed nanopayment with the same signed payment header", async () => {
    const payTo = "0x0000000000000000000000000000000000000003";
    const encodedRequired = encodePaymentRequired({
      ...buildPaymentRequired({
        url: "http://127.0.0.1:4021/data",
        description: "Gateway fixture",
        serviceName: "fixture",
        tags: [],
        network: "eip155:5042002",
        amount: "1000",
        payTo,
        maxTimeoutSeconds: 30,
      }),
      accepts: [
        {
          scheme: "exact",
          network: "eip155:5042002",
          amount: "1000",
          asset: "0x3600000000000000000000000000000000000000",
          payTo,
          maxTimeoutSeconds: 30,
          extra: { name: "GatewayWalletBatched" },
        },
      ],
    });
    const signedHeaders: string[] = [];
    const safeFetch = vi.fn(
      async (_url: string, options?: { headers?: Record<string, string> }) => {
        const header = options?.headers?.["payment-signature"];
        if (header === undefined)
          return {
            status: 402,
            url: "http://127.0.0.1:4021/data",
            headers: { "payment-required": encodedRequired },
            body: new Uint8Array(),
          };
        signedHeaders.push(header);
        if (signedHeaders.length === 1) throw new Error("temporary network failure");
        return {
          status: 200,
          url: "http://127.0.0.1:4021/data",
          headers: {},
          body: new TextEncoder().encode("ok"),
        };
      },
    );
    const signer = {
      sign: vi.fn(async () => ({
        signature: `0x${"ab".repeat(65)}` as const,
        digest: `0x${"cd".repeat(32)}` as const,
      })),
    };
    const input = {
      planId: PLAN_ID,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000002:1",
      plan: { network: "eip155:5042002" },
      pocket: POCKET as `0x${string}`,
      steps: [
        {
          stepIndex: 0,
          stepId: "stp_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
          kind: "gateway-nano" as const,
          capability: "lookup",
          payee: payTo,
          unitAmount: "1000",
          expectedCalls: 1,
          stepCap: "1000",
          routingReason: "below-pocket-threshold",
          acceptanceProfileId: "prof_00000000000000000000000000000000",
          resource: { url: "http://127.0.0.1:4021/data", method: "GET" as const },
          callInputs: [{ callIndex: 0, input: { n: 0 } }],
        },
      ],
    };
    await payGatewaySteps(input, {
      pool: getPool(),
      config: loadConfig(),
      signer,
      safeFetch,
      now: () => new Date("2026-10-22T00:00:00Z"),
      gatewayStatus: vi.fn(async (): Promise<"pending" | "completed"> => "pending"),
    });
    expect(signer.sign).toHaveBeenCalledOnce();
    expect(signedHeaders).toHaveLength(2);
    expect(signedHeaders[0]).toBe(signedHeaders[1]);
  });

  it("stops retries for a Gateway 409 on one authorization index", async () => {
    const payTo = "0x0000000000000000000000000000000000000003";
    const encodedRequired = encodePaymentRequired({
      ...buildPaymentRequired({
        url: "http://127.0.0.1:4021/data",
        description: "Gateway fixture",
        serviceName: "fixture",
        tags: [],
        network: "eip155:5042002",
        amount: "1000",
        payTo,
        maxTimeoutSeconds: 30,
      }),
      accepts: [
        {
          scheme: "exact",
          network: "eip155:5042002",
          amount: "1000",
          asset: "0x3600000000000000000000000000000000000000",
          payTo,
          maxTimeoutSeconds: 30,
          extra: { name: "GatewayWalletBatched" },
        },
      ],
    });
    let calls = 0;
    const input = {
      planId: PLAN_ID,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000002:1",
      plan: { network: "eip155:5042002" },
      pocket: POCKET as `0x${string}`,
      steps: [
        {
          stepIndex: 0,
          stepId: "stp_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
          kind: "gateway-nano" as const,
          capability: "lookup",
          payee: payTo,
          unitAmount: "1000",
          expectedCalls: 1,
          stepCap: "1000",
          routingReason: "below-pocket-threshold",
          acceptanceProfileId: "prof_00000000000000000000000000000000",
          resource: { url: "http://127.0.0.1:4021/data", method: "GET" as const },
          callInputs: [{ callIndex: 0, input: { n: 0 } }],
        },
      ],
    };
    await expect(
      payGatewaySteps(input, {
        pool: getPool(),
        config: loadConfig(),
        signer: {
          sign: vi.fn(async () => ({
            signature: `0x${"ab".repeat(65)}` as const,
            digest: `0x${"cd".repeat(32)}` as const,
          })),
        },
        safeFetch: vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? {
                status: 402,
                url: "http://127.0.0.1:4021/data",
                headers: { "payment-required": encodedRequired },
                body: new Uint8Array(),
              }
            : {
                status: 409,
                url: "http://127.0.0.1:4021/data",
                headers: {},
                body: new Uint8Array(),
              };
        }),
        now: () => new Date("2026-10-22T00:00:00Z"),
        gatewayStatus: vi.fn(async (): Promise<"pending" | "completed"> => "pending"),
      }),
    ).rejects.toThrow("HTTP 409");
    expect(calls).toBe(2);
  });
});
