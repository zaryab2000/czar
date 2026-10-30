// SCR-157 §1: every CZ-15 vault-direct comparison against a deadline the chain enforces uses the latest block
// timestamp from a fresh read, never the server clock: the wait before `finalize`, the settlement_pending
// reconcile loop (until `validBefore + payer.reconcileGraceSeconds`) and call retries within `validBefore`
// (02 §7.5). A wait loop sleeps `payer.reconcileSeconds` and re-reads the block timestamp each time.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { buildTree, PAYEE_KIND, payeeLeaf } from "@czar/hashing";
import type { SignRequest, SignResult } from "@czar/signer";
import { buildPaymentRequired, encodeBase64Json, encodePaymentRequired } from "@czar/x402";
import { getExecutionTrace } from "#src/payer/executions";
import {
  executeVaultDirectStep,
  type VaultDirectChain,
  type VaultDirectDependencies,
  type VaultDirectInput,
} from "#src/payer/vault-direct";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const VAULT = "0x0000000000000000000000000000000000000001" as const;
const PAYEE = "0x0000000000000000000000000000000000000002" as const;
const HASH = `0x${"01".repeat(32)}`;
const RESERVATION_ID = 7n;
const UNIT_AMOUNT = 1000n;
const OFFER_TIMEOUT_SECONDS = 300;
const SERVER_START = new Date("2026-10-21T00:00:00Z");
/** SCR-157 §1: the chain's clock runs this far behind or ahead of the server's. */
const SKEW_SECONDS = 400;
/** A paid call that takes this long moves chain time on by the same amount. */
const SLOW_CALL_SECONDS = 200;
/** The merchant settles the pending payment this long before `validBefore`, by chain time. */
const LATE_SETTLE_LEAD_SECONDS = 10n;
const MS_PER_SECOND = 1000;
const config = loadConfig();
const RECONCILE_MS = Number(config.get("payer.reconcileSeconds")) * MS_PER_SECOND;
const RECONCILE_GRACE_SECONDS = BigInt(Number(config.get("payer.reconcileGraceSeconds")));
const CALL_RETRIES = Number(config.get("payer.callRetries"));
const LEAF = payeeLeaf(PAYEE, PAYEE_KIND.X402_PAY_TO, 0, UNIT_AMOUNT);
const TREE = buildTree([LEAF]);

