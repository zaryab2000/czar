// SCR-159 §1: an attempt with a `reserve.sent` row never re-runs the pre-check; it resumes from its last saved
// phase and always reaches `finalize`.
// SCR-159 §2: a saved transaction is re-sent only while it can still land. Nonce first, then the receipt:
// a status-0 receipt (not BadTtl) ends the step; no receipt and account nonce ≤ saved nonce re-broadcasts the
// same bytes; no receipt and account nonce > saved nonce re-signs the same arguments once.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  keccak256,
  parseTransaction,
  stringToHex,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "@czar/config";
import { buildTree, PAYEE_KIND, payeeLeaf } from "@czar/hashing";
import type { SignRequest, SignResult } from "@czar/signer";
import { buildPaymentRequired, encodeBase64Json, encodePaymentRequired } from "@czar/x402";
import { getExecutionTrace } from "#src/payer/executions";
import {
  executeVaultDirectStep,
  MIN_RESERVATION_TTL_SECONDS,
  ReserveReverted,
  VaultTransactionReverted,
  type ReserveOutcome,
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
const HASH = `0x${"01".repeat(32)}` as const;
const RESERVATION_ID = 9n;
const UNIT_AMOUNT = 1000n;
const OFFER_TIMEOUT_SECONDS = 300;
const STARTED_AT = new Date("2026-10-21T00:00:00Z");
const STARTED_SECONDS = BigInt(STARTED_AT.getTime() / 1000);
const FIRST_VALID_BEFORE = STARTED_SECONDS + BigInt(OFFER_TIMEOUT_SECONDS);
/** A test-only K3 key generated per run; nothing is committed. */
const K3 = privateKeyToAccount(generatePrivateKey());
/** A guard so an unbounded re-send loop fails the test instead of hanging it. */
const MAX_SENDS = 4;

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

describe("a resumed attempt never re-runs the pre-check (SCR-159 §1)", () => {
  it("finalizes after reserve.mined when the merchant probe now answers 5xx", async () => {
    const run = paidRun();
    run.failNextAuthorization();
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "crash before auth.signed",
    );
    expect(await phases(0)).toEqual(["reserve.sent", "reserve.mined"]);

    run.merchantProbeDown();
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    expect(run.probes()).toBe(1);
    expect(run.chain.reserve).toHaveBeenCalledOnce();
    expect(run.chain.finalize).toHaveBeenCalledOnce();
    expect(await phases(0)).toEqual(PAID_PHASES);
    await expect(stepRow()).resolves.toEqual({ state: "done", calls_used: 1 });
  });

  it("finalizes after auth.signed when the merchant probe now answers 5xx", async () => {
    const run = paidRun();
    run.failNextPaidCall();
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "crash before the paid call",
    );
    expect(await phases(0)).toEqual(["reserve.sent", "reserve.mined", "auth.signed", "call.sent"]);

    run.merchantProbeDown();
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    expect(run.probes()).toBe(1);
    expect(run.authorizations()).toBe(1);
    expect(run.chain.finalize).toHaveBeenCalledOnce();
    await expect(stepRow()).resolves.toEqual({ state: "done", calls_used: 1 });
  });

  it("finishes after the pending return when the merchant probe now answers 5xx", async () => {
    const run = paidRun({ receiptStoredOnTry: 2 });
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "pending",
    });

    run.merchantProbeDown();
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    expect(run.probes()).toBe(1);
    expect(run.chain.reserve).toHaveBeenCalledOnce();
    expect(run.chain.finalize).toHaveBeenCalledOnce();
    await expect(stepRow()).resolves.toEqual({ state: "done", calls_used: 1 });
  });
});

