import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeVaultDirectStep,
  type BoundaryInput,
  type SettledReceiptContext,
  type VaultDirectInput,
} from "#src/payer/vault-direct";
import { loadConfig } from "@czar/config";
import { buildTree, PAYEE_KIND, payeeLeaf } from "@czar/hashing";
import { buildPaymentRequired, encodeBase64Json, encodePaymentRequired } from "@czar/x402";
import type { SignRequest, SignResult } from "@czar/signer";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { setupDatabase } from "#test/db";
import { markStepDoneWithResults } from "#src/payer/executions";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const VAULT = "0x0000000000000000000000000000000000000001" as const;
const PAYEE = "0x0000000000000000000000000000000000000002" as const;
const HASH = `0x${"01".repeat(32)}`;

beforeAll(async () => seedDevice(getPool()));
beforeEach(async () => {
  await getPool().query("DELETE FROM executor_leases");
  await getPool().query("DELETE FROM step_executions");
  await getPool().query("DELETE FROM steps");
  await getPool().query("DELETE FROM observations");
  await getPool().query("DELETE FROM plans");
  await getPool().query("DELETE FROM objectives");
  const submission = makeObjectiveSubmission(OBJECTIVE);
  await getPool().query(
    `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state)
     VALUES ($1,$2,$3,$4::jsonb,$5,'received')`,
    [
      OBJECTIVE,
      TEST_USER_ID,
      submission.deviceId,
      JSON.stringify(submission),
      submission.objectiveHash,
    ],
  );
  await getPool().query(
    `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES ($1,$2,'{}',$3,$4,'offered')`,
    [PLAN_ID, OBJECTIVE, HASH, HASH],
  );
  await getPool().query(
    "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,'{}','queued')",
    [PLAN_ID],
  );
});

