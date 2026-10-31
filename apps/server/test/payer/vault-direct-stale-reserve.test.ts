// SCR-153 §2: a saved `reserve.sent` whose transaction reverted `BadTtl()` gets a new attempt from CZ-15 §5.2
// step 1; when the step-2 formula cannot reach the vault's MIN_RESERVATION_TTL it ends `reserve-failed`.
// BadTtl is decided by the vault's condition on the mined block (saved validBefore < block.timestamp +
// MIN_RESERVATION_TTL), from the receipt and that block's header only. Any other revert ends the step
// `reserve-failed` / `reverted` (SCR-159 §2).
// SCR-155 §2: "now" in the step-2 formula and the TTL check is the latest block timestamp, never the server
// clock, and a step gets at most one new attempt for BadTtl, counted from the saved attempts.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { buildTree, derivedNonce, PAYEE_KIND, payeeLeaf } from "@czar/hashing";
import type { SignRequest, SignResult } from "@czar/signer";
import { buildPaymentRequired, encodeBase64Json, encodePaymentRequired } from "@czar/x402";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendExecutionPhase, getExecutionTrace } from "#src/payer/executions";
import {
  executeVaultDirectStep,
  MIN_RESERVATION_TTL_SECONDS,
  ReserveReverted,
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
const STALE_TX_HASH = `0x${"0a".repeat(32)}`;
const SECOND_TX_HASH = `0x${"0b".repeat(32)}`;
const FRESH_TX_HASH = `0x${"0c".repeat(32)}`;
/** A test-only K3 key generated per run; nothing is committed. */
const K3 = privateKeyToAccount(generatePrivateKey());
/** The saved reserve: nonce 0, which the fake chain's account nonce (0) has not passed. */
const STALE_SIGNED_RESERVE = await K3.signTransaction({
  type: "eip1559",
  chainId: 5042002,
  nonce: 0,
  gas: 100_000n,
  maxFeePerGas: 1n,
  maxPriorityFeePerGas: 1n,
  to: "0x0000000000000000000000000000000000000001",
  data: "0x",
});
const FRESH_SIGNED_RESERVE = "0xbeef02" as const;
const SIGNED_VAULT_CALL = "0x1234" as const;
const FRESH_RESERVATION_ID = 9n;
const UNIT_AMOUNT = 1000n;
const OFFER_TIMEOUT_SECONDS = 300;
const SIGNED_AT = new Date("2026-10-21T00:00:00Z");
/** The resume runs ten minutes after the stale reserve was signed: far past its validBefore. */
const RESUMED_AT = new Date(SIGNED_AT.getTime() + 600_000);
const STALE_VALID_BEFORE = BigInt(SIGNED_AT.getTime() / 1000 + 30);
/** The latest mined-block timestamp at which the vault still accepts `STALE_VALID_BEFORE`. */
const LAST_TIMESTAMP_IN_TTL = STALE_VALID_BEFORE - BigInt(MIN_RESERVATION_TTL_SECONDS);
/** One second later the vault's `BadTtl()` condition holds. */
const FIRST_TIMESTAMP_PAST_TTL = LAST_TIMESTAMP_IN_TTL + 1n;
const BAD_TTL_REVERT = { status: "reverted", blockTimestamp: FIRST_TIMESTAMP_PAST_TTL } as const;
/** SCR-155 §2: the chain's clock runs this far ahead of the server's. */
const CHAIN_AHEAD_SECONDS = 400;
/** A guard so an unbounded attempt loop fails the test instead of hanging it. */
const MAX_RESERVES_SENT = 3;
const LEAF = payeeLeaf(PAYEE, PAYEE_KIND.X402_PAY_TO, 0, UNIT_AMOUNT);
const OFFER = buildPaymentRequired({
  url: "http://127.0.0.1:4021/data",
  description: "local test merchant",
  serviceName: "fixture",
  tags: [],
  network: "eip155:5042002",
  amount: UNIT_AMOUNT.toString(),
  payTo: PAYEE,
  maxTimeoutSeconds: OFFER_TIMEOUT_SECONDS,
});
const TREE = buildTree([LEAF]);

beforeAll(async () => seedDevice(getPool()));
beforeEach(async () => {
  await getPool().query("DELETE FROM executor_leases");
  await getPool().query("DELETE FROM step_executions");
  await getPool().query("DELETE FROM steps");
  await getPool().query("DELETE FROM supplier_health");
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

describe("vault-direct stale saved reserve (SCR-153 §2)", () => {
  it("records the BadTtl revert and pays once through a new attempt with a fresh reserve", async () => {
    await seedStaleReserveSent();
    const run = paidRun({ outcome: BAD_TTL_REVERT });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    await expectStaleAttemptClosed();
    await expectFreshAttemptPaid(run);
    expect(run.chain.reserve).toHaveBeenCalledOnce();
  });

  it("starts a new attempt when the re-sent saved reserve reverts BadTtl", async () => {
    await seedStaleReserveSent();
    const run = paidRun({
      outcome: undefined,
      firstReserve: new ReserveReverted(STALE_TX_HASH, FIRST_TIMESTAMP_PAST_TTL),
    });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    expect(run.chain.reserve).toHaveBeenCalledTimes(2);
    expect(run.chain.reserve.mock.calls[0]?.[0].signedTransaction).toBe(STALE_SIGNED_RESERVE);
    await expectStaleAttemptClosed();
    await expectFreshAttemptPaid(run);
  });

  it("continues the new attempt after a crash right after the stale reserve.mined", async () => {
    await seedStaleReserveSent();
    await appendExecutionPhase(getPool(), {
      planId: PLAN_ID,
      stepIndex: 0,
      attempt: 0,
      phase: "reserve.mined",
      payload: { txHash: STALE_TX_HASH, message: "BadTtl" },
    });
    const run = paidRun({ outcome: BAD_TTL_REVERT });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    expect(run.chain.reserveOutcome).not.toHaveBeenCalled();
    await expectStaleAttemptClosed();
    await expectFreshAttemptPaid(run);
  });

  it("fails reserve-failed / BadTtl when envelope.expiresAt leaves no room for a fresh reserve", async () => {
    await seedStaleReserveSent();
    const run = paidRun({ outcome: BAD_TTL_REVERT });
    const expiresAt = new Date(RESUMED_AT.getTime() + (MIN_RESERVATION_TTL_SECONDS - 1) * 1000);

    await expect(executeVaultDirectStep(stepInput(expiresAt), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "reserve-failed",
    });

    await expectStaleAttemptClosed();
    expect(run.chain.reserve).not.toHaveBeenCalled();
    expect(signedSelectors(run.sign)).toEqual([]);
    expect(run.sign.mock.calls.filter(([, request]) => request.kind === "usdc-3009")).toEqual([]);
    const fresh = await getExecutionTrace(getPool(), PLAN_ID, 0, 1);
    expect(fresh.map((row) => row.phase)).toEqual(["step.failed"]);
    expect(fresh[0]?.payload).toEqual({
      errorCode: "reserve-failed",
      stepError: {
        schemaVersion: "1.0",
        code: "reserve-failed",
        message: "BadTtl",
        retryable: false,
      },
    });
    await expect(stepRow()).resolves.toEqual({ state: "failed", calls_used: 0 });
  });

  it("ends reserve-failed / reverted for a saved reserve whose mined block meets the TTL (SCR-159 §2)", async () => {
    await seedStaleReserveSent();
    const run = paidRun({ outcome: { status: "reverted", blockTimestamp: LAST_TIMESTAMP_IN_TTL } });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "reserve-failed",
    });

    expect(run.chain.reserve).not.toHaveBeenCalled();
    const stale = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
    expect(stale.map((row) => row.phase)).toEqual(["reserve.sent", "reserve.mined", "step.failed"]);
    expect(stale[1]?.payload).toEqual({ txHash: STALE_TX_HASH, outcome: "reverted" });
    expect(stale[2]?.payload).toEqual({
      errorCode: "reserve-failed",
      stepError: {
        schemaVersion: "1.0",
        code: "reserve-failed",
        message: "reverted",
        retryable: false,
      },
    });
    expect(await getExecutionTrace(getPool(), PLAN_ID, 0, 1)).toEqual([]);
    expect(signedSelectors(run.sign)).toEqual([]);
    await expect(stepRow()).resolves.toEqual({ state: "failed", calls_used: 0 });
  });
});

describe("vault-direct BadTtl attempt bound and chain time (SCR-155 §2)", () => {
  it("makes exactly one new attempt with validBefore from chain time when the chain runs 400 s ahead", async () => {
    await seedStaleReserveSent();
    const run = paidRun({ outcome: BAD_TTL_REVERT, chainAheadSeconds: CHAIN_AHEAD_SECONDS });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    await expectStaleAttemptClosed();
    await expectFreshAttemptPaid(run, CHAIN_AHEAD_SECONDS);
    expect(run.chain.reserve).toHaveBeenCalledOnce();
    expect(run.chain.latestBlockTimestamp).toHaveBeenCalled();
    expect(await getExecutionTrace(getPool(), PLAN_ID, 0, 2)).toEqual([]);
  });

  it("fails reserve-failed / BadTtl when chain time, not the server clock, leaves no room", async () => {
    await seedStaleReserveSent();
    const run = paidRun({ outcome: BAD_TTL_REVERT, chainAheadSeconds: CHAIN_AHEAD_SECONDS });
    const expiresAt = new Date(RESUMED_AT.getTime() + CHAIN_AHEAD_SECONDS * 1000);

    await expect(executeVaultDirectStep(stepInput(expiresAt), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "reserve-failed",
    });

    await expectStaleAttemptClosed();
    expect(run.chain.reserve).not.toHaveBeenCalled();
    const fresh = await getExecutionTrace(getPool(), PLAN_ID, 0, 1);
    expect(fresh.map((row) => row.phase)).toEqual(["step.failed"]);
    expect(fresh[0]?.payload).toEqual(BAD_TTL_FAILURE);
  });

  it("ends reserve-failed / BadTtl without a third attempt when the new attempt also reverts BadTtl", async () => {
    await seedStaleReserveSent();
    const freshValidBefore = BigInt(RESUMED_AT.getTime() / 1000 + OFFER_TIMEOUT_SECONDS);
    const run = paidRun({
      outcome: BAD_TTL_REVERT,
      firstReserve: new ReserveReverted(
        FRESH_TX_HASH,
        freshValidBefore - BigInt(MIN_RESERVATION_TTL_SECONDS) + 1n,
      ),
    });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "reserve-failed",
    });

    await expectStaleAttemptClosed();
    expect(run.chain.reserve).toHaveBeenCalledOnce();
    expect(run.chain.reserve.mock.calls[0]?.[0]).toMatchObject({
      signedTransaction: FRESH_SIGNED_RESERVE,
      validBefore: freshValidBefore,
    });
    const second = await getExecutionTrace(getPool(), PLAN_ID, 0, 1);
    expect(second.map((row) => row.phase)).toEqual([
      "reserve.sent",
      "reserve.mined",
      "step.failed",
    ]);
    expect(second[1]?.payload).toEqual({ txHash: FRESH_TX_HASH, message: "BadTtl" });
    expect(second[2]?.payload).toEqual(BAD_TTL_FAILURE);
    await expectNoThirdAttempt(run);
  });

  it("keeps the bound after a restart from saved rows with two BadTtl attempts", async () => {
    await seedStaleReserveSent();
    await closeAsBadTtl(0, STALE_TX_HASH);
    await seedStaleReserveSent(1, SECOND_TX_HASH);
    await closeAsBadTtl(1, SECOND_TX_HASH);
    const run = paidRun({ outcome: BAD_TTL_REVERT });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "reserve-failed",
    });

    expect(run.chain.reserve).not.toHaveBeenCalled();
    expect(run.chain.reserveOutcome).not.toHaveBeenCalled();
    const second = await getExecutionTrace(getPool(), PLAN_ID, 0, 1);
    expect(second.map((row) => row.phase)).toEqual([
      "reserve.sent",
      "reserve.mined",
      "step.failed",
    ]);
    expect(second[2]?.payload).toEqual(BAD_TTL_FAILURE);
    await expectNoThirdAttempt(run);
  });

  it("keeps the bound after a restart while the new attempt's saved reserve has no recorded outcome", async () => {
    await seedStaleReserveSent();
    await closeAsBadTtl(0, STALE_TX_HASH);
    await seedStaleReserveSent(1, SECOND_TX_HASH);
    const run = paidRun({ outcome: undefined, outcomes: { [SECOND_TX_HASH]: BAD_TTL_REVERT } });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "reserve-failed",
    });

    expect(run.chain.reserve).not.toHaveBeenCalled();
    expect(run.chain.reserveOutcome).toHaveBeenCalledWith(SECOND_TX_HASH);
    const second = await getExecutionTrace(getPool(), PLAN_ID, 0, 1);
    expect(second.map((row) => row.phase)).toEqual([
      "reserve.sent",
      "reserve.mined",
      "step.failed",
    ]);
    expect(second[1]?.payload).toEqual({ txHash: SECOND_TX_HASH, message: "BadTtl" });
    expect(second[2]?.payload).toEqual(BAD_TTL_FAILURE);
    await expectNoThirdAttempt(run);
  });
});