describe("a saved reserve (SCR-159 §2)", () => {
  it("ends reserve-failed / reverted on a Paused revert and sends nothing more", async () => {
    const run = paidRun();
    run.chain.reserve.mockImplementationOnce(async (args) => {
      run.mine(args.signedTransaction, "reverted");
      throw new ReserveReverted(keccak256(args.signedTransaction), STARTED_SECONDS);
    });

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "reserve-failed",
    });
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "reserve-failed",
    });

    expect(run.chain.reserve).toHaveBeenCalledOnce();
    expect(run.vaultCalls()).toEqual(["reserve"]);
    expect(run.authorizations()).toBe(0);
    const trace = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
    expect(trace.map((row) => row.phase)).toEqual(["reserve.sent", "reserve.mined", "step.failed"]);
    expect(trace[1]?.payload).toEqual({ txHash: run.sentHashes()[0], outcome: "reverted" });
    expect(trace[2]?.payload).toEqual(REVERTED_FAILURE);
    expect(await getExecutionTrace(getPool(), PLAN_ID, 0, 1)).toEqual([]);
    await expect(stepRow()).resolves.toEqual({ state: "failed", calls_used: 0 });
  });

  it("ends reserve-failed / reverted on resume when the saved reserve's receipt shows a revert", async () => {
    const run = paidRun();
    run.chain.reserve.mockImplementationOnce(async (args) => {
      run.mine(args.signedTransaction, "reverted");
      throw new Error("RPC dropped before the receipt");
    });
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "RPC dropped",
    );

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "reserve-failed",
    });

    expect(run.chain.reserve).toHaveBeenCalledOnce();
    expect(run.vaultCalls()).toEqual(["reserve"]);
    expect(await phases(0)).toEqual(["reserve.sent", "reserve.mined", "step.failed"]);
  });

  it("re-broadcasts the same bytes while the account nonce has not passed the saved nonce", async () => {
    const run = paidRun();
    run.chain.reserve.mockRejectedValueOnce(new Error("RPC dropped before broadcast"));
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "RPC dropped",
    );

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    const sent = run.chain.reserve.mock.calls.map(([args]) => args.signedTransaction);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(run.vaultCalls().filter((selector) => selector === "reserve")).toHaveLength(1);
    expect(run.chain.transactionCount).toHaveBeenCalledWith(K3.address);
  });

  it("re-signs the same arguments once when another K3 transaction took the saved nonce", async () => {
    const run = paidRun();
    run.chain.reserve.mockRejectedValueOnce(new Error("RPC dropped before broadcast"));
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "RPC dropped",
    );
    run.takeNextNonce();

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    const reserveArgs = run.vaultArgs("reserve");
    expect(reserveArgs).toHaveLength(2);
    expect(reserveArgs[1]).toEqual(reserveArgs[0]);
    const sent = run.chain.reserve.mock.calls.map(([args]) => args.signedTransaction);
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
    const trace = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
    const reserveSent = trace.filter((row) => row.phase === "reserve.sent");
    expect(reserveSent.map((row) => row.payload["signedTransaction"])).toEqual(sent);
    expect(reserveSent[1]?.payload["validBefore"]).toBe(FIRST_VALID_BEFORE.toString());
    expect(run.authorizations()).toBe(1);
    await expect(stepRow()).resolves.toEqual({ state: "done", calls_used: 1 });
  });

  it("reads the account nonce before the receipt, so a reserve mined in between is never re-signed", async () => {
    const run = paidRun();
    run.chain.reserve.mockRejectedValueOnce(new Error("RPC dropped before the receipt"));
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "RPC dropped",
    );
    // The saved reserve lands between the resume's two chain reads.
    run.landAfterNextRead(run.savedReserve());

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    expect(run.vaultCalls().filter((selector) => selector === "reserve")).toHaveLength(1);
    expect(run.chain.reserve).toHaveBeenCalledOnce();
  });

  it("does not re-sign a mined reserve whose receipt a lagging RPC node has not served yet (review M3)", async () => {
    const run = paidRun();
    run.chain.reserve.mockRejectedValueOnce(new Error("RPC dropped before the receipt"));
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "RPC dropped",
    );
    // The saved reserve is mined: the count node is past its nonce, the receipt node lags one read.
    run.mine(run.savedReserve(), "success");
    run.chain.reserveOutcome.mockResolvedValueOnce(undefined);

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    expect(run.chain.reserve).toHaveBeenCalledOnce();
    const trace = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
    expect(trace.filter((row) => row.phase === "reserve.sent")).toHaveLength(1);
  });

  it("recomputes validBefore from chain time when the re-signed reserve's old one no longer clears the TTL", async () => {
    const run = paidRun();
    run.chain.reserve.mockRejectedValueOnce(new Error("RPC dropped before broadcast"));
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "RPC dropped",
    );
    run.takeNextNonce();
    const resumedSeconds = FIRST_VALID_BEFORE - BigInt(MIN_RESERVATION_TTL_SECONDS) + 1n;
    run.setChainTime(resumedSeconds);

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    const reserveArgs = run.vaultArgs("reserve");
    expect(reserveArgs).toHaveLength(2);
    // Review M3: "replaced" is confirmed after one `payer.reconcileSeconds` wait, so chain time has moved on.
    const confirmWait = BigInt(Number(run.dependencies.config.get("payer.reconcileSeconds")));
    const freshValidBefore = (
      resumedSeconds +
      confirmWait +
      BigInt(OFFER_TIMEOUT_SECONDS)
    ).toString();
    expect(reserveArgs[1]).toEqual({
      ...(reserveArgs[0] as Record<string, unknown>),
      validBefore: freshValidBefore,
    });
    const authorization = run.sign.mock.calls.find(([, request]) => request.kind === "usdc-3009");
    expect(authorization?.[1].payload).toMatchObject({ validBefore: freshValidBefore });
  });
});

