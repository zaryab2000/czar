// SCR-159 §2 for the saved `closeEnvelope`: nonce first, then the receipt. A status-0 receipt is recorded and
// the close fails without another send; no receipt with the account nonce ≤ saved nonce re-broadcasts the same
// bytes; no receipt with the account nonce > saved nonce signs the close again once.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "@czar/config";
import { getExecutionTrace } from "#src/payer/executions";
import { completeObjective, type CompletionChain } from "#src/objectives/completion";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const PLAN = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const ENVELOPE = "eip155:5042002:0x0000000000000000000000000000000000000001:1";
const VAULT = "0x0000000000000000000000000000000000000001" as const;
const HASH = `0x${"01".repeat(32)}`;
/** A test-only K3 key generated per run; nothing is committed. */
const K3 = privateKeyToAccount(generatePrivateKey());
const ARGS = {
  objectiveId: OBJECTIVE,
  planId: PLAN,
  envelopeRef: ENVELOPE,
  vault: VAULT,
  envelopeId: 1n,
};

beforeAll(async () => seedDevice(getPool()));
beforeEach(async () => {
  await getPool().query("DELETE FROM results");
  await getPool().query("DELETE FROM outbox_events");
  await getPool().query("DELETE FROM step_executions");
  await getPool().query("DELETE FROM steps");
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
      PLAN,
      ENVELOPE,
    ],
  );
  await getPool().query(
    `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES ($1,$2,'{}',$3,$4,'approved')`,
    [PLAN, OBJECTIVE, HASH, HASH],
  );
  await getPool().query(
    "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,'{}','failed')",
    [PLAN],
  );
});

describe("a saved closeEnvelope (SCR-159 §2)", () => {
  it("re-broadcasts the same bytes while the account nonce has not passed the saved nonce", async () => {
    const run = closeRun();
    run.chain.closeEnvelope.mockRejectedValueOnce(new Error("RPC dropped before broadcast"));
    await expect(completeObjective(ARGS, run.dependencies)).rejects.toThrow("RPC dropped");

    await expect(completeObjective(ARGS, run.dependencies)).resolves.toBe(true);

    const sent = run.chain.closeEnvelope.mock.calls.map(([input]) => input.transaction);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(run.sign).toHaveBeenCalledOnce();
  });

  it("signs the close again once when another K3 transaction took the saved nonce", async () => {
    const run = closeRun();
    run.chain.closeEnvelope.mockRejectedValueOnce(new Error("RPC dropped before broadcast"));
    await expect(completeObjective(ARGS, run.dependencies)).rejects.toThrow("RPC dropped");
    run.takeNextNonce();

    await expect(completeObjective(ARGS, run.dependencies)).resolves.toBe(true);

    const sent = run.chain.closeEnvelope.mock.calls.map(([input]) => input.transaction);
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
    expect(run.sign).toHaveBeenCalledTimes(2);
    const trace = await getExecutionTrace(getPool(), PLAN, 0, 0);
    expect(trace.map((row) => row.phase)).toEqual([
      "envelope.close.sent",
      "envelope.close.sent",
      "envelope.close.mined",
    ]);
    expect(trace.slice(0, 2).map((row) => row.payload["transaction"])).toEqual(sent);
  });

  it("records a reverted close once and never sends or signs it again", async () => {
    const run = closeRun();
    run.chain.closeEnvelope.mockImplementationOnce(async (input) => {
      run.mine(input.transaction, "reverted");
      throw new Error("RPC dropped before the receipt");
    });
    await expect(completeObjective(ARGS, run.dependencies)).rejects.toThrow("RPC dropped");

    await expect(completeObjective(ARGS, run.dependencies)).rejects.toThrow(
      "closeEnvelope reverted",
    );
    await expect(completeObjective(ARGS, run.dependencies)).rejects.toThrow(
      "closeEnvelope reverted",
    );

    expect(run.chain.closeEnvelope).toHaveBeenCalledOnce();
    expect(run.sign).toHaveBeenCalledOnce();
    const trace = await getExecutionTrace(getPool(), PLAN, 0, 0);
    expect(trace.map((row) => row.phase)).toEqual(["envelope.close.sent", "envelope.close.mined"]);
    expect(trace[1]?.payload).toEqual({
      txHash: keccak256(run.chain.closeEnvelope.mock.calls[0]![0].transaction),
      outcome: "reverted",
    });
  });
});

function closeRun() {
  let accountNonce = 0;
  let nextNonce = 0;
  let state: "Open" | "Closed" = "Open";
  const receipts = new Map<Hex, "success" | "reverted">();

  function mine(transaction: Hex, status: "success" | "reverted"): void {
    receipts.set(keccak256(transaction), status);
    accountNonce = Math.max(accountNonce, (parseTransaction(transaction).nonce ?? 0) + 1);
    if (status === "success") state = "Closed";
  }

  const sign = vi.fn(async () => {
    const signedTransaction = await K3.signTransaction({
      type: "eip1559",
      chainId: 5042002,
      nonce: Math.max(nextNonce, accountNonce),
      gas: 100_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      to: VAULT,
      data: "0x",
    });
    nextNonce = Math.max(nextNonce, accountNonce) + 1;
    return { signedTransaction };
  });
  const chain = {
    readEnvelope: vi.fn(async () => ({
      state,
      openReservations: 0n,
      openPockets: 0n,
      openJobs: 0n,
    })),
    closeEnvelope: vi.fn<CompletionChain["closeEnvelope"]>(async (input) => {
      const nonce = parseTransaction(input.transaction).nonce ?? 0;
      if (nonce < accountNonce) throw new Error("nonce too low");
      mine(input.transaction, "success");
      return keccak256(input.transaction);
    }),
    transactionCount: vi.fn(async (_address: `0x${string}`) => accountNonce),
    transactionStatus: vi.fn(async (txHash: `0x${string}`) => receipts.get(txHash)),
  } satisfies CompletionChain;
  return {
    sign,
    chain,
    mine,
    takeNextNonce: () => {
      accountNonce = Math.max(accountNonce, nextNonce);
    },
    dependencies: {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign },
      chain,
      now: () => new Date("2026-10-25T12:00:00Z"),
      random: { bytes: (size: number) => Buffer.alloc(size, 1) },
    },
  };
}