describe("vault-direct executor", () => {
  it("never reserves, signs, or fetches for an unpaid step", async () => {
    const reserve = vi.fn();
    const sign = vi.fn();
    const safeFetch = vi.fn();
    const result = await executeVaultDirectStep(
      {
        planId: "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
        envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
        envelopeId: 1n,
        envelopeExpiresAt: new Date("2026-10-22T00:00:00Z"),
        vault: "0x0000000000000000000000000000000000000001",
        plan: {
          schemaVersion: "1.3",
          planId: "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
          objectiveId: "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
          objectiveHash: `0x${"01".repeat(32)}`,
          planHash: `0x${"02".repeat(32)}`,
          network: "eip155:5042002",
          category: "research",
          cap: "0",
          slackBps: 0,
          maxStepAmount: "0",
          pocketCapBps: 0,
          expiresAt: "2026-10-22T00:00:00.000Z",
          steps: [],
          payeeLeaves: [],
          payeeRoot: `0x${"00".repeat(32)}`,
          shadow: false,
          createdAt: "2026-10-21T00:00:00.000Z",
          taskSpec: {} as never,
        },
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
        userId: "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
        deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
      },
      {
        pool: getPool(),
        config: loadConfig(),
        signer: { sign },
        chain: { reserve },
        safeFetch,
        now: () => new Date("2026-10-21T00:00:00Z"),
      } as never,
    );

    expect(result).toMatchObject({ state: "handed_off" });
    expect(reserve).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("does not sign an alternate x402 payee without a committed service identity", async () => {
    const alternate = "0x0000000000000000000000000000000000000003" as const;
    const offer = buildPaymentRequired({
      url: "http://127.0.0.1:4021/data",
      description: "alternate seller",
      serviceName: "alternate",
      tags: [],
      network: "eip155:5042002",
      amount: "1000",
      payTo: alternate,
      maxTimeoutSeconds: 30,
    });
    const leaves = [PAYEE, alternate].map((payee) =>
      payeeLeaf(payee, PAYEE_KIND.X402_PAY_TO, 0, 1000n),
    );
    const payeeRoot = buildTree(leaves).root;
    const sign = vi.fn(async () => {
      throw new Error("alternate payee reached K3 signer");
    });
    const input: VaultDirectInput = {
      planId: PLAN_ID,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      envelopeId: 1n,
      envelopeExpiresAt: new Date("2026-10-22T00:00:00Z"),
      vault: VAULT,
      plan: {
        network: "eip155:5042002",
        expiresAt: "2026-10-22T00:00:00.000Z",
        payeeLeaves: [PAYEE, alternate].map((payee) => ({
          payee,
          kind: PAYEE_KIND.X402_PAY_TO,
          stepIndex: 0,
          stepCap: "1000",
        })),
        payeeRoot,
      } as never,
      step: {
        stepIndex: 0,
        stepId: "stp_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
        kind: "x402-exact",
        capability: "web-search",
        serviceId: "svc_11111111111111111111111111111111",
        resource: { url: "http://127.0.0.1:4021/data", method: "GET" },
        payee: PAYEE,
        alternates: [alternate],
        unitAmount: "1000",
        expectedCalls: 1,
        stepCap: "1000",
        routingReason: "vault-direct",
        acceptanceProfileId: "prof_11111111111111111111111111111111",
        callInputs: [{ callIndex: 0, input: { q: "one" } }],
      },
      userId: TEST_USER_ID,
      deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
      dispatchLease: { assertHeld: vi.fn() },
    };
    const result = await executeVaultDirectStep(input, {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign },
      chain: {
        stepUsed: async () => 0n,
        envelopeCapacity: async () => ({ cap: 1000n, exposure: 0n }),
        latestBlockTimestamp: async () => 1_761_000_000n,
      } as never,
      safeFetch: vi.fn(async () => ({
        status: 402,
        url: "http://127.0.0.1:4021/data",
        headers: { "payment-required": encodePaymentRequired(offer) },
        body: new Uint8Array(),
      })),
      now: () => new Date("2026-10-21T00:00:00Z"),
      boundary: vi.fn(),
      recordReceipt: vi.fn(async () => false),
      objects: { put: vi.fn(), get: vi.fn() },
    });

    expect(result.state).toBe("failed");
    expect(sign).not.toHaveBeenCalled();
  });

  it("keeps the dispatcher lease while running an unpaid step", async () => {
    const envelopeRef = "eip155:5042002:0x0000000000000000000000000000000000000001:1";
    await getPool().query(
      "INSERT INTO executor_leases (envelope_ref,worker_id,expires_at) VALUES ($1,$2,$3)",
      [envelopeRef, "dispatch-worker", new Date(Date.now() + 60_000)],
    );
    await expect(
      executeVaultDirectStep(
        {
          planId: PLAN_ID,
          envelopeRef,
          envelopeId: 1n,
          envelopeExpiresAt: new Date("2026-10-22T00:00:00Z"),
          vault: VAULT,
          plan: {} as never,
          step: {
            stepIndex: 0,
            stepId: "stp_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
            kind: "local",
            capability: "table-fill",
            unitAmount: "0",
            expectedCalls: 0,
            stepCap: "0",
            routingReason: "below-pocket-threshold",
            acceptanceProfileId: "prof_00000000000000000000000000000000",
          },
          userId: "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
          deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
          dispatchLease: { assertHeld: vi.fn() },
        },
        {
          pool: getPool(),
          config: loadConfig(),
          signer: { sign: vi.fn() },
          chain: {} as never,
          safeFetch: vi.fn(),
          now: () => new Date("2026-10-21T00:00:00Z"),
          boundary: vi.fn(),
          recordReceipt: vi.fn(async () => true),
          objects: { put: vi.fn(), get: vi.fn() },
        },
      ),
    ).resolves.toMatchObject({ state: "handed_off" });
    const lease = await getPool().query<{ worker_id: string }>(
      "SELECT worker_id FROM executor_leases WHERE envelope_ref=$1",
      [envelopeRef],
    );
    expect(lease.rows[0]?.worker_id).toBe("dispatch-worker");
  });

  it("rolls back the result when the paid-step done write fails", async () => {
    const stepResult = {
      schemaVersion: "1.1" as const,
      stepIndex: 0,
      callIndex: 0,
      obsId: `obs_${"a".repeat(32)}`,
      status: "delivered" as const,
      source: { origin: "https://merchant.test", payTo: PAYEE, paymentRefHash: HASH },
      fields: [],
      flags: [],
      bodyCommit: HASH,
    };
    await expect(
      markStepDoneWithResults(getPool(), {
        planId: PLAN_ID,
        stepIndex: 0,
        attempt: 0,
        callsUsed: 1,
        results: [{ index: 0, stepResult: { ...stepResult, status: "invalid" } as never }],
      }),
    ).rejects.toThrow("invalid StepResult");
    await expect(
      getPool().query("SELECT state FROM steps WHERE plan_id=$1 AND step_index=0", [PLAN_ID]),
    ).resolves.toMatchObject({ rows: [{ state: "queued" }] });
    await getPool().query(`CREATE FUNCTION fail_step_done() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state = 'done' THEN RAISE EXCEPTION 'simulated state write failure'; END IF;
        RETURN NEW;
      END;
    $$`);
    await getPool().query(
      "CREATE TRIGGER fail_step_done BEFORE UPDATE ON steps FOR EACH ROW EXECUTE FUNCTION fail_step_done()",
    );
    try {
      await expect(
        markStepDoneWithResults(getPool(), {
          planId: PLAN_ID,
          stepIndex: 0,
          attempt: 0,
          callsUsed: 1,
          results: [{ index: 0, stepResult }],
        }),
      ).rejects.toThrow("simulated state write failure");
      await expect(
        getPool().query("SELECT state FROM steps WHERE plan_id=$1 AND step_index=0", [PLAN_ID]),
      ).resolves.toMatchObject({ rows: [{ state: "queued" }] });
      await expect(
        getPool().query(
          "SELECT execution_id FROM step_executions WHERE plan_id=$1 AND step_index=0 AND phase='step.result'",
          [PLAN_ID],
        ),
      ).resolves.toMatchObject({ rows: [] });
    } finally {
      await getPool().query("DROP TRIGGER fail_step_done ON steps");
      await getPool().query("DROP FUNCTION fail_step_done()");
    }
  });

  it("recovers sent phases with the same authorization and payment header", async () => {
    const leaf = payeeLeaf(PAYEE, PAYEE_KIND.X402_PAY_TO, 0, 1000n);
    const tree = buildTree([leaf]);
    const baseOffer = buildPaymentRequired({
      url: "http://127.0.0.1:4021/data",
      description: "local test merchant",
      serviceName: "fixture",
      tags: [],
      network: "eip155:5042002",
      amount: "1000",
      payTo: PAYEE,
      maxTimeoutSeconds: 30,
    });
    const offer = {
      ...baseOffer,
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
    };
    const signedPayment = `0x${"ab".repeat(416)}` as `0x${string}`;
    // SCR-159 §1: only the first attempt's pre-check probes; every resume continues from the saved phase.
    let failFirstPaidCall = true;
    const safeFetch = vi.fn(
      async (_url: string, options?: { headers?: Record<string, string> }) => {
        if (!options?.headers?.["payment-signature"])
          return {
            status: 402,
            url: "http://127.0.0.1:4021/data?q=one",
            headers: { "payment-required": encodePaymentRequired(offer) },
            body: new Uint8Array(),
          };
        if (failFirstPaidCall) {
          failFirstPaidCall = false;
          throw new Error("simulated worker death after call.sent");
        }
        return {
          status: 200,
          url: "http://127.0.0.1:4021/data?q=one",
          headers: {
            "payment-response": encodeBase64Json({
              errorReason: "settlement_pending",
              transaction: HASH,
            }),
          },
          body: new TextEncoder().encode('{"price":"ok"}'),
        };
      },
    );
    const k3 = privateKeyToAccount(generatePrivateKey());
    let nextNonce = 0;
    let failFirstAuthorizationSign = true;
    let successfulAuthorizationSignatures = 0;
    const sign = vi.fn(async (_caller: string, request: SignRequest): Promise<SignResult> => {
      if (request.kind === "usdc-3009") {
        if (failFirstAuthorizationSign) {
          failFirstAuthorizationSign = false;
          throw new Error("simulated worker death after reserve.mined");
        }
        successfulAuthorizationSignatures += 1;
        return { signature: signedPayment, digest: HASH as `0x${string}` };
      }
      const signedTransaction = await k3.signTransaction({
        type: "eip1559",
        chainId: 5042002,
        nonce: nextNonce,
        gas: 100_000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        to: VAULT,
        data: "0x",
      });
      nextNonce += 1;
      return { signedTransaction };
    });
    let settled = false;
    const isSettled = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("simulated worker death after call.result"))
      .mockImplementation(async () => settled);
    const reserve = vi
      .fn<() => Promise<{ reservationId: bigint; txHash: string }>>()
      .mockRejectedValueOnce(new Error("simulated worker death after reserve.sent"))
      .mockResolvedValue({ reservationId: 4n, txHash: HASH });
    const finalize = vi
      .fn<
        (args: {
          readonly signedTransaction: string;
        }) => Promise<{ txHash: string; final: boolean }>
      >()
      .mockRejectedValueOnce(new Error("simulated worker death before finalize result"))
      .mockResolvedValue({ txHash: HASH, final: true });
    const chain = {
      stepUsed: vi.fn(async () => 0n),
      envelopeCapacity: vi.fn(async () => ({ cap: 10_000n, exposure: 0n })),
      // Chain time follows the test clock, which each sleep moves on.
      transactionCount: vi.fn(async () => 0),
      transactionStatus: vi.fn(async (): Promise<"success" | "reverted" | undefined> => undefined),
      latestBlockTimestamp: vi.fn(async () => BigInt(Math.floor(current.getTime() / 1000))),
      reserve,
      settle: vi.fn(async () => {
        settled = true;
        return HASH;
      }),
      authorizationState: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true),
      isSettled,
      finalize,
    };
    const input: VaultDirectInput = {
      planId: PLAN_ID,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      envelopeId: 1n,
      envelopeExpiresAt: new Date("2026-10-22T00:00:00Z"),
      vault: VAULT,
      plan: {
        schemaVersion: "1.3",
        planId: PLAN_ID,
        objectiveId: OBJECTIVE,
        objectiveHash: HASH,
        planHash: HASH,
        network: "eip155:5042002",
        category: "research",
        cap: "1000",
        slackBps: 0,
        maxStepAmount: "1000",
        pocketCapBps: 0,
        expiresAt: "2026-10-22T00:00:00.000Z",
        steps: [],
        payeeLeaves: [{ payee: PAYEE, kind: 1, stepIndex: 0, stepCap: "1000" }],
        payeeRoot: tree.root,
        shadow: false,
        createdAt: "2026-10-21T00:00:00.000Z",
        taskSpec: {} as never,
      } as never,
      step: {
        stepIndex: 0,
        stepId: "stp_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
        kind: "x402-exact",
        capability: "web-search",
        serviceId: "svc_11111111111111111111111111111111",
        resource: { url: "http://127.0.0.1:4021/data", method: "GET" },
        payee: PAYEE,
        unitAmount: "1000",
        expectedCalls: 1,
        stepCap: "1000",
        routingReason: "vault-direct",
        acceptanceProfileId: "prof_11111111111111111111111111111111",
        callInputs: [{ callIndex: 0, input: { q: "one" } }],
      },
      userId: TEST_USER_ID,
      deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
    };
    let current = new Date("2026-10-21T00:00:00Z");
    const stepResult = {
      schemaVersion: "1.1" as const,
      stepIndex: 0,
      callIndex: 0,
      obsId: `obs_${"a".repeat(32)}`,
      status: "delivered" as const,
      source: { origin: "http://127.0.0.1:4021", payTo: PAYEE, paymentRefHash: HASH },
      fields: [],
      flags: [],
      bodyCommit: HASH,
    };
    const boundary = vi.fn(async (context: BoundaryInput) => ({
      ...stepResult,
      obsId: context.obsId,
    }));
    let receiptAvailable = false;
    const recordReceipt = vi.fn(async (_input: SettledReceiptContext) => receiptAvailable);
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign },
      chain,
      safeFetch,
      now: () => current,
      sleep: async (milliseconds: number) => {
        current = new Date(current.getTime() + milliseconds);
      },
      objects: { put: async () => "body-ref", get: async () => new Uint8Array() },
      boundary,
      recordReceipt,
    } as const;
    await expect(executeVaultDirectStep(input, dependencies)).rejects.toThrow(
      "simulated worker death after reserve.sent",
    );
    await expect(executeVaultDirectStep(input, dependencies)).rejects.toThrow(
      "simulated worker death after reserve.mined",
    );
    // The worker restarts later; the authorization must still use the reservation's validBefore.
    current = new Date(current.getTime() + 10_000);
    await getPool().query(`CREATE FUNCTION fail_call_sent() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.phase = 'call.sent' THEN
          RAISE EXCEPTION 'simulated worker death between auth.signed and call.sent';
        END IF;
        RETURN NEW;
      END;
    $$`);
    await getPool().query(
      "CREATE TRIGGER fail_call_sent BEFORE INSERT ON step_executions FOR EACH ROW EXECUTE FUNCTION fail_call_sent()",
    );
    try {
      await expect(executeVaultDirectStep(input, dependencies)).rejects.toThrow(
        "simulated worker death between auth.signed and call.sent",
      );
    } finally {
      await getPool().query("DROP TRIGGER fail_call_sent ON step_executions");
      await getPool().query("DROP FUNCTION fail_call_sent()");
    }
    await expect(executeVaultDirectStep(input, dependencies)).rejects.toThrow(
      "simulated worker death after call.sent",
    );
    await expect(executeVaultDirectStep(input, dependencies)).rejects.toThrow(
      "simulated worker death after call.result",
    );
    await expect(executeVaultDirectStep(input, dependencies)).rejects.toThrow(
      "simulated worker death before finalize result",
    );
    const result = await executeVaultDirectStep(input, dependencies);

    expect(result).toMatchObject({
      state: "pending",
      stepResults: [{ ...stepResult, obsId: expect.stringMatching(/^obs_[0-9a-f]{32}$/) }],
    });
    const observation = await getPool().query<{ obs_id: string }>(
      "SELECT obs_id FROM observations WHERE objective_id=$1",
      [OBJECTIVE],
    );
    expect(observation.rows).toHaveLength(1);
    if (result.state !== "pending") throw new Error("Expected a pending paid result.");
    expect(result.stepResults[0]).toMatchObject({ obsId: observation.rows[0]?.obs_id });
    await expect(
      getPool().query("SELECT state FROM steps WHERE plan_id=$1 AND step_index=0", [PLAN_ID]),
    ).resolves.toMatchObject({ rows: [{ state: "queued" }] });
    expect(chain.reserve).toHaveBeenCalledTimes(2);
    expect(
      sign.mock.calls.filter(
        ([, request]) =>
          request.kind === "vault-call" &&
          (request.payload as Record<string, unknown>)["selector"] === "reserve",
      ),
    ).toHaveLength(1);
    expect(chain.settle).toHaveBeenCalledTimes(1);
    expect(chain.settle).toHaveBeenCalledWith({
      reservationId: 4n,
      indices: [0],
      signedTransaction: expect.stringMatching(/^0x02/),
    });
    // SCR-159 §2: the saved finalize can still land (account nonce ≤ its nonce), so its bytes are sent again.
    expect(chain.finalize).toHaveBeenCalledTimes(2);
    expect(chain.finalize.mock.calls[1]?.[0]).toEqual(chain.finalize.mock.calls[0]?.[0]);
    const finalizeRanges = sign.mock.calls
      .map(([, request]) => request.payload as Record<string, unknown>)
      .filter((payload) => payload["selector"] === "finalize")
      .map((payload) => payload["args"]);
    expect(finalizeRanges).toEqual([{ reservationId: "4", fromIndex: "0", toIndex: "1" }]);
    expect(
      safeFetch.mock.calls.filter(([, options]) => !options?.headers?.["payment-signature"]),
    ).toHaveLength(1);
    expect(boundary).toHaveBeenCalledOnce();
    expect(recordReceipt).toHaveBeenCalledTimes(2);
    expect(recordReceipt.mock.calls[0]?.[0].paymentRef).toMatchObject({
      rail: "x402-exact",
      reservationId: 4,
      index: 0,
      settlementTx: HASH,
    });
    expect(sign.mock.calls.filter(([, request]) => request.kind === "usdc-3009")).toHaveLength(2);
    expect(successfulAuthorizationSignatures).toBe(1);
    const reservedValidBefore = String(Math.floor(Date.parse("2026-10-21T00:00:00Z") / 1000) + 30);
    for (const [, request] of sign.mock.calls.filter(([, r]) => r.kind === "usdc-3009"))
      expect((request.payload as Record<string, unknown>)["validBefore"]).toBe(reservedValidBefore);
    const paymentSignatures = safeFetch.mock.calls
      .map(([, options]) => options?.headers?.["payment-signature"])
      .filter((signature): signature is string => typeof signature === "string");
    expect(paymentSignatures.length).toBeGreaterThan(1);
    expect(new Set(paymentSignatures).size).toBe(1);
    await getPool().query("UPDATE steps SET calls_used=0 WHERE plan_id=$1 AND step_index=0", [
      PLAN_ID,
    ]);
    receiptAvailable = true;
    await expect(executeVaultDirectStep(input, dependencies)).resolves.toMatchObject({
      state: "done",
      stepResults: [{ ...stepResult, obsId: observation.rows[0]?.obs_id }],
    });
    expect(chain.settle).toHaveBeenCalledTimes(1);
    expect(successfulAuthorizationSignatures).toBe(1);
    expect(chain.finalize).toHaveBeenCalledTimes(3);
    await expect(
      getPool().query("SELECT state FROM steps WHERE plan_id=$1 AND step_index=0", [PLAN_ID]),
    ).resolves.toMatchObject({ rows: [{ state: "done" }] });
    await expect(
      getPool().query(
        "SELECT payload FROM step_executions WHERE plan_id=$1 AND step_index=0 AND phase='step.result'",
        [PLAN_ID],
      ),
    ).resolves.toMatchObject({
      rows: [{ payload: { stepResult: { ...stepResult, obsId: observation.rows[0]?.obs_id } } }],
    });
  });
});