const BAD_TTL_FAILURE = {
  errorCode: "reserve-failed",
  stepError: { schemaVersion: "1.0", code: "reserve-failed", message: "BadTtl", retryable: false },
};

async function expectNoThirdAttempt(run: ReturnType<typeof paidRun>): Promise<void> {
  expect(await getExecutionTrace(getPool(), PLAN_ID, 0, 2)).toEqual([]);
  expect(
    signedSelectors(run.sign).filter((selector) => selector === "reserve").length,
  ).toBeLessThan(2);
  expect(run.sign.mock.calls.filter(([, request]) => request.kind === "usdc-3009")).toEqual([]);
  expect(
    run.safeFetch.mock.calls.filter(([, options]) => options?.headers?.["payment-signature"]),
  ).toEqual([]);
  await expect(stepRow()).resolves.toEqual({ state: "failed", calls_used: 0 });
}

async function closeAsBadTtl(attempt: number, txHash: string): Promise<void> {
  await appendExecutionPhase(getPool(), {
    planId: PLAN_ID,
    stepIndex: 0,
    attempt,
    phase: "reserve.mined",
    payload: { txHash, message: "BadTtl" },
  });
}

type ReserveOutcome = Awaited<ReturnType<NonNullable<VaultDirectChain["reserveOutcome"]>>>;

