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
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";
import { loadConfig } from "@czar/config";
import { buildTree, pocketLeaf } from "@czar/hashing";
import { KEY_IDS } from "@czar/signer";
import { appendExecutionPhase } from "#src/payer/executions";
import {
  buildExactPaymentPayload,
  buildPaymentRequired,
  decodeBase64Json,
  encodePaymentRequired,
  readPaymentRequired,
  SafeFetchError,
} from "@czar/x402";

const getPool = setupDatabase();
/** A test-only K3 key generated per run; nothing is committed. */
const K3 = privateKeyToAccount(generatePrivateKey());

/** A signed K3 transaction with `nonce`, so a saved one decodes to its sender and nonce (SCR-159 §2). */
function signTestTransaction(nonce: number): Promise<`0x${string}`> {
  return K3.signTransaction({
    type: "eip1559",
    chainId: 5042002,
    nonce,
    gas: 100_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    to: "0x0000000000000000000000000000000000000002",
    data: "0x",
  });
}
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const POCKET = "0x0000000000000000000000000000000000000001";

function gatewayRetryFixture() {
  const payTo = "0x0000000000000000000000000000000000000003";
  const challenge = encodePaymentRequired({
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
  return {
    challenge,
    input: {
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
          serviceId: "svc_0123456789abcdef0123456789abcdef",
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
    },
  };
}

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
  await getPool().query("DELETE FROM supplier_health");
  await getPool().query(
    "DELETE FROM observations WHERE objective_id=(SELECT objective_id FROM plans WHERE plan_id=$1)",
    [PLAN_ID],
  );
  await getPool().query("DELETE FROM step_executions");
  await getPool().query("DELETE FROM payer_pullback_gateway_failures WHERE plan_id=$1", [PLAN_ID]);
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
  it("asks the signer for the K4 key id, not a pocket key reference", async () => {
    await getPool().query("INSERT INTO plan_pocket_keys(plan_id,pocket_address) VALUES($1,$2)", [
      PLAN_ID,
      POCKET,
    ]);
    const sign = vi.fn(async (_caller: string, _request: { keyId: string; kind: string }) => ({
      signedTransaction: "0x01" as const,
    }));
    await executePocketPreparation(
      {
        planId: PLAN_ID,
        envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000002:1",
        envelopeId: 1n,
        vault: "0x0000000000000000000000000000000000000002",
        plan: {
          payeeRoot: buildTree([pocketLeaf(POCKET as `0x${string}`)]).root,
          payeeLeaves: [{ payee: POCKET, kind: 4, stepIndex: 4294967295, stepCap: "0" }],
          pocketCapBps: 2500,
          cap: "1000000",
          steps: [{ stepIndex: 0, kind: "gateway-nano", stepCap: "250000" }],
        },
      },
      {
        pool: getPool(),
        config: loadConfig(),
        signer: { sign },
        chain: {
          isRegistered: async () => true,
          registerPocket: async () => "register",
          pocketGasGranted: async () => 20_000n,
          grantPocketGas: async () => "gas",
          isDelegateReady: async () => false,
          addDelegate: async () => "delegate",
          isFunded: async () => true,
          fundPocket: async () => "fund",
          transactionCount: async () => 0,
          transactionStatus: async () => undefined,
        },
        now: () => new Date("2026-10-22T00:00:00Z"),
      },
    );

    const delegate = sign.mock.calls.find(([, request]) => request.kind === "pocket-delegate");
    expect(delegate?.[1].keyId).toBe("K4");
    expect(KEY_IDS).toContain(delegate?.[1].keyId);
  });

  it("reuses a registration transaction when the first Gateway step is not step zero", async () => {
    await getPool().query("INSERT INTO plan_pocket_keys(plan_id,pocket_address) VALUES($1,$2)", [
      PLAN_ID,
      POCKET,
    ]);
    await getPool().query(
      "INSERT INTO steps(plan_id,step_index,step,state) VALUES($1,4,'{}','queued')",
      [PLAN_ID],
    );
    let registered = false;
    let interrupt = true;
    const signed: string[] = [];
    const chain = {
      isRegistered: async () => registered,
      registerPocket: vi.fn(async ({ transaction }: { transaction: `0x${string}` }) => {
        if (interrupt) {
          interrupt = false;
          throw new Error("executor stopped after registration transaction was sent");
        }
        registered = true;
        return transaction;
      }),
      pocketGasGranted: async () => 20_000n,
      grantPocketGas: async () => "gas",
      isDelegateReady: async () => true,
      addDelegate: async () => "delegate",
      isFunded: async () => true,
      fundPocket: async () => "fund",
      transactionCount: async () => 0,
      transactionStatus: async () => undefined,
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
        steps: [{ stepIndex: 4, kind: "gateway-nano" as const, stepCap: "250000" }],
      },
    };
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: {
        sign: vi.fn(async () => {
          const transaction = await signTestTransaction(signed.length);
          signed.push(transaction);
          return { signedTransaction: transaction };
        }),
      },
      chain,
      now: () => new Date("2026-10-22T00:00:00Z"),
    };

    await expect(executePocketPreparation(input, dependencies)).rejects.toThrow(
      "executor stopped after registration transaction was sent",
    );
    await expect(executePocketPreparation(input, dependencies)).resolves.toMatchObject({
      pocket: POCKET,
    });

    expect(signed).toHaveLength(1);
    expect(chain.registerPocket).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ transaction: signed[0] }),
    );
  });

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
        { pool: getPool(), config: loadConfig(), now: () => new Date(), signer, chain },
      ),
    ).resolves.toMatchObject({ state: "retiring", sweptNative: "20000" });
    expect(chain.writeOffPocket).toHaveBeenCalledOnce();
    expect(chain.sendPocketTransaction).toHaveBeenCalledOnce();
    expect(signer.retirePocketKey).toHaveBeenCalledOnce();
  });

  it("does not bypass the manual-return hold through pocket close", async () => {
    const now = new Date("2026-10-22T00:00:00.000Z");
    await getPool().query(
      `INSERT INTO payer_pullback_gateway_failures
         (plan_id,step_index,envelope_ref,pocket,value,unavailable_since,state,
          pullback_id,vault_address,gateway_minter,attempt,return_tx,return_block,
          return_log_index,returned_amount,manual_return_required_at)
       VALUES($1,0,$2,$3,100,$4,'manual-return-required',NULL,$5,$6,0,$7,50,5,100,$4)`,
      [
        PLAN_ID,
        "eip155:5042002:0xvault:1",
        POCKET,
        now,
        "0x0000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000003",
        `0x${"33".repeat(32)}`,
      ],
    );
    const writeOffPocket = vi.fn(async () => "write-off-tx");
    const sign = vi.fn(async () => ({ signedTransaction: "0x1234" as const }));
    await expect(
      sweepAndRetirePocketKey(
        {
          planId: PLAN_ID,
          stepIndex: 0,
          attempt: 0,
          vault: "0x0000000000000000000000000000000000000002",
          pocket: POCKET,
        },
        {
          pool: getPool(),
          config: loadConfig({ envFile: { "payer.manualReturnHoldHours": 72 } }),
          now: () => now,
          signer: { sign, retirePocketKey: vi.fn() },
          chain: {
            isClosed: vi.fn(async () => false),
            hasPendingPullback: vi.fn(async () => false),
            writeOffPocket,
            sweepableNativeBalance: vi.fn(async () => 0n),
            pocketBalances: vi.fn(async () => ({ native: 0n, usdc: 0n, gateway: 0n })),
            sendPocketTransaction: vi.fn(async () => "sweep-tx"),
          },
        },
      ),
    ).rejects.toThrow("manual-return hold");
    expect(sign).not.toHaveBeenCalled();
    expect(writeOffPocket).not.toHaveBeenCalled();
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
    let nextNonce = 0;
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
      transactionCount: async () => 0,
      transactionStatus: async () => undefined,
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
      signer: {
        sign: vi.fn(async (_caller: string, request: { kind: string }) => ({
          signedTransaction:
            request.kind === "vault-call"
              ? await signTestTransaction(nextNonce++)
              : ("0x1234" as const),
        })),
      },
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
      extensions: {
        "payment-identifier": {
          info: { required: true },
          schema: {
            type: "object",
            properties: {
              required: { type: "boolean" },
              id: { type: "string", minLength: 16, maxLength: 128 },
            },
            required: ["required"],
          },
        },
      },
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
          serviceId: "svc_0123456789abcdef0123456789abcdef",
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
    const pending = await getPool().query<{ settled_at: Date | null }>(
      "SELECT settled_at FROM observations WHERE envelope_ref=$1 ORDER BY call_index",
      [input.envelopeRef],
    );
    expect(pending.rows).toHaveLength(4);
    expect(pending.rows.every((row) => row.settled_at === null)).toBe(true);
    expect(await refreshGatewayStatuses(input, dependencies)).toEqual(Array(4).fill("completed"));
    const settled = await getPool().query<{ settled_at: Date | null }>(
      "SELECT settled_at FROM observations WHERE envelope_ref=$1 ORDER BY call_index",
      [input.envelopeRef],
    );
    expect(settled.rows).toHaveLength(4);
    expect(settled.rows.every((row) => row.settled_at instanceof Date)).toBe(true);
  });

  it("does not sign an alternate Gateway payee without a committed service identity", async () => {
    const { challenge, input } = gatewayRetryFixture();
    const primary = "0x0000000000000000000000000000000000000004";
    const alternate = input.steps[0]?.payee;
    if (!alternate) throw new Error("Gateway fixture has no alternate payee.");
    const step = input.steps[0];
    if (!step) throw new Error("Gateway fixture has no step.");
    const sign = vi.fn(async () => ({
      signature: `0x${"ab".repeat(65)}` as const,
      digest: `0x${"cd".repeat(32)}` as const,
    }));
    const safeFetch = vi.fn(async () => ({
      status: 402,
      url: "http://127.0.0.1:4021/data",
      headers: { "payment-required": challenge },
      body: new Uint8Array(),
    }));

    await expect(
      payGatewaySteps(
        {
          ...input,
          steps: [{ ...step, payee: primary, alternates: [alternate] }],
        },
        {
          pool: getPool(),
          config: loadConfig(),
          signer: { sign },
          safeFetch,
          now: () => new Date("2026-10-22T00:00:00Z"),
          gatewayStatus: vi.fn(async () => "pending" as const),
        },
      ),
    ).rejects.toThrow(/service|payee/i);
    expect(sign).not.toHaveBeenCalled();
  });

  it("reconciles a previously signed alternate Gateway payment without signing again", async () => {
    const { challenge, input } = gatewayRetryFixture();
    const step = input.steps[0];
    if (!step?.payee) throw new Error("Gateway fixture has no step payee.");
    const alternate = step.payee;
    const read = readPaymentRequired({
      status: 402,
      headers: { "payment-required": challenge },
      body: "",
    });
    if (!read.ok) throw new Error("Gateway fixture has no valid challenge.");
    const offer = read.paymentRequired.accepts[0];
    if (!offer) throw new Error("Gateway fixture has no accepted offer.");
    const nonce = `0x${"11".repeat(32)}` as const;
    const validBefore = String(Math.floor(Date.parse("2026-10-22T00:00:00Z") / 1000) + 30);
    const paymentPayload = buildExactPaymentPayload({
      resource: read.resource,
      accepted: offer,
      authorization: {
        from: POCKET,
        to: alternate,
        value: "1000",
        validAfter: "0",
        validBefore,
        nonce,
      },
      signature: `0x${"ab".repeat(65)}`,
    });
    await appendExecutionPhase(getPool(), {
      planId: PLAN_ID,
      stepIndex: 0,
      attempt: 0,
      phase: "pocket.auth.signed[0]",
      payload: {
        index: 0,
        paymentPayload,
        nonce,
        paymentId: "pay_11111111111111111111111111111111",
      },
    });
    const sign = vi.fn();
    const gatewayStatus = vi.fn(async () => "completed" as const);
    const resumeInput = {
      ...input,
      steps: [
        { ...step, payee: "0x0000000000000000000000000000000000000004", alternates: [alternate] },
      ],
    };
    await payGatewaySteps(resumeInput, {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign },
      safeFetch: vi.fn(async () => ({
        status: 402,
        url: "http://127.0.0.1:4021/data",
        headers: { "payment-required": challenge },
        body: new Uint8Array(),
      })),
      now: () => new Date("2026-10-22T00:00:00Z"),
      gatewayStatus,
    });

    expect(sign).not.toHaveBeenCalled();
    expect(gatewayStatus).toHaveBeenCalledOnce();
    const observation = await getPool().query<{ settled_at: Date | null }>(
      "SELECT settled_at FROM observations WHERE envelope_ref=$1",
      [input.envelopeRef],
    );
    expect(observation.rows).toHaveLength(1);
    expect(observation.rows[0]?.settled_at).toBeInstanceOf(Date);
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
      extensions: {
        "payment-identifier": {
          info: { required: true },
          schema: {
            type: "object",
            properties: {
              required: { type: "boolean" },
              id: { type: "string", minLength: 16, maxLength: 128 },
            },
            required: ["required"],
          },
        },
      },
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
        if (signedHeaders.length === 1)
          throw new SafeFetchError("upstream-unavailable", "transport");
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
          serviceId: "svc_0123456789abcdef0123456789abcdef",
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
    const payload = decodeBase64Json(signedHeaders[0] ?? "");
    expect(payload.ok).toBe(true);
    if (!payload.ok) throw new Error("Expected an encoded Gateway payment payload.");
    expect(payload.value).toMatchObject({
      extensions: {
        "payment-identifier": {
          info: { required: true, id: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/) },
        },
      },
    });
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
          serviceId: "svc_0123456789abcdef0123456789abcdef",
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
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
    const observations = await getPool().query<{
      delivered: number | null;
      settled_at: Date | null;
    }>("SELECT delivered,settled_at FROM observations WHERE envelope_ref=$1", [input.envelopeRef]);
    expect(observations.rows).toMatchObject([{ delivered: 0, settled_at: null }]);
  });

  it("keeps one signed observation across no-response resume and silent Gateway settlement", async () => {
    const { challenge, input } = gatewayRetryFixture();
    let requests = 0;
    const signer = {
      sign: vi.fn(async () => ({
        signature: `0x${"ab".repeat(65)}` as const,
        digest: `0x${"cd".repeat(32)}` as const,
      })),
    };
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer,
      safeFetch: vi.fn(async (_url: string, options?: { headers?: Record<string, string> }) => {
        requests += 1;
        if (!options?.headers?.["payment-signature"])
          return {
            status: 402,
            url: "http://127.0.0.1:4021/data",
            headers: { "payment-required": challenge },
            body: new Uint8Array(),
          };
        throw new SafeFetchError("upstream-unavailable", "transport");
      }),
      now: () => new Date("2026-10-22T00:00:00Z"),
      gatewayStatus: vi.fn(async (): Promise<"completed"> => "completed"),
    };
    await payGatewaySteps(input, dependencies);
    const first = await getPool().query<{ obs_id: string; responded_at: Date | null }>(
      "SELECT obs_id,responded_at FROM observations WHERE envelope_ref=$1",
      [input.envelopeRef],
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.responded_at).toBeNull();
    await payGatewaySteps(input, dependencies);
    expect(signer.sign).toHaveBeenCalledOnce();
    expect(await refreshGatewayStatuses(input, dependencies)).toEqual(["completed"]);
    const final = await getPool().query<{
      obs_id: string;
      delivered: number;
      settled_at: Date;
      responded_at: Date | null;
    }>("SELECT obs_id,delivered,settled_at,responded_at FROM observations WHERE envelope_ref=$1", [
      input.envelopeRef,
    ]);
    expect(final.rows).toHaveLength(1);
    expect(final.rows[0]).toMatchObject({
      obs_id: first.rows[0]?.obs_id,
      delivered: 0,
      responded_at: null,
    });
    expect(final.rows[0]?.settled_at).toBeInstanceOf(Date);
    await payGatewaySteps(input, dependencies);
    expect(signer.sign).toHaveBeenCalledOnce();
  });

  it("propagates a blocked fetch and reconciles the saved nonce on restart", async () => {
    const { challenge, input } = gatewayRetryFixture();
    let signedRequests = 0;
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: {
        sign: vi.fn(async () => ({
          signature: `0x${"ab".repeat(65)}` as const,
          digest: `0x${"cd".repeat(32)}` as const,
        })),
      },
      safeFetch: vi.fn(async (_url: string, options?: { headers?: Record<string, string> }) => {
        if (options?.headers?.["payment-signature"]) {
          signedRequests += 1;
          throw new SafeFetchError("fetch-blocked", "url");
        }
        return {
          status: 402,
          url: "http://127.0.0.1:4021/data",
          headers: { "payment-required": challenge },
          body: new Uint8Array(),
        };
      }),
      now: () => new Date("2026-10-22T00:00:00Z"),
      gatewayStatus: vi.fn(async (): Promise<"completed"> => "completed"),
    };

    await expect(payGatewaySteps(input, dependencies)).rejects.toThrow("fetch-blocked: url");
    await payGatewaySteps(input, dependencies);
    expect(signedRequests).toBe(1);
    expect(dependencies.signer.sign).toHaveBeenCalledOnce();
    const row = await getPool().query<{ settled_at: Date | null }>(
      "SELECT settled_at FROM observations WHERE envelope_ref=$1",
      [input.envelopeRef],
    );
    expect(row.rows[0]?.settled_at).toBeInstanceOf(Date);
  });

  it("propagates an observation write failure without resending the signed payment", async () => {
    const { challenge, input } = gatewayRetryFixture();
    let signedRequests = 0;
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: {
        sign: vi.fn(async () => ({
          signature: `0x${"ab".repeat(65)}` as const,
          digest: `0x${"cd".repeat(32)}` as const,
        })),
      },
      safeFetch: vi.fn(async (_url: string, options?: { headers?: Record<string, string> }) => {
        if (options?.headers?.["payment-signature"]) {
          signedRequests += 1;
          return {
            status: 200,
            url: "http://127.0.0.1:4021/data",
            headers: {},
            body: new Uint8Array(),
          };
        }
        return {
          status: 402,
          url: "http://127.0.0.1:4021/data",
          headers: { "payment-required": challenge },
          body: new Uint8Array(),
        };
      }),
      now: () => new Date("2026-10-22T00:00:00Z"),
      gatewayStatus: vi.fn(async (): Promise<"completed"> => "completed"),
    };
    await getPool().query(`CREATE FUNCTION fail_observation_response() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'observation write failed'; END; $$ LANGUAGE plpgsql`);
    await getPool().query(`CREATE TRIGGER fail_observation_response BEFORE UPDATE ON observations
      FOR EACH ROW EXECUTE FUNCTION fail_observation_response()`);
    try {
      await expect(payGatewaySteps(input, dependencies)).rejects.toThrow(
        "observation write failed",
      );
    } finally {
      await getPool().query("DROP TRIGGER fail_observation_response ON observations");
      await getPool().query("DROP FUNCTION fail_observation_response()");
    }
    expect(signedRequests).toBe(1);
    await payGatewaySteps(input, dependencies);
    expect(signedRequests).toBe(1);
  });
});