describe("saved settle and finalize transactions (SCR-159 §2)", () => {
  it("re-broadcasts a saved finalize that can still land instead of signing another", async () => {
    const run = paidRun();
    run.chain.finalize.mockRejectedValueOnce(new Error("RPC dropped before broadcast"));
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "RPC dropped",
    );

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    const sent = run.chain.finalize.mock.calls.map(([args]) => args.signedTransaction);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(run.vaultCalls().filter((selector) => selector === "finalize")).toHaveLength(1);
  });

  it("re-signs a saved finalize once when another K3 transaction took its nonce", async () => {
    const run = paidRun();
    run.chain.finalize.mockRejectedValueOnce(new Error("RPC dropped before broadcast"));
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "RPC dropped",
    );
    run.takeNextNonce();

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    const sent = run.chain.finalize.mock.calls.map(([args]) => args.signedTransaction);
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
    expect(run.vaultArgs("finalize")).toEqual([FINALIZE_ARGS, FINALIZE_ARGS]);
    const finalizeSent = (await getExecutionTrace(getPool(), PLAN_ID, 0, 0)).filter(
      (row) => row.phase === "finalize.sent",
    );
    expect(finalizeSent.map((row) => row.payload["signedTransaction"])).toEqual(sent);
  });

  it("ends the step when a saved finalize reverted, without another finalize", async () => {
    const run = paidRun();
    run.chain.finalize.mockImplementationOnce(async (args) => {
      run.mine(args.signedTransaction, "reverted");
      throw new Error("Vault transaction reverted");
    });
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "Vault transaction reverted",
    );

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toEqual({
      state: "failed",
      errorCode: "reserve-failed",
    });

    expect(run.chain.finalize).toHaveBeenCalledOnce();
    expect(run.vaultCalls().filter((selector) => selector === "finalize")).toHaveLength(1);
    const trace = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
    expect(trace.at(-2)).toMatchObject({
      phase: "finalize.mined",
      payload: { start: 0, count: 1, outcome: "reverted" },
    });
    expect(trace.at(-1)).toMatchObject({
      phase: "step.failed",
      payload: {
        errorCode: "reserve-failed",
        stepError: {
          schemaVersion: "1.0",
          code: "reserve-failed",
          message: "finalize reverted",
          retryable: false,
        },
      },
    });
  });

  it("re-broadcasts a saved settle that can still land instead of signing another", async () => {
    const run = paidRun();
    run.chain.settle.mockRejectedValueOnce(new Error("RPC dropped before broadcast"));
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "RPC dropped",
    );

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    const sent = run.chain.settle.mock.calls.map(([args]) => args.signedTransaction);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(run.vaultCalls().filter((selector) => selector === "settle")).toHaveLength(1);
  });

  it("records a saved settle that reverted, sends no other settle, and still finalizes", async () => {
    const run = paidRun();
    run.chain.settle.mockImplementationOnce(async (args) => {
      run.mine(args.signedTransaction, "reverted");
      throw new Error("RPC dropped before the receipt");
    });
    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).rejects.toThrow(
      "RPC dropped",
    );

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    expect(run.chain.settle).toHaveBeenCalledOnce();
    expect(run.vaultCalls()).toEqual(["reserve", "settle", "finalize"]);
    expect(run.reservationIsFinal()).toBe(true);
    const trace = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
    expect(trace.find((row) => row.phase === "settle.mined")?.payload).toMatchObject({
      indices: [0],
      outcome: "reverted",
    });
    expect(run.receiptIndices()).toEqual([0]);
    await expect(stepRow()).resolves.toEqual({ state: "done", calls_used: 1 });
  });
});

