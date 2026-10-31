// SCR-159 §3: after `finalize`, a step with at least one paid and accepted call ends `done` with those calls'
// results; each other reserved index is recorded per call as `unpaid` (no on-chain settlement) or
// `delivery-failed` (settled on chain, no usable body). A step with zero paid calls ends `failed` / `unpaid`.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import {
  buildTree,
  NO_RESPONSE_COMMIT,
  PAYEE_KIND,
  payeeLeaf,
  paymentRefHash,
} from "@czar/hashing";
import type { StepResult } from "@czar/schemas";
import type { SignRequest, SignResult } from "@czar/signer";
import {
  buildPaymentRequired,
  encodeBase64Json,
  encodePaymentRequired,
  SafeFetchError,
} from "@czar/x402";
import { completeObjective } from "#src/objectives/completion";
import {
  executeVaultDirectStep,
  type BoundaryInput,
  type SettledReceiptContext,
  type VaultDirectChain,
  type VaultDirectDependencies,
  type VaultDirectInput,
} from "#src/payer/vault-direct";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const ENVELOPE_REF = "eip155:5042002:0x0000000000000000000000000000000000000001:1";
const VAULT = "0x0000000000000000000000000000000000000001" as const;
const PAYEE = "0x0000000000000000000000000000000000000002" as const;
const HASH = `0x${"01".repeat(32)}`;
const MERCHANT_URL = "http://127.0.0.1:4021/data";
const RESERVATION_ID = 9n;
const UNIT_AMOUNT = 1000n;
const CALLS = 3;
const STEP_CAP = UNIT_AMOUNT * BigInt(CALLS);
const OFFER_TIMEOUT_SECONDS = 30;
const HTTP_OK = 200;
const HTTP_SERVER_ERROR = 500;
const MS_PER_SECOND = 1000;
const TREE = buildTree([payeeLeaf(PAYEE, PAYEE_KIND.X402_PAY_TO, 0, STEP_CAP)]);

/**
 * What the merchant does with call `i`'s paid request:
 * - `ok`: settles and returns a usable 2xx body.
 * - `error`: 5xx without settling.
 * - `settled-error`: settles, then returns a 5xx with its PAYMENT-RESPONSE and no usable body.
 * - `settled-empty`: settles and returns a 2xx with an empty body.
 * - `silent-settle`: settles on chain, then returns a 5xx with no PAYMENT-RESPONSE.
 * - `no-response`: settles on chain, then the transport fails before any response arrives.
 * - `blocked`: the safe-fetch boundary rejects the target before any merchant request.
 */
type MerchantMode =
  | "ok"
  | "error"
  | "settled-error"
  | "settled-empty"
  | "silent-settle"
  | "no-response"
  | "dns-failure"
  | "blocked";

beforeAll(async () => seedDevice(getPool()));
beforeEach(async () => {
  await getPool().query("DELETE FROM results");
  await getPool().query("DELETE FROM outbox_events");
  await getPool().query("DELETE FROM executor_leases");
  await getPool().query("DELETE FROM step_executions");
  await getPool().query("DELETE FROM steps");
  await getPool().query("DELETE FROM supplier_health");
  await getPool().query("DELETE FROM observations");
  await getPool().query("DELETE FROM plans");
  await getPool().query("DELETE FROM objectives");
  const submission = makeObjectiveSubmission(OBJECTIVE);
  await getPool().query(
    `INSERT INTO objectives
     (objective_id,user_id,device_id,submission,objective_hash,state,plan_id,envelope_ref)
     VALUES ($1,$2,$3,$4::jsonb,$5,'executing',$6,$7)`,
    [
      OBJECTIVE,
      TEST_USER_ID,
      submission.deviceId,
      JSON.stringify(submission),
      submission.objectiveHash,
      PLAN_ID,
      ENVELOPE_REF,
    ],
  );
  await getPool().query(
    `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES ($1,$2,'{}',$3,$4,'approved')`,
    [PLAN_ID, OBJECTIVE, HASH, HASH],
  );
  await getPool().query(
    "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,$2::jsonb,'queued')",
    [PLAN_ID, JSON.stringify({ payee: PAYEE })],
  );
});