beforeAll(async () => seedDevice(getPool()));
beforeEach(async () => {
  await getPool().query("DELETE FROM executor_leases");
  await getPool().query("DELETE FROM step_executions");
  await getPool().query("DELETE FROM steps");
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

describe("vault-direct chain time for every on-chain deadline (SCR-157 §1)", () => {
  it("does not send finalize until a block past validBefore exists when the chain runs 400 s behind", async () => {
    const run = skewedRun({ chainOffsetSeconds: -SKEW_SECONDS, merchant: "unpaid" });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "unpaid",
    });

    const validBefore = run.reservedValidBefore();
    expect(run.finalizeChainTimes).toHaveLength(1);
    expect(run.finalizeChainTimes[0]).toBeGreaterThan(validBefore);
  });

  it("re-reads the block timestamp on every wait iteration and sleeps payer.reconcileSeconds", async () => {
    const run = skewedRun({ chainOffsetSeconds: 0, merchant: "unpaid" });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "failed",
    });

    const sleeps = run.events.filter((event) => event.kind === "sleep");
    expect(sleeps.length).toBeGreaterThan(0);
    for (const sleep of sleeps) expect(sleep.milliseconds).toBe(RECONCILE_MS);
    const afterReserve = run.events.slice(
      run.events.findIndex((event) => event.kind === "reserve"),
    );
    const finalizeAt = afterReserve.findIndex((event) => event.kind === "finalize");
    const waits = afterReserve.slice(0, finalizeAt);
    for (const [index, event] of waits.entries()) {
      if (event.kind !== "sleep") continue;
      expect(waits[index + 1]?.kind).toBe("block");
    }
    expect(waits.at(-1)?.kind).toBe("block");
    expect(run.finalizeChainTimes[0]).toBeGreaterThan(run.reservedValidBefore());
  });

  it("keeps reconciling a settlement_pending call until validBefore + grace by chain time when the chain runs 400 s behind", async () => {
    const run = skewedRun({
      chainOffsetSeconds: -SKEW_SECONDS,
      merchant: "pending",
      settlesAt: (validBefore) => validBefore - LATE_SETTLE_LEAD_SECONDS,
    });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    expect(run.chain.settle).toHaveBeenCalledOnce();
    const trace = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
    expect(trace.at(-1)?.phase).toBe("step.done");
  });

  it("stops reconciling at validBefore + grace by chain time when the chain runs 400 s ahead", async () => {
    const run = skewedRun({ chainOffsetSeconds: SKEW_SECONDS, merchant: "pending" });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "unpaid",
    });

    const until = run.reservedValidBefore() + RECONCILE_GRACE_SECONDS;
    const polledAt = run.authorizationChainTimes;
    expect(polledAt.length).toBeGreaterThan(1);
    expect(Math.max(...polledAt.map(Number))).toBeLessThanOrEqual(Number(until));
    expect(Math.max(...polledAt.map(Number))).toBeGreaterThan(
      Number(until) - RECONCILE_MS / MS_PER_SECOND,
    );
    expect(run.chain.settle).not.toHaveBeenCalled();
    expect(run.finalizeChainTimes).toHaveLength(1);
  });

  it("does not end reserve-failed early and pays once when the chain runs 400 s ahead", async () => {
    const run = skewedRun({ chainOffsetSeconds: SKEW_SECONDS, merchant: "settled" });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    expect(run.chain.reserve).toHaveBeenCalledOnce();
    expect(run.reservedValidBefore()).toBe(
      BigInt(SERVER_START.getTime() / MS_PER_SECOND + SKEW_SECONDS + OFFER_TIMEOUT_SECONDS),
    );
    expect(run.chain.settle).toHaveBeenCalledOnce();
  });

  it("stops call retries once chain time reaches validBefore when the chain runs 400 s ahead", async () => {
    const run = skewedRun({
      chainOffsetSeconds: SKEW_SECONDS,
      merchant: "error",
      callSeconds: SLOW_CALL_SECONDS,
    });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "unpaid",
    });

    // The first send happens at chain time validBefore − 300 s, the second at − 100 s; a third would be
    // past validBefore, so the authorization could no longer settle.
    expect(run.paidSendChainTimes).toHaveLength(2);
    for (const sentAt of run.paidSendChainTimes)
      expect(sentAt).toBeLessThan(run.reservedValidBefore());
  });

  it("keeps every call retry while chain time is before validBefore when the chain runs 400 s behind", async () => {
    const run = skewedRun({ chainOffsetSeconds: -SKEW_SECONDS, merchant: "error" });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "unpaid",
    });

    expect(run.paidSendChainTimes).toHaveLength(CALL_RETRIES);
  });
});

type MerchantMode = "settled" | "pending" | "unpaid" | "error";
type RunEvent =
  | { readonly kind: "block" | "reserve" | "finalize" }
  | { readonly kind: "sleep"; readonly milliseconds: number };

/**
 * A mock chain whose latest block timestamp is the server clock plus `chainOffsetSeconds`; sleeping and slow
 * calls move both clocks on together, so each fresh read sees a later block.
 */