describe("a reverted settle or finalize still reaches a Final reservation (review M2)", () => {
  it("finalizes the rest after a third party finalized index 0 and our settle reverted AlreadyDone", async () => {
    const run = paidRun({ calls: 2 });
    run.thirdPartyFinalizeBefore("settle", 0, 1);

    await expect(executeVaultDirectStep(stepInput(2), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    expect(run.vaultCalls()).toEqual(["reserve", "settle", "finalize"]);
    expect(run.vaultArgs("finalize")).toEqual([
      { reservationId: RESERVATION_ID.toString(), fromIndex: "0", toIndex: "2" },
    ]);
    expect(run.reservationIsFinal()).toBe(true);
    const trace = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
    expect(trace.find((row) => row.phase === "settle.mined")?.payload).toMatchObject({
      indices: [0, 1],
      outcome: "reverted",
    });
    expect(trace.find((row) => row.phase === "finalize.mined")?.payload).not.toHaveProperty(
      "outcome",
    );
    expect(run.receiptIndices().toSorted()).toEqual([0, 1]);
    await expect(stepRow()).resolves.toEqual({ state: "done", calls_used: 2 });
  });

  it("completes from on-chain facts when the reservation is already Final and settle reverts ReservationNotActive", async () => {
    const run = paidRun();
    run.thirdPartyFinalizeBefore("settle", 0, 1);

    await expect(executeVaultDirectStep(stepInput(), run.dependencies)).resolves.toMatchObject({
      state: "done",
    });

    expect(run.vaultCalls()).toEqual(["reserve", "settle"]);
    expect(run.chain.finalize).not.toHaveBeenCalled();
    expect(run.reservationIsFinal()).toBe(true);
    expect(run.receiptIndices()).toEqual([0]);
    expect(await phases(0)).toContain("settle.mined");
    await expect(stepRow()).resolves.toEqual({ state: "done", calls_used: 1 });
  });

  it("completes the step when our finalize reverts because a third party already made the reservation Final", async () => {
    const run = paidRun({ calls: 2 });
    run.leaveUnused(1);
    run.thirdPartyFinalizeBefore("finalize", 0, 2);

    const result = await executeVaultDirectStep(stepInput(2), run.dependencies);

    expect(run.chain.finalize).toHaveBeenCalledOnce();
    expect(run.reservationIsFinal()).toBe(true);
    const trace = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
    expect(trace.find((row) => row.phase === "finalize.mined")?.payload).toMatchObject({
      start: 0,
      count: 2,
      outcome: "reverted",
    });
    // The step ends by the settled facts, never by the reverted finalize.
    expect(trace.at(-1)?.payload["stepError"]).toBeUndefined();
    // SCR-159 §3 (#171): one paid call of two, so the step is done and index 1 is recorded unpaid.
    expect(result).toMatchObject({ state: "done" });
  });
});

const PAID_PHASES = [
  "reserve.sent",
  "reserve.mined",
  "auth.signed",
  "call.sent",
  "call.response",
  "settle.sent",
  "settle.mined",
  "call.result",
  "finalize.sent",
  "finalize.mined",
  "step.result",
  "step.done",
];

const FINALIZE_ARGS = { reservationId: RESERVATION_ID.toString(), fromIndex: "0", toIndex: "1" };

const REVERTED_FAILURE = {
  errorCode: "reserve-failed",
  stepError: {
    schemaVersion: "1.0",
    code: "reserve-failed",
    message: "reverted",
    retryable: false,
  },
};

function paidRun(options: { readonly receiptStoredOnTry?: number; readonly calls?: number } = {}) {
  const calls = options.calls ?? 1;
  let chainSeconds = STARTED_SECONDS;
  let accountNonce = 0;
  let nextNonce = 0;
  let probeDown = false;
  let failAuthorization = false;
  let failPaidCall = false;
  let receiptTries = 0;
  let sends = 0;
  let landAfterRead: Hex | undefined;
  const receipts = new Map<Hex, "success" | "reverted">();
  const settled = new Set<number>();
  /** The vault's `doneMask`: indices settled or released. */
  const done = new Set<number>();
  /** Indices whose authorization was never used: `finalize` releases them. */
  const unused = new Set<number>();
  let final = false;
  let beforeNextVaultSend: { selector: "settle" | "finalize"; run: () => void } | undefined;
  const receiptIndices: number[] = [];

  function finalizeIfDone(): void {
    if (done.size === calls) final = true;
  }

  /**
   * `ReservationLogic.settle`: reverts `ReservationNotActive` once Final and `AlreadyDone` on a done index. Unlike
   * the vault it never makes the reservation Final itself, so these runs always reach the finalize path.
   */
  function vaultSettle(indices: readonly number[]): boolean {
    if (final || indices.some((index) => done.has(index))) return false;
    for (const index of indices) {
      settled.add(index);
      done.add(index);
    }
    return true;
  }

  /** `ReservationLogic.finalize`: permissionless; books used authorizations, releases the rest. */
  function vaultFinalize(start: number, count: number): boolean {
    if (final) return false;
    for (let index = start; index < start + count; index += 1) {
      if (done.has(index)) continue;
      if (!unused.has(index)) settled.add(index);
      done.add(index);
    }
    finalizeIfDone();
    return true;
  }

  /** Lands a vault call; a call the vault refuses mines with status 0. */
  function sendVault(
    selector: "settle" | "finalize",
    signedTransaction: Hex,
    apply: () => boolean,
  ) {
    if (beforeNextVaultSend?.selector === selector) {
      beforeNextVaultSend.run();
      beforeNextVaultSend = undefined;
    }
    const nonce = parseTransaction(signedTransaction).nonce ?? 0;
    if (nonce >= accountNonce && !apply()) {
      sends += 1;
      mine(signedTransaction, "reverted");
      throw new VaultTransactionReverted(keccak256(signedTransaction));
    }
    return land(signedTransaction);
  }

  function mine(signedTransaction: Hex, status: "success" | "reverted"): void {
    receipts.set(keccak256(signedTransaction), status);
    const nonce = parseTransaction(signedTransaction).nonce ?? 0;
    accountNonce = Math.max(accountNonce, nonce + 1);
  }

  /** Lands `landAfterRead` once the read in progress has returned its pre-landing value. */
  function afterRead<T>(value: T): T {
    if (landAfterRead !== undefined) mine(landAfterRead, "success");
    landAfterRead = undefined;
    return value;
  }

  function land(signedTransaction: Hex): Hex {
    sends += 1;
    if (sends > MAX_SENDS) throw new Error("More transactions sent than any bound allows.");
    const nonce = parseTransaction(signedTransaction).nonce ?? 0;
    if (nonce < accountNonce && !receipts.has(keccak256(signedTransaction)))
      throw new Error("nonce too low");
    mine(signedTransaction, "success");
    return keccak256(signedTransaction);
  }

  const sign = vi.fn(async (_caller: string, request: SignRequest): Promise<SignResult> => {
    if (request.kind === "usdc-3009") {
      if (failAuthorization) {
        failAuthorization = false;
        throw new Error("crash before auth.signed");
      }
      return { signature: `0x${"ab".repeat(65)}`, digest: HASH };
    }
    const payload = request.payload as { selector: string };
    const transaction: TransactionSerializableEIP1559 = {
      type: "eip1559",
      chainId: 5042002,
      nonce: Math.max(nextNonce, accountNonce),
      gas: 100_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      to: VAULT,
      data: stringToHex(payload.selector),
    };
    nextNonce = (transaction.nonce ?? 0) + 1;
    return { signedTransaction: await K3.signTransaction(transaction) };
  });

  const chain = {
    stepUsed: vi.fn(async () => 0n),
    envelopeCapacity: vi.fn(async () => ({ cap: UNIT_AMOUNT * BigInt(calls), exposure: 0n })),
    latestBlockTimestamp: vi.fn(async () => chainSeconds),
    reserve: vi.fn<VaultDirectChain["reserve"]>(async (args) => ({
      reservationId: RESERVATION_ID,
      txHash: land(args.signedTransaction),
    })),
    reserveOutcome: vi.fn(async (txHash: string): Promise<ReserveOutcome | undefined> => {
      const status = receipts.get(txHash as Hex);
      if (status === "success")
        return afterRead({ status: "reserved", reservationId: RESERVATION_ID } as const);
      if (status === "reverted")
        return afterRead({ status: "reverted", blockTimestamp: chainSeconds } as const);
      return afterRead(undefined);
    }),
    transactionCount: vi.fn(async (_address: `0x${string}`) => afterRead(accountNonce)),
    transactionStatus: vi.fn(async (txHash: `0x${string}`) => receipts.get(txHash)),
    settle: vi.fn<VaultDirectChain["settle"]>(async (args) =>
      sendVault("settle", args.signedTransaction, () => vaultSettle(args.indices)),
    ),
    authorizationState: vi.fn(async ({ index }: { index: number }) => !unused.has(index)),
    isSettled: vi.fn(async ({ index }: { index: number }) => settled.has(index)),
    finalize: vi.fn<VaultDirectChain["finalize"]>(async (args) => {
      const txHash = sendVault("finalize", args.signedTransaction, () =>
        vaultFinalize(args.start, args.count),
      );
      return { txHash, final };
    }),
    reservationFinal: vi.fn(async () => final),
  } satisfies VaultDirectChain;

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
  const safeFetch = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
    if (init?.headers?.["payment-signature"]) {
      if (failPaidCall) {
        failPaidCall = false;
        throw new Error("crash before the paid call");
      }
      return {
        status: 200,
        url: "http://127.0.0.1:4021/data?q=one",
        headers: { "payment-response": encodeBase64Json({ success: true, transaction: HASH }) },
        body: new TextEncoder().encode('{"price":"ok"}'),
      };
    }
    if (probeDown)
      return {
        status: 503,
        url: "http://127.0.0.1:4021/data?q=one",
        headers: {},
        body: new Uint8Array(),
      };
    return {
      status: 402,
      url: "http://127.0.0.1:4021/data?q=one",
      headers: { "payment-required": encodePaymentRequired(offer) },
      body: new Uint8Array(),
    };
  });

  const dependencies: VaultDirectDependencies = {
    pool: getPool(),
    config: loadConfig(),
    signer: { sign },
    chain,
    safeFetch,
    now: () => new Date(Number(chainSeconds) * 1000),
    sleep: async (milliseconds: number) => {
      chainSeconds += BigInt(Math.ceil(milliseconds / 1000));
    },
    objects: { put: async () => "body-ref", get: async () => new Uint8Array() },
    boundary: async (context) => ({
      schemaVersion: "1.1",
      stepIndex: 0,
      callIndex: context.index,
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
    recordReceipt: async (context) => {
      receiptIndices.push(context.index);
      receiptTries += 1;
      return receiptTries >= (options.receiptStoredOnTry ?? 1);
    },
  };

  const vaultRequests = () =>
    sign.mock.calls
      .filter(([, request]) => request.kind === "vault-call")
      .map(([, request]) => request.payload as { selector: string; args: unknown });

  return {
    dependencies,
    chain,
    sign,
    mine,
    merchantProbeDown: () => {
      probeDown = true;
    },
    failNextAuthorization: () => {
      failAuthorization = true;
    },
    failNextPaidCall: () => {
      failPaidCall = true;
    },
    /** Another K3 transaction (for example the freeze handler's `lowerAutoLimit`) lands on the next nonce. */
    takeNextNonce: () => {
      accountNonce = Math.max(accountNonce, nextNonce);
    },
    landAfterNextRead: (signedTransaction: Hex) => {
      landAfterRead = signedTransaction;
    },
    setChainTime: (seconds: bigint) => {
      chainSeconds = seconds;
    },
    /** Another account calls the permissionless `finalize` just before our next `selector` lands. */
    thirdPartyFinalizeBefore: (selector: "settle" | "finalize", start: number, count: number) => {
      beforeNextVaultSend = { selector, run: () => vaultFinalize(start, count) };
    },
    reservationIsFinal: () => final,
    leaveUnused: (index: number) => {
      unused.add(index);
    },
    receiptIndices: () => receiptIndices,
    probes: () =>
      safeFetch.mock.calls.filter(([, init]) => !init?.headers?.["payment-signature"]).length,
    authorizations: () =>
      sign.mock.calls.filter(([, request]) => request.kind === "usdc-3009").length,
    vaultCalls: () => vaultRequests().map((payload) => payload.selector),
    vaultArgs: (selector: string) =>
      vaultRequests()
        .filter((payload) => payload.selector === selector)
        .map((payload) => payload.args),
    sentHashes: () => chain.reserve.mock.calls.map(([args]) => keccak256(args.signedTransaction)),
    savedReserve: () => {
      const args = chain.reserve.mock.calls.at(-1)?.[0];
      if (!args) throw new Error("No reserve was sent.");
      return args.signedTransaction;
    },
  };
}

async function phases(attempt: number): Promise<string[]> {
  return (await getExecutionTrace(getPool(), PLAN_ID, 0, attempt)).map((row) => row.phase);
}

async function stepRow(): Promise<{ state: string; calls_used: number } | undefined> {
  const result = await getPool().query<{ state: string; calls_used: number }>(
    "SELECT state,calls_used FROM steps WHERE plan_id=$1 AND step_index=0",
    [PLAN_ID],
  );
  return result.rows[0];
}

function stepInput(calls = 1): VaultDirectInput {
  const envelopeExpiresAt = new Date("2026-10-22T00:00:00Z");
  const stepCap = (UNIT_AMOUNT * BigInt(calls)).toString();
  const tree = buildTree([payeeLeaf(PAYEE, PAYEE_KIND.X402_PAY_TO, 0, BigInt(stepCap))]);
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
      cap: stepCap,
      slackBps: 0,
      maxStepAmount: stepCap,
      pocketCapBps: 0,
      expiresAt: envelopeExpiresAt.toISOString(),
      steps: [],
      payeeLeaves: [
        {
          payee: PAYEE,
          kind: PAYEE_KIND.X402_PAY_TO,
          stepIndex: 0,
          stepCap,
        },
      ],
      payeeRoot: tree.root,
      shadow: false,
      createdAt: STARTED_AT.toISOString(),
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
      expectedCalls: calls,
      stepCap,
      routingReason: "vault-direct",
      acceptanceProfileId: "prof_11111111111111111111111111111111",
      callInputs: Array.from({ length: calls }, (_, callIndex) => ({
        callIndex,
        input: { q: `call-${callIndex}` },
      })),
    },
    userId: TEST_USER_ID,
    deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
  };
}