describe("vault-direct partial steps (SCR-159 §3)", () => {
  it("ends done with the two paid results when one of three merchants returns 5xx, and the objective delivers", async () => {
    const run = partialRun(["ok", "error", "ok"]);

    const result = await executeVaultDirectStep(stepInput(), run.dependencies);

    expect(result.state).toBe("done");
    expect(result).toMatchObject({
      stepResults: [{ status: "delivered" }, { status: "delivered" }],
    });
    expect(await stepState()).toEqual({ state: "done", callsUsed: 2 });
    expect(await storedResultIndices()).toEqual([0, 2]);
    expect(await callErrors()).toEqual([{ index: 1, code: "unpaid" }]);
    expect(run.receiptIndices()).toEqual([0, 2]);
    expect(run.finalized()).toBe(true);

    await expect(completeObjective(completionInput(), completionDependencies())).resolves.toBe(
      true,
    );
    const objective = await getPool().query<{ state: string; result_id: string | null }>(
      "SELECT state,result_id FROM objectives WHERE objective_id=$1",
      [OBJECTIVE],
    );
    expect(objective.rows[0]?.state).toBe("delivered");
    expect(objective.rows[0]?.result_id).not.toBeNull();
    const delivered = await getPool().query<{ rendered_body: string }>(
      "SELECT rendered_body FROM results WHERE objective_id=$1",
      [OBJECTIVE],
    );
    expect(JSON.parse(delivered.rows[0]?.rendered_body ?? "{}").steps).toHaveLength(2);
  });

  it("ends failed with unpaid when all three merchants return 5xx", async () => {
    const run = partialRun(["error", "error", "error"]);

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "unpaid",
    });

    expect(await stepState()).toEqual({ state: "failed", callsUsed: 0 });
    expect(await failedStepError()).toMatchObject({
      errorCode: "unpaid",
      stepError: { schemaVersion: "1.0", code: "unpaid", retryable: false },
    });
    expect(await storedResultIndices()).toEqual([]);
    expect(await callErrors()).toEqual([
      { index: 0, code: "unpaid" },
      { index: 1, code: "unpaid" },
      { index: 2, code: "unpaid" },
    ]);
    expect(run.chain.settle).not.toHaveBeenCalled();
    expect(run.receiptIndices()).toEqual([]);
    expect(run.finalized()).toBe(true);
  });

  it("records a settled call with no usable body as delivery-failed and keeps its receipt", async () => {
    const run = partialRun(["ok", "settled-error", "settled-empty"]);

    const result = await executeVaultDirectStep(stepInput(), run.dependencies);

    expect(result.state).toBe("done");
    expect(result).toMatchObject({ stepResults: [{ status: "delivered" }] });
    expect(await stepState()).toEqual({ state: "done", callsUsed: 3 });
    expect(await storedResultIndices()).toEqual([0]);
    expect(await callErrors()).toEqual([
      { index: 1, code: "delivery-failed" },
      { index: 2, code: "delivery-failed" },
    ]);
    expect(run.settledIndices()).toEqual([0, 1, 2]);
    expect(run.receiptIndices()).toEqual([0, 1, 2]);
  });

  it("ends failed with delivery-failed when every paid call returned no usable body", async () => {
    const run = partialRun(["settled-error", "silent-settle", "error"]);

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "delivery-failed",
    });

    expect(await stepState()).toEqual({ state: "failed", callsUsed: 2 });
    expect(await failedStepError()).toMatchObject({
      errorCode: "delivery-failed",
      stepError: { code: "delivery-failed", retryable: false },
    });
    expect(await callErrors()).toEqual([
      { index: 0, code: "delivery-failed" },
      { index: 1, code: "delivery-failed" },
      { index: 2, code: "unpaid" },
    ]);
    expect(run.settledIndices()).toEqual([0, 1]);
    expect(run.receiptIndices()).toEqual([0]);
  });

  it("reconciles a settled authorization when the merchant returns no response", async () => {
    const run = partialRun(["ok", "no-response", "error"]);

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    expect(run.settledIndices()).toEqual([0, 1]);
    const observations = await getPool().query<{
      call_index: number;
      delivered: number | null;
      responded_at: Date | null;
      settled_at: Date | null;
    }>(
      `SELECT call_index,delivered,responded_at,settled_at FROM observations
       WHERE objective_id=$1 ORDER BY call_index`,
      [OBJECTIVE],
    );
    expect(observations.rows[1]).toMatchObject({
      call_index: 1,
      delivered: 0,
      responded_at: null,
      settled_at: expect.any(Date),
    });
    expect(run.receiptIndices()).toEqual([0, 1]);
    const trace = await getPool().query<{
      payload: { status: string; bodyCommit: string; bodyRef?: string };
    }>(
      `SELECT payload FROM step_executions WHERE plan_id=$1 AND phase='call.result'
       AND payload->>'callIndex'='1'`,
      [PLAN_ID],
    );
    expect(trace.rows[0]?.payload).toMatchObject({
      status: "no-response",
      bodyCommit: NO_RESPONSE_COMMIT,
      fields: [],
      flags: [],
    });
    expect(trace.rows[0]?.payload.bodyRef).toBeUndefined();
  });

  it("keeps DNS failure unattributed after a paid no-response call", async () => {
    const run = partialRun(["ok", "dns-failure", "error"]);
    await executeVaultDirectStep(stepInput(), run.dependencies);
    const observation = await getPool().query<{ delivered: number | null }>(
      "SELECT delivered FROM observations WHERE objective_id=$1 AND call_index=1",
      [OBJECTIVE],
    );
    expect(observation.rows[0]?.delivered).toBeNull();
    expect(await healthFactCount()).toBe(0);
  });

  it("keeps the paid step pending until an exact transfer proof is indexed", async () => {
    const run = partialRun(["ok", "no-response", "error"]);
    const dependencies = { ...run.dependencies, findExactTransferTx: async () => null };
    await expect(executeVaultDirectStep(stepInput(), dependencies)).resolves.toMatchObject({
      state: "pending",
    });
    expect(run.settledIndices()).toEqual([0, 1]);
    expect(run.receiptIndices()).toEqual([0]);
  });

  it("attributes an uninterrupted settled connection reset and records each retry outcome", async () => {
    const run = partialRun(["ok", "no-response", "error"]);
    await executeVaultDirectStep(stepInput(), run.dependencies);
    const observation = await getPool().query<{ delivered: number | null }>(
      "SELECT delivered FROM observations WHERE objective_id=$1 AND call_index=1",
      [OBJECTIVE],
    );
    expect(observation.rows[0]?.delivered).toBe(0);
    expect(await healthFactCount()).toBe(1);
    const attempts = await getPool().query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM step_executions WHERE plan_id=$1 AND phase='call.attempt'
       AND payload->>'index'='1' ORDER BY execution_id`,
      [PLAN_ID],
    );
    expect(attempts.rows.map((row) => row.payload["outcome"])).toEqual([
      "connection-reset",
      "connection-reset",
      "connection-reset",
    ]);
    for (const row of attempts.rows)
      expect(Object.keys(row.payload).toSorted()).toEqual(["index", "outcome", "retry"]);
  });

  it("keeps a crash-resumed no-response unattributed", async () => {
    const run = partialRun(["ok", "no-response", "error"], { crashPaidIndex: 1 });
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "simulated worker crash",
    );
    await executeVaultDirectStep(stepInput(), run.dependencies);
    const observation = await getPool().query<{ delivered: number | null }>(
      "SELECT delivered FROM observations WHERE objective_id=$1 AND call_index=1",
      [OBJECTIVE],
    );
    expect(observation.rows[0]?.delivered).toBeNull();
    expect(await healthFactCount()).toBe(0);
  });

  it("does not attribute a final transport failure after executor lease loss", async () => {
    const run = partialRun(["ok", "no-response", "error"]);
    let failures = 0;
    let leaseLost = false;
    const safeFetch: typeof run.dependencies.safeFetch = async (url, options) => {
      try {
        return await run.dependencies.safeFetch(url, options);
      } catch (error) {
        failures += 1;
        if (failures === 3) leaseLost = true;
        throw error;
      }
    };
    await expect(
      executeVaultDirectStep(
        {
          ...stepInput(),
          dispatchLease: {
            assertHeld: () => {
              if (leaseLost) throw new Error("simulated executor lease loss");
            },
          },
        },
        { ...run.dependencies, safeFetch },
      ),
    ).rejects.toThrow("simulated executor lease loss");
    await executeVaultDirectStep(stepInput(), run.dependencies);
    const observation = await getPool().query<{ delivered: number | null }>(
      "SELECT delivered FROM observations WHERE objective_id=$1 AND call_index=1",
      [OBJECTIVE],
    );
    expect(observation.rows[0]?.delivered).toBeNull();
    expect(await healthFactCount()).toBe(0);
  });

  it("does not retry a blocked fetch target", async () => {
    const run = partialRun(["blocked", "ok", "ok"]);

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "fetch-blocked: url",
    );
    expect(run.settledIndices()).toEqual([]);
  });

  it("stays pending without a terminal state while a paid call's receipt is not yet stored", async () => {
    const run = partialRun(["ok", "error", "ok"], { receiptStored: false });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "pending",
    });

    expect(await stepState()).toEqual({ state: "queued", callsUsed: 0 });
    expect(await callErrors()).toEqual([]);
  });
});

function partialRun(
  modes: readonly MerchantMode[],
  options: { receiptStored?: boolean; crashPaidIndex?: number } = {},
) {
  let current = new Date("2026-10-21T00:00:00Z");
  const chainNow = () => BigInt(Math.floor(current.getTime() / MS_PER_SECOND));
  const used = new Set<number>();
  const settled = new Set<number>();
  let final = false;
  let crashPending = options.crashPaidIndex;
  const receipts: number[] = [];
  const sign = vi.fn(async (_caller: string, request: SignRequest): Promise<SignResult> => {
    if (request.kind === "usdc-3009")
      return { signature: `0x${"ab".repeat(65)}`, digest: HASH as `0x${string}` };
    return { signedTransaction: "0x1234" };
  });
  const chain = {
    stepUsed: vi.fn(async () => 0n),
    envelopeCapacity: vi.fn(async () => ({ cap: STEP_CAP, exposure: 0n })),
    latestBlockTimestamp: vi.fn(async () => chainNow()),
    transactionCount: vi.fn(async (_address: `0x${string}`) => 0),
    transactionStatus: vi.fn(
      async (_txHash: `0x${string}`): Promise<"success" | "reverted" | undefined> => undefined,
    ),
    reserve: vi.fn<VaultDirectChain["reserve"]>(async () => ({
      reservationId: RESERVATION_ID,
      txHash: HASH,
    })),
    settle: vi.fn<VaultDirectChain["settle"]>(async ({ indices }) => {
      for (const index of indices) {
        if (!used.has(index)) throw new Error(`NotUsed(${index})`);
        settled.add(index);
      }
      return HASH;
    }),
    authorizationState: vi.fn<VaultDirectChain["authorizationState"]>(async ({ index }) =>
      used.has(index),
    ),
    isSettled: vi.fn<VaultDirectChain["isSettled"]>(async ({ index }) => settled.has(index)),
    // Like the vault: finalize books every used authorization as settled and releases the rest.
    finalize: vi.fn<VaultDirectChain["finalize"]>(async () => {
      for (const index of used) settled.add(index);
      final = true;
      return { txHash: HASH, final: true };
    }),
    reservationFinal: vi.fn(async () => final),
  };
  const safeFetch = vi.fn(
    async (url: string, fetchOptions?: { headers?: Record<string, string> }) => {
      if (!fetchOptions?.headers?.["payment-signature"]) return paymentRequired(url);
      const index = Number(new URL(url).searchParams.get("q")?.replace("call-", ""));
      const mode = modes[index];
      if (mode === undefined) throw new Error(`No merchant mode for call ${index}.`);
      if (crashPending === index) {
        crashPending = undefined;
        used.add(index);
        throw new Error("simulated worker crash");
      }
      if (mode === "blocked") throw new SafeFetchError("fetch-blocked", "url");
      if (mode === "dns-failure") {
        used.add(index);
        throw new SafeFetchError("fetch-blocked", "dns");
      }
      if (mode === "no-response") {
        used.add(index);
        throw new SafeFetchError("upstream-unavailable", "transport", "connection-reset");
      }
      return merchantResponse(url, mode, () => used.add(index));
    },
  );
  const boundary = vi.fn(async (context: BoundaryInput) => boundaryResult(context));
  const recordReceipt = vi.fn(async (context: SettledReceiptContext) => {
    receipts.push(context.index);
    return options.receiptStored ?? true;
  });
  const dependencies: VaultDirectDependencies = {
    pool: getPool(),
    config: loadConfig(),
    signer: { sign },
    chain,
    safeFetch,
    now: () => current,
    sleep: async (milliseconds) => {
      current = new Date(current.getTime() + milliseconds);
    },
    boundary,
    noResponseBoundary: async (context) => ({
      schemaVersion: "1.1",
      stepIndex: 0,
      callIndex: context.index,
      obsId: context.obsId,
      status: "no-response",
      source: {
        origin: "http://127.0.0.1:4021",
        payTo: PAYEE,
        paymentRefHash: paymentRefHash(context.paymentRef),
      },
      fields: [],
      flags: [],
      bodyCommit: NO_RESPONSE_COMMIT,
    }),
    recordReceipt,
    findExactTransferTx: async () => HASH,
    objects: { put: async () => "body-ref", get: async () => new Uint8Array() },
  };
  return {
    dependencies,
    chain,
    finalized: () => final,
    settledIndices: () => [...settled].toSorted((left, right) => left - right),
    receiptIndices: () => [...new Set(receipts)].toSorted((left, right) => left - right),
  };
}

async function healthFactCount(): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM supplier_health WHERE fact='settled-not-delivered'",
  );
  return Number(result.rows[0]?.count ?? "0");
}

function paymentRequired(url: string) {
  const offer = buildPaymentRequired({
    url: MERCHANT_URL,
    description: "local test merchant",
    serviceName: "fixture",
    tags: [],
    network: "eip155:5042002",
    amount: UNIT_AMOUNT.toString(),
    payTo: PAYEE,
    maxTimeoutSeconds: OFFER_TIMEOUT_SECONDS,
  });
  return {
    status: 402,
    url,
    headers: { "payment-required": encodePaymentRequired(offer) },
    body: new Uint8Array(),
  };
}

function merchantResponse(url: string, mode: MerchantMode, useAuthorization: () => void) {
  const settledHeader = {
    "content-type": "application/json",
    "payment-response": encodeBase64Json({
      success: true,
      transaction: HASH,
      network: "eip155:5042002",
    }),
  };
  if (mode === "error")
    return { status: HTTP_SERVER_ERROR, url, headers: {}, body: new Uint8Array() };
  useAuthorization();
  if (mode === "silent-settle")
    return { status: HTTP_SERVER_ERROR, url, headers: {}, body: new Uint8Array() };
  if (mode === "settled-error")
    return { status: HTTP_SERVER_ERROR, url, headers: settledHeader, body: new Uint8Array() };
  if (mode === "settled-empty")
    return { status: HTTP_OK, url, headers: settledHeader, body: new Uint8Array() };
  return {
    status: HTTP_OK,
    url,
    headers: settledHeader,
    body: new TextEncoder().encode('{"answer":"42"}'),
  };
}

/** Like the payer boundary: a body that fails the CZ-16 delivery check yields an `http-error` StepResult. */
function boundaryResult(context: BoundaryInput): StepResult {
  const usable =
    context.response.status >= HTTP_OK &&
    context.response.status < 300 &&
    context.response.body.byteLength > 0;
  return {
    schemaVersion: "1.1",
    stepIndex: 0,
    callIndex: context.index,
    obsId: context.obsId,
    status: usable ? "delivered" : "http-error",
    source: { origin: "http://127.0.0.1:4021", payTo: PAYEE, paymentRefHash: HASH },
    fields: usable ? [{ name: "answer", value: "42", confidence: 1 }] : [],
    flags: [],
    bodyCommit: HASH,
  };
}

function stepInput(): VaultDirectInput {
  return {
    planId: PLAN_ID,
    envelopeRef: ENVELOPE_REF,
    envelopeId: 1n,
    envelopeExpiresAt: new Date("2026-10-22T00:00:00Z"),
    vault: VAULT,
    plan: {
      schemaVersion: "1.2",
      planId: PLAN_ID,
      objectiveId: OBJECTIVE,
      objectiveHash: HASH,
      planHash: HASH,
      network: "eip155:5042002",
      category: "research",
      cap: STEP_CAP.toString(),
      slackBps: 0,
      maxStepAmount: STEP_CAP.toString(),
      pocketCapBps: 0,
      expiresAt: "2026-10-22T00:00:00.000Z",
      steps: [],
      payeeLeaves: [{ payee: PAYEE, kind: 1, stepIndex: 0, stepCap: STEP_CAP.toString() }],
      payeeRoot: TREE.root,
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
      resource: { url: MERCHANT_URL, method: "GET" },
      payee: PAYEE,
      unitAmount: UNIT_AMOUNT.toString(),
      expectedCalls: CALLS,
      stepCap: STEP_CAP.toString(),
      routingReason: "vault-direct",
      acceptanceProfileId: "prof_11111111111111111111111111111111",
      callInputs: Array.from({ length: CALLS }, (_, callIndex) => ({
        callIndex,
        input: { q: `call-${callIndex}` },
      })),
    },
    userId: TEST_USER_ID,
    deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
  };
}

function completionInput() {
  return {
    objectiveId: OBJECTIVE,
    planId: PLAN_ID,
    envelopeRef: ENVELOPE_REF,
    vault: VAULT,
    envelopeId: 1n,
  };
}

function completionDependencies() {
  return {
    pool: getPool(),
    config: loadConfig(),
    signer: { sign: vi.fn() },
    chain: {
      readEnvelope: vi.fn(async () => ({
        state: "Closed" as const,
        openReservations: 0n,
        openPockets: 0n,
        openJobs: 0n,
      })),
      closeEnvelope: vi.fn(),
      transactionCount: vi.fn(async (_address: `0x${string}`) => 0),
      transactionStatus: vi.fn(
        async (_txHash: `0x${string}`): Promise<"success" | "reverted" | undefined> => undefined,
      ),
    },
    now: () => new Date("2026-10-21T01:00:00Z"),
    random: { bytes: (size: number) => Buffer.alloc(size, 1) },
  };
}

async function stepState(): Promise<{ state: string; callsUsed: number }> {
  const result = await getPool().query<{ state: string; calls_used: number }>(
    "SELECT state,calls_used FROM steps WHERE plan_id=$1 AND step_index=0",
    [PLAN_ID],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Step row is missing.");
  return { state: row.state, callsUsed: row.calls_used };
}

async function storedResultIndices(): Promise<number[]> {
  const result = await getPool().query<{ index: number }>(
    `SELECT (payload->>'index')::int AS index FROM step_executions
     WHERE plan_id=$1 AND step_index=0 AND phase='step.result' ORDER BY 1`,
    [PLAN_ID],
  );
  return result.rows.map((row) => row.index);
}

async function callErrors(): Promise<{ index: number; code: string }[]> {
  const result = await getPool().query<{ payload: { index: number; code: string } }>(
    `SELECT payload FROM step_executions
     WHERE plan_id=$1 AND step_index=0 AND phase='call.error' ORDER BY (payload->>'index')::int`,
    [PLAN_ID],
  );
  return result.rows.map((row) => ({ index: row.payload.index, code: row.payload.code }));
}

async function failedStepError(): Promise<Record<string, unknown> | undefined> {
  const result = await getPool().query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM step_executions WHERE plan_id=$1 AND step_index=0 AND phase='step.failed'",
    [PLAN_ID],
  );
  return result.rows[0]?.payload;
}