function paidRun(input: {
  readonly outcome: ReserveOutcome;
  readonly outcomes?: Readonly<Record<string, ReserveOutcome>>;
  readonly firstReserve?: Error;
  readonly chainAheadSeconds?: number;
}) {
  let current = RESUMED_AT;
  const chainNow = () =>
    BigInt(Math.floor(current.getTime() / 1000) + (input.chainAheadSeconds ?? 0));
  let settled = false;
  const sign = vi.fn(async (_caller: string, request: SignRequest): Promise<SignResult> => {
    if (request.kind === "usdc-3009")
      return { signature: `0x${"ab".repeat(65)}`, digest: HASH as `0x${string}` };
    const selector = (request.payload as Record<string, unknown>)["selector"];
    return { signedTransaction: selector === "reserve" ? FRESH_SIGNED_RESERVE : SIGNED_VAULT_CALL };
  });
  const reserve = vi.fn<VaultDirectChain["reserve"]>();
  // The vault's own BadTtl check, against chain time.
  reserve.mockImplementation(async (args) => {
    if (reserve.mock.calls.length > MAX_RESERVES_SENT)
      throw new Error("More reserve transactions sent than any bound allows.");
    if (args.validBefore < chainNow() + BigInt(MIN_RESERVATION_TTL_SECONDS))
      throw new ReserveReverted(FRESH_TX_HASH, chainNow());
    return { reservationId: FRESH_RESERVATION_ID, txHash: HASH };
  });
  if (input.firstReserve) reserve.mockRejectedValueOnce(input.firstReserve);
  const chain = {
    stepUsed: vi.fn(async () => 0n),
    envelopeCapacity: vi.fn(async () => ({ cap: UNIT_AMOUNT, exposure: 0n })),
    reserve,
    transactionCount: vi.fn(async () => 0),
    transactionStatus: vi.fn(async (): Promise<"success" | "reverted" | undefined> => undefined),
    latestBlockTimestamp: vi.fn(async () => chainNow()),
    reserveOutcome: vi.fn(async (txHash: string) => input.outcomes?.[txHash] ?? input.outcome),
    settle: vi.fn(async () => {
      settled = true;
      return HASH;
    }),
    authorizationState: vi.fn(async () => true),
    isSettled: vi.fn(async () => settled),
    finalize: vi.fn(async () => ({ txHash: HASH, final: true })),
  };
  const safeFetch = vi.fn(async (_url: string, options?: { headers?: Record<string, string> }) =>
    options?.headers?.["payment-signature"]
      ? {
          status: 200,
          url: "http://127.0.0.1:4021/data?q=one",
          headers: {
            "payment-response": encodeBase64Json({ success: true, transaction: HASH }),
          },
          body: new TextEncoder().encode('{"price":"ok"}'),
        }
      : {
          status: 402,
          url: "http://127.0.0.1:4021/data?q=one",
          headers: { "payment-required": encodePaymentRequired(OFFER) },
          body: new Uint8Array(),
        },
  );
  const dependencies: VaultDirectDependencies = {
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
    boundary: async (context) => ({
      schemaVersion: "1.1",
      stepIndex: 0,
      callIndex: context.callIndex,
      obsId: context.obsId,
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
  return { dependencies, chain, sign, safeFetch };
}

async function seedStaleReserveSent(attempt = 0, txHash = STALE_TX_HASH): Promise<void> {
  await appendExecutionPhase(getPool(), {
    planId: PLAN_ID,
    stepIndex: 0,
    attempt,
    phase: "reserve.sent",
    payload: {
      count: 1,
      payee: PAYEE,
      unitAmount: UNIT_AMOUNT.toString(),
      validBefore: STALE_VALID_BEFORE.toString(),
      txHash,
      signedTransaction: STALE_SIGNED_RESERVE,
      calls: [
        {
          index: 0,
          offer: OFFER.accepts[0],
          paymentRequired: OFFER,
          resource: { url: OFFER.resource.url, description: OFFER.resource.description },
        },
      ],
    },
  });
}

async function expectStaleAttemptClosed(): Promise<void> {
  const stale = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
  expect(stale.map((row) => row.phase)).toEqual(["reserve.sent", "reserve.mined"]);
  expect(stale[1]?.payload).toEqual({ txHash: STALE_TX_HASH, message: "BadTtl" });
}

async function expectFreshAttemptPaid(
  run: ReturnType<typeof paidRun>,
  chainAheadSeconds = 0,
): Promise<void> {
  const freshValidBefore = String(
    RESUMED_AT.getTime() / 1000 + chainAheadSeconds + OFFER_TIMEOUT_SECONDS,
  );
  const fresh = await getExecutionTrace(getPool(), PLAN_ID, 0, 1);
  expect(fresh.map((row) => row.phase)).toEqual([
    "reserve.sent",
    "reserve.mined",
    "auth.signed",
    "call.sent",
    "call.attempt",
    "call.response",
    "settle.sent",
    "settle.mined",
    "call.result",
    "finalize.sent",
    "finalize.mined",
    "step.result",
    "step.done",
  ]);
  expect(fresh[0]?.payload).toMatchObject({
    validBefore: freshValidBefore,
    signedTransaction: FRESH_SIGNED_RESERVE,
  });
  expect(fresh[1]?.payload).toMatchObject({ reservationId: FRESH_RESERVATION_ID.toString() });
  const reserveCalls = run.chain.reserve.mock.calls.map(([call]) => call);
  expect(reserveCalls.at(-1)).toMatchObject({
    signedTransaction: FRESH_SIGNED_RESERVE,
    validBefore: BigInt(freshValidBefore),
  });
  const reserveArgs = run.sign.mock.calls
    .map(([, request]) => request.payload as Record<string, unknown>)
    .filter((payload) => payload["selector"] === "reserve")
    .map((payload) => payload["args"]);
  expect(reserveArgs).toEqual([expect.objectContaining({ validBefore: freshValidBefore })]);
  const authorizations = run.sign.mock.calls.filter(([, request]) => request.kind === "usdc-3009");
  expect(authorizations.map(([, request]) => request.payload)).toEqual([
    expect.objectContaining({
      reservationId: FRESH_RESERVATION_ID.toString(),
      validBefore: freshValidBefore,
    }),
  ]);
  const authorization = fresh[2]?.payload["paymentPayload"] as {
    payload: { authorization: { nonce: string } };
  };
  expect(authorization.payload.authorization.nonce).toBe(
    derivedNonce(VAULT, FRESH_RESERVATION_ID, 0),
  );
  expect(run.chain.settle).toHaveBeenCalledOnce();
  expect(run.chain.finalize).toHaveBeenCalledOnce();
  await expect(stepRow()).resolves.toEqual({ state: "done", calls_used: 1 });
}

function signedSelectors(sign: ReturnType<typeof paidRun>["sign"]): unknown[] {
  return sign.mock.calls
    .filter(([, request]) => request.kind === "vault-call")
    .map(([, request]) => (request.payload as Record<string, unknown>)["selector"]);
}

async function stepRow(): Promise<{ state: string; calls_used: number } | undefined> {
  const result = await getPool().query<{ state: string; calls_used: number }>(
    "SELECT state,calls_used FROM steps WHERE plan_id=$1 AND step_index=0",
    [PLAN_ID],
  );
  return result.rows[0];
}

function stepInput(envelopeExpiresAt = new Date("2026-10-22T00:00:00Z")): VaultDirectInput {
  return {
    planId: PLAN_ID,
    envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
    envelopeId: 1n,
    envelopeExpiresAt,
    vault: VAULT,
    plan: {
      schemaVersion: "1.3",
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
      createdAt: SIGNED_AT.toISOString(),
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