function skewedRun(input: {
  readonly chainOffsetSeconds: number;
  readonly merchant: MerchantMode;
  readonly settlesAt?: (validBefore: bigint) => bigint;
  readonly callSeconds?: number;
}) {
  let current = SERVER_START;
  const chainNow = () =>
    BigInt(Math.floor(current.getTime() / MS_PER_SECOND) + input.chainOffsetSeconds);
  const events: RunEvent[] = [];
  const finalizeChainTimes: bigint[] = [];
  const authorizationChainTimes: bigint[] = [];
  const paidSendChainTimes: bigint[] = [];
  let validBefore: bigint | undefined;
  const reservedValidBefore = (): bigint => {
    if (validBefore === undefined) throw new Error("No reserve was sent.");
    return validBefore;
  };
  let settled = false;
  const sign = vi.fn(async (_caller: string, request: SignRequest): Promise<SignResult> => {
    if (request.kind === "usdc-3009")
      return { signature: `0x${"ab".repeat(65)}`, digest: HASH as `0x${string}` };
    return { signedTransaction: "0x1234" };
  });
  const chain = {
    stepUsed: vi.fn(async () => 0n),
    envelopeCapacity: vi.fn(async () => ({ cap: UNIT_AMOUNT, exposure: 0n })),
    transactionCount: vi.fn(async () => 0),
    transactionStatus: vi.fn(async (): Promise<"success" | "reverted" | undefined> => undefined),
    latestBlockTimestamp: vi.fn(async () => {
      events.push({ kind: "block" });
      return chainNow();
    }),
    reserve: vi.fn<VaultDirectChain["reserve"]>(async (args) => {
      events.push({ kind: "reserve" });
      validBefore = args.validBefore;
      return { reservationId: RESERVATION_ID, txHash: HASH };
    }),
    settle: vi.fn(async () => {
      settled = true;
      return HASH;
    }),
    authorizationState: vi.fn(async () => {
      authorizationChainTimes.push(chainNow());
      if (input.merchant === "settled") return true;
      const settlesAt = input.settlesAt?.(reservedValidBefore());
      return settlesAt !== undefined && chainNow() >= settlesAt;
    }),
    isSettled: vi.fn(async () => settled),
    finalize: vi.fn(async () => {
      events.push({ kind: "finalize" });
      finalizeChainTimes.push(chainNow());
      return { txHash: HASH, final: true };
    }),
  };
  const safeFetch = vi.fn(async (_url: string, options?: { headers?: Record<string, string> }) => {
    if (!options?.headers?.["payment-signature"]) return paymentRequired();
    paidSendChainTimes.push(chainNow());
    current = new Date(current.getTime() + (input.callSeconds ?? 0) * MS_PER_SECOND);
    return merchantResponse(input.merchant);
  });
  const dependencies: VaultDirectDependencies = {
    pool: getPool(),
    config,
    signer: { sign },
    chain,
    safeFetch,
    now: () => current,
    sleep: async (milliseconds: number) => {
      events.push({ kind: "sleep", milliseconds });
      current = new Date(current.getTime() + milliseconds);
    },
    objects: { put: async () => "body-ref", get: async () => new Uint8Array() },
    boundary: async (context) => ({
      schemaVersion: "1.0",
      stepIndex: 0,
      status: "delivered",
      source: {
        origin: "http://127.0.0.1:4021",
        payTo: context.paymentPayload.payload.authorization.to,
        paymentRefHash: HASH,
      },
      fields: [],
      flags: [],
      bodyCommit: HASH,
    }),
    recordReceipt: async () => true,
  };
  return {
    dependencies,
    chain,
    events,
    finalizeChainTimes,
    authorizationChainTimes,
    paidSendChainTimes,
    reservedValidBefore,
  };
}

function paymentRequired() {
  const offer = buildPaymentRequired({
    url: "http://127.0.0.1:4021/data",
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
    url: "http://127.0.0.1:4021/data?q=one",
    headers: { "payment-required": encodePaymentRequired(offer) },
    body: new Uint8Array(),
  };
}

function merchantResponse(mode: MerchantMode) {
  const url = "http://127.0.0.1:4021/data?q=one";
  const body = new TextEncoder().encode('{"price":"ok"}');
  if (mode === "error") return { status: 502, url, headers: {}, body: new Uint8Array() };
  const settlement =
    mode === "settled"
      ? { success: true, transaction: HASH }
      : mode === "pending"
        ? { success: false, errorReason: "settlement_pending", transaction: HASH }
        : { success: false, errorReason: "invalid_payload" };
  return { status: 200, url, headers: { "payment-response": encodeBase64Json(settlement) }, body };
}

function stepInput(): VaultDirectInput {
  const envelopeExpiresAt = new Date("2026-10-22T00:00:00Z");
  return {
    planId: PLAN_ID,
    envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
    envelopeId: 1n,
    envelopeExpiresAt,
    vault: VAULT,
    plan: {
      schemaVersion: "1.2",
      planId: PLAN_ID,
      objectiveId: OBJECTIVE,
      objectiveHash: HASH,
      planHash: HASH,
      network: "eip155:5042002",
      category: "research",
      cap: UNIT_AMOUNT.toString(),
      slackBps: 0,
      maxStepAmount: UNIT_AMOUNT.toString(),
      pocketCapBps: 0,
      expiresAt: envelopeExpiresAt.toISOString(),
      steps: [],
      payeeLeaves: [
        {
          payee: PAYEE,
          kind: PAYEE_KIND.X402_PAY_TO,
          stepIndex: 0,
          stepCap: UNIT_AMOUNT.toString(),
        },
      ],
      payeeRoot: TREE.root,
      shadow: false,
      createdAt: SERVER_START.toISOString(),
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
      unitAmount: UNIT_AMOUNT.toString(),
      expectedCalls: 1,
      stepCap: UNIT_AMOUNT.toString(),
      routingReason: "vault-direct",
      acceptanceProfileId: "prof_11111111111111111111111111111111",
      callInputs: [{ callIndex: 0, input: { q: "one" } }],
    },
    userId: TEST_USER_ID,
    deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
  };
}
