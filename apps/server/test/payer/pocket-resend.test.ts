// SCR-159 §2 for the saved pocket register, gas and fund transactions (K3): nonce first, then the receipt. No
// receipt with the account nonce ≤ saved nonce re-broadcasts the same bytes; no receipt with the account nonce
// > saved nonce signs the same arguments again once; a status-0 receipt fails without another send.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, stringToHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "@czar/config";
import { buildTree, pocketLeaf } from "@czar/hashing";
import type { SignRequest } from "@czar/signer";
import { getExecutionTrace } from "#src/payer/executions";
import { executePocketPreparation, type PocketPreparationChain } from "#src/payer/pocket";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const POCKET = "0x0000000000000000000000000000000000000001" as const;
const VAULT = "0x0000000000000000000000000000000000000002" as const;
/** A test-only K3 key generated per run; nothing is committed. */
const K3 = privateKeyToAccount(generatePrivateKey());
const INPUT = {
  planId: PLAN_ID,
  envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000002:1",
  envelopeId: 1n,
  vault: VAULT,
  plan: {
    payeeRoot: buildTree([pocketLeaf(POCKET)]).root,
    payeeLeaves: [{ payee: POCKET, kind: 4 as const, stepIndex: 4294967295, stepCap: "0" }],
    pocketCapBps: 2500,
    cap: "1000000",
    steps: [{ stepIndex: 0, kind: "gateway-nano" as const, stepCap: "250000" }],
  },
  attempt: 0,
};

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
  await getPool().query("INSERT INTO plan_pocket_keys(plan_id,pocket_address) VALUES($1,$2)", [
    PLAN_ID,
    POCKET,
  ]);
});

describe("saved pocket transactions (SCR-159 §2)", () => {
  it("re-broadcasts a saved registerPocket while the account nonce has not passed its nonce", async () => {
    const run = pocketRun();
    run.chain.registerPocket.mockRejectedValueOnce(new Error("RPC dropped before broadcast"));
    await expect(executePocketPreparation(INPUT, run.dependencies)).rejects.toThrow("RPC dropped");

    await expect(executePocketPreparation(INPUT, run.dependencies)).resolves.toMatchObject({
      pocket: POCKET,
    });

    const sent = run.chain.registerPocket.mock.calls.map(([args]) => args.transaction);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(run.vaultCalls("registerPocket")).toHaveLength(1);
  });

  it("signs registerPocket again once when another K3 transaction took the saved nonce", async () => {
    const run = pocketRun();
    run.chain.registerPocket.mockRejectedValueOnce(new Error("RPC dropped before broadcast"));
    await expect(executePocketPreparation(INPUT, run.dependencies)).rejects.toThrow("RPC dropped");
    run.takeNextNonce();

    await expect(executePocketPreparation(INPUT, run.dependencies)).resolves.toMatchObject({
      pocket: POCKET,
    });

    const sent = run.chain.registerPocket.mock.calls.map(([args]) => args.transaction);
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
    const registerArgs = run.vaultCalls("registerPocket");
    expect(registerArgs).toHaveLength(2);
    expect(registerArgs[1]).toEqual(registerArgs[0]);
    const saved = (await getExecutionTrace(getPool(), PLAN_ID, 0, 0)).filter(
      (row) => row.phase === "pocket.register.sent",
    );
    expect(saved.map((row) => row.payload["transaction"])).toEqual(sent);
  });

  it("fails a saved fundPocket that reverted without sending or signing it again", async () => {
    const run = pocketRun();
    run.chain.fundPocket.mockImplementationOnce(async (args) => {
      run.mine(args.transaction, "reverted");
      throw new Error("Pocket transaction reverted");
    });
    await expect(executePocketPreparation(INPUT, run.dependencies)).rejects.toThrow(
      "Pocket transaction reverted",
    );

    await expect(executePocketPreparation(INPUT, run.dependencies)).rejects.toThrow(
      "Pocket transaction reverted",
    );

    expect(run.chain.fundPocket).toHaveBeenCalledOnce();
    expect(run.vaultCalls("fundPocket")).toHaveLength(1);
  });
});

function pocketRun() {
  let accountNonce = 0;
  let nextNonce = 0;
  const receipts = new Map<Hex, "success" | "reverted">();
  let registered = false;
  let granted = 0n;
  let funded = false;

  function mine(transaction: Hex, status: "success" | "reverted"): void {
    receipts.set(keccak256(transaction), status);
    accountNonce = Math.max(accountNonce, (parseTransaction(transaction).nonce ?? 0) + 1);
  }

  function land(transaction: Hex): string {
    const nonce = parseTransaction(transaction).nonce ?? 0;
    if (nonce < accountNonce) throw new Error("nonce too low");
    mine(transaction, "success");
    return keccak256(transaction);
  }

  const sign = vi.fn(async (_caller: string, request: SignRequest) => {
    if (request.kind === "pocket-delegate")
      return { signedTransaction: `0x${"0d".repeat(8)}` as Hex };
    const payload = request.payload as { selector: string };
    const signedTransaction = await K3.signTransaction({
      type: "eip1559",
      chainId: 5042002,
      nonce: Math.max(nextNonce, accountNonce),
      gas: 100_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      to: VAULT,
      data: stringToHex(payload.selector),
    });
    nextNonce = Math.max(nextNonce, accountNonce) + 1;
    return { signedTransaction };
  });
  const chain = {
    isRegistered: vi.fn(async () => registered),
    registerPocket: vi.fn<PocketPreparationChain["registerPocket"]>(async (args) => {
      const hash = land(args.transaction);
      registered = true;
      return hash;
    }),
    pocketGasGranted: vi.fn(async () => granted),
    grantPocketGas: vi.fn<PocketPreparationChain["grantPocketGas"]>(async (args) => {
      const hash = land(args.transaction);
      granted = args.units;
      return hash;
    }),
    isDelegateReady: vi.fn(async () => true),
    addDelegate: vi.fn(async () => "delegate"),
    isFunded: vi.fn(async () => funded),
    fundPocket: vi.fn<PocketPreparationChain["fundPocket"]>(async (args) => {
      const hash = land(args.transaction);
      funded = true;
      return hash;
    }),
    transactionCount: vi.fn(async (_address: `0x${string}`) => accountNonce),
    transactionStatus: vi.fn(async (txHash: `0x${string}`) => receipts.get(txHash)),
  } satisfies PocketPreparationChain;
  return {
    chain,
    mine,
    takeNextNonce: () => {
      accountNonce = Math.max(accountNonce, nextNonce);
    },
    vaultCalls: (selector: string) =>
      sign.mock.calls
        .map(([, request]) => request.payload as { selector?: string; args?: unknown })
        .filter((payload) => payload.selector === selector)
        .map((payload) => payload.args),
    dependencies: {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign },
      chain,
      now: () => new Date("2026-10-22T00:00:00Z"),
    },
  };
}
