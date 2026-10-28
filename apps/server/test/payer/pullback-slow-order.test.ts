// SCR-153 §1 (G3): on Arc the CZ-15 slow path withdraws first and returns last. The pocket EOA's gas grant
// is USDC (SCR-152), so a pocket-return before the Gateway is clear would strand the Gateway funds. These
// tests drive `executeSlowPullbackFallback` over a simulated pocket ledger (Gateway available/withdrawing,
// EOA balance that pays its own gas) and check the resume table row by row.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { Denied, type SignRequest } from "@czar/signer";
import { keccak256, type Address } from "viem";
import { getExecutionTrace } from "#src/payer/executions";
import {
  executeSlowPullbackFallback,
  isGatewayClear,
  type SlowPullbackDependencies,
  type SlowPullbackInput,
  type SlowPullbackReceipt,
} from "#src/payer/pullback";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
const OBJECTIVE_ID = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
const POCKET: Address = "0x0000000000000000000000000000000000000002";
const VAULT: Address = "0x0000000000000000000000000000000000000001";
const USDC: Address = "0x3600000000000000000000000000000000000000";
const NOW = new Date("2026-10-28T00:00:00Z");
/** Gas one pocket transaction pays out of the EOA's USDC (one ledger on Arc). */
const GAS_COST = 100n;
/** `gasReserve` of a prepared pocket-return transfer (SCR-152 §1). */
const GAS_RESERVE = 1_000n;
/** The pocket's gas grant (`payer.pocketGasUnits` worth of USDC) left in the EOA. */
const GAS_GRANT = 20_000n;
const WITHDRAWAL_DELAY_BLOCKS = 10n;
const FUNDED = 400_000n;
const DUST = 8_000n;
const MAX_PASSES = 8;

type Step = "initiate" | "withdraw" | "return";
type CrashWhen = "recorded" | "mined";

class SimulatedCrash extends Error {}

interface SimulatedPocket {
  readonly dependencies: SlowPullbackDependencies;
  readonly requests: SignRequest[];
  /** Transactions that reached the chain (a re-broadcast of the same signed bytes is not a new one). */
  readonly mined: { readonly step: Step; readonly hash: string }[];
  readonly state: {
    head: bigint;
    available: bigint;
    withdrawing: bigint;
    withdrawalBlock: bigint;
    eoa: bigint;
    vault: bigint;
    api: "fresh" | "down" | "never-observed" | "failing";
    lastGood: bigint;
  };
  crashAt(step: Step, when: CrashWhen): void;
}

function simulatedPocket(input: {
  readonly available: bigint;
  readonly eoa?: bigint;
  readonly api?: SimulatedPocket["state"]["api"];
  readonly signer?: (request: SignRequest) => void;
}): SimulatedPocket {
  const state: SimulatedPocket["state"] = {
    head: 100n,
    available: input.available,
    withdrawing: 0n,
    withdrawalBlock: 0n,
    eoa: input.eoa ?? GAS_GRANT,
    vault: 0n,
    api: input.api ?? "fresh",
    lastGood: input.available,
  };
  const requests: SignRequest[] = [];
  const signed = new Map<string, SignRequest>();
  const receipts = new Map<string, SlowPullbackReceipt>();
  const mined: SimulatedPocket["mined"] = [];
  let crash: { step: Step; when: CrashWhen } | null = null;
  const figure = () => {
    if (state.api === "failing") throw new Error("indexer unavailable");
    return {
      gatewayAvailableAtomic: state.api === "fresh" ? state.available : state.lastGood,
      gatewayWithdrawingAtomic: state.withdrawing,
      apiObservedAt: state.api === "never-observed" ? null : NOW,
      apiConsecutiveFailures: state.api === "fresh" ? 0 : 3,
    };
  };
  const stepOf = (request: SignRequest): Step =>
    request.kind === "pocket-return"
      ? "return"
      : ((request.payload as { step: "initiate" | "withdraw" }).step ?? "initiate");
  const apply = (request: SignRequest, hash: string): SlowPullbackReceipt => {
    const step = stepOf(request);
    state.eoa -= GAS_COST;
    const logs: SlowPullbackReceipt["logs"][number][] = [];
    if (step === "initiate") {
      const value = BigInt((request.payload as { value: string }).value);
      state.available -= value;
      state.withdrawing += value;
      state.withdrawalBlock = state.head + WITHDRAWAL_DELAY_BLOCKS;
    } else if (step === "withdraw") {
      state.eoa += state.withdrawing;
      state.withdrawing = 0n;
    } else {
      const amount = BigInt((request.payload as { amount: string }).amount);
      state.eoa -= amount;
      state.vault += amount;
      logs.push({ address: USDC, from: POCKET, to: VAULT, value: amount, logIndex: 3 });
    }
    mined.push({ step, hash });
    return { status: "success", blockNumber: state.head, logs };
  };
  const dependencies: SlowPullbackDependencies = {
    pool: getPool(),
    config: loadConfig(),
    now: () => NOW,
    signer: {
      async sign(_caller, request) {
        requests.push(request);
        input.signer?.(request);
        if (request.kind === "pocket-slow-withdraw") {
          const payload = request.payload as { step: string; value?: string };
          if (payload.step === "initiate") {
            const observed = figure();
            if (observed.apiObservedAt === null) throw new Denied("gateway-figure-missing");
            if (BigInt(payload.value ?? "-1") !== observed.gatewayAvailableAtomic)
              throw new Denied("slow-withdraw-value-mismatch");
          }
        }
        if (request.kind === "pocket-return") {
          const amount = BigInt((request.payload as { amount: string }).amount);
          if (amount !== state.eoa - GAS_RESERVE) throw new Denied("pocket-return-value-mismatch");
        }
        const transaction = `0x${requests.length.toString(16).padStart(8, "0")}` as const;
        signed.set(transaction, request);
        return { signedTransaction: transaction };
      },
    },
    readGatewayBalance: async () => figure(),
    chain: {
      getBlockNumber: async () => state.head,
      withdrawalBlock: async () => state.withdrawalBlock,
      withdrawingBalance: async () => state.withdrawing,
      pocketReturnable: async () => state.eoa - GAS_RESERVE,
      transactionReceipt: async (hash) => receipts.get(hash) ?? null,
      async sendPocketTransaction(transaction) {
        const hash = keccak256(transaction);
        const request = signed.get(transaction);
        if (!request) throw new Error("unsigned transaction broadcast");
        const step = stepOf(request);
        if (crash?.step === step && crash.when === "recorded") {
          crash = null;
          throw new SimulatedCrash(`crash after ${step}_tx recorded`);
        }
        if (!receipts.has(hash)) receipts.set(hash, apply(request, hash));
        if (crash?.step === step && crash.when === "mined") {
          crash = null;
          throw new SimulatedCrash(`crash after ${step}_tx mined`);
        }
        return hash;
      },
    },
  };
  return {
    dependencies,
    requests,
    mined,
    state,
    crashAt(step, when) {
      crash = { step, when };
    },
  };
}

function slowInput(overrides: Partial<SlowPullbackInput> = {}): SlowPullbackInput {
  return {
    planId: PLAN_ID,
    stepIndex: 0,
    envelopeRef: `eip155:5042002:${VAULT}:1`,
    pocket: POCKET,
    vault: VAULT,
    usdc: USDC,
    apiUnavailableSince: new Date(NOW.getTime() - 48 * 3_600_000),
    value: FUNDED,
    trigger: "api-down",
    ...overrides,
  };
}

/** One recovery pass per call, as the scheduler runs them; a simulated crash ends the pass. */
async function pass(pocket: SimulatedPocket, input: SlowPullbackInput) {
  try {
    return await executeSlowPullbackFallback(input, pocket.dependencies);
  } catch (error) {
    if (error instanceof SimulatedCrash) return { state: "crashed" as const };
    throw error;
  } finally {
    pocket.state.head += WITHDRAWAL_DELAY_BLOCKS;
  }
}

async function runToTerminal(pocket: SimulatedPocket, input: SlowPullbackInput) {
  for (let attempt = 0; attempt < MAX_PASSES; attempt += 1) {
    const result = await pass(pocket, input);
    if (result.state === "manual-return-required" || result.state === "returned-to-vault")
      return result;
  }
  throw new Error("slow path did not reach a terminal state");
}

async function row() {
  const result = await getPool().query<{
    state: string;
    initiate_tx: string | null;
    withdraw_tx: string | null;
    return_tx: string | null;
    returned_amount: string | null;
  }>(
    `SELECT state,initiate_tx,withdraw_tx,return_tx,returned_amount::text AS returned_amount
     FROM payer_pullback_gateway_failures WHERE plan_id=$1 AND step_index=0`,
    [PLAN_ID],
  );
  return result.rows[0];
}

function signedSteps(pocket: SimulatedPocket): string[] {
  return pocket.requests.map((request) =>
    request.kind === "pocket-return"
      ? "return"
      : String((request.payload as { step: string }).step),
  );
}

function expectGatewayAndEoaEmpty(pocket: SimulatedPocket): void {
  expect(pocket.state.available + pocket.state.withdrawing).toBe(0n);
  expect(pocket.state.eoa - GAS_RESERVE).toBeLessThanOrEqual(0n);
}

beforeAll(async () => {
  const pool = getPool();
  await seedDevice(pool);
  const submission = makeObjectiveSubmission(OBJECTIVE_ID);
  await pool.query(
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
  await pool.query(
    `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES ($1,$2,'{}',$3,$4,'offered') ON CONFLICT (plan_id) DO NOTHING`,
    [PLAN_ID, submission.objectiveId, `0x${"03".repeat(32)}`, `0x${"04".repeat(32)}`],
  );
});

beforeEach(async () => {
  await getPool().query("DELETE FROM step_executions");
  await getPool().query("DELETE FROM payer_pullback_gateway_failures");
  await getPool().query("DELETE FROM steps WHERE plan_id=$1", [PLAN_ID]);
  await getPool().query(
    "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,'{}','queued')",
    [PLAN_ID],
  );
});

describe("isGatewayClear (SCR-153 §1)", () => {
  const mined = { status: "success", blockNumber: 1n, logs: [] } as const;
  const reverted = { status: "reverted", blockNumber: 1n, logs: [] } as const;
  const none = { initiateTx: null, withdrawTx: null };
  const sent = { initiateTx: "0xaa", withdrawTx: "0xbb" };
  const quiet = {
    withdrawingBalance: 0n,
    initiateReceipt: null,
    withdrawReceipt: null,
    gatewayAvailable: 0n,
  };

  it.each([
    [
      "withdraw_tx mined with status 1, even on a stale last-good figure",
      sent,
      {
        ...quiet,
        initiateReceipt: mined,
        withdrawReceipt: mined,
        gatewayAvailable: FUNDED,
      },
      true,
    ],
    ["nothing withdrawing, no initiate, Gateway figure 0", none, quiet, true],
    [
      "a reverted initiate is not in flight",
      { initiateTx: "0xaa", withdrawTx: null },
      {
        ...quiet,
        initiateReceipt: reverted,
      },
      true,
    ],
    [
      "a reverted withdraw does not clear a Gateway figure above 0",
      sent,
      {
        ...quiet,
        initiateReceipt: mined,
        withdrawReceipt: reverted,
        gatewayAvailable: DUST,
      },
      false,
    ],
    ["the Gateway figure is above 0", none, { ...quiet, gatewayAvailable: DUST }, false],
    ["the Gateway figure is missing", none, { ...quiet, gatewayAvailable: null }, false],
    ["a withdrawal is open", none, { ...quiet, withdrawingBalance: DUST }, false],
    [
      "an initiate is in flight (recorded, no receipt)",
      { initiateTx: "0xaa", withdrawTx: null },
      quiet,
      false,
    ],
  ] as const)("%s → %s", (_name, rowColumns, reads, expected) => {
    expect(isGatewayClear(rowColumns, reads)).toBe(expected);
  });
});

describe("slow path order on Arc (SCR-153 §1)", () => {
  it("withdraws a closed dust pocket's Gateway balance before returning the gas grant", async () => {
    const pocket = simulatedPocket({ available: DUST });
    const input = slowInput({ value: DUST, trigger: "closed-dust", closedPocketRecovery: true });

    const first = await pass(pocket, input);
    expect(first.state).toBe("waiting-withdrawal");
    expect(signedSteps(pocket)).toEqual(["initiate"]);

    const result = await runToTerminal(pocket, input);
    expect(signedSteps(pocket)).toEqual(["initiate", "withdraw", "return"]);
    expect(pocket.mined.map((entry) => entry.step)).toEqual(["initiate", "withdraw", "return"]);
    expect(result).toEqual({
      state: "returned-to-vault",
      // initiate and withdraw each paid GAS_COST; the return moves balance − gasReserve.
      amount: (GAS_GRANT + DUST - 2n * GAS_COST - GAS_RESERVE).toString(),
    });
    expect(pocket.state.vault).toBe(BigInt(result.amount));
    expectGatewayAndEoaEmpty(pocket);
    expect((await row())?.state).toBe("returned-to-vault");
  });

  it("withdraws an API-down funded pocket on its last good figure, then returns it for manual credit", async () => {
    const pocket = simulatedPocket({ available: FUNDED, api: "down" });
    const input = slowInput();

    const result = await runToTerminal(pocket, input);
    expect(signedSteps(pocket)).toEqual(["initiate", "withdraw", "return"]);
    expect(pocket.requests[0]?.payload).toMatchObject({ value: FUNDED.toString() });
    expect(result.state).toBe("manual-return-required");
    expect(BigInt(result.amount)).toBeGreaterThanOrEqual(FUNDED);
    expectGatewayAndEoaEmpty(pocket);
    const persisted = await row();
    expect(persisted?.state).toBe("manual-return-required");
    expect(persisted?.returned_amount).toBe(result.amount);
  });

  it.each([
    "gateway-figure-missing",
    "pocket-spend-after-observation",
    "slow-withdraw-value-mismatch",
  ])("waits on the SCR-141 denial %s and never returns the gas grant", async (rule) => {
    const pocket = simulatedPocket({
      available: FUNDED,
      api: "down",
      signer: (request) => {
        if (request.kind === "pocket-slow-withdraw") throw new Denied(rule);
      },
    });
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect((await pass(pocket, slowInput())).state).toBe("waiting-withdrawal");

    expect(pocket.requests.every((request) => request.kind === "pocket-slow-withdraw")).toBe(true);
    expect(pocket.mined).toEqual([]);
    expect(pocket.state.eoa).toBe(GAS_GRANT);
    expect((await row())?.state).toBe("pending");
    const phases = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
    expect(phases.map((phase) => phase.phase)).toContain(`pullback.slow.${rule}`);
  });

  it.each(["never-observed", "failing"] as const)(
    "waits when the Gateway figure is %s and never returns the gas grant",
    async (api) => {
      const pocket = simulatedPocket({ available: FUNDED, api });
      expect((await pass(pocket, slowInput())).state).toBe("waiting-withdrawal");
      expect(pocket.requests.some((request) => request.kind === "pocket-return")).toBe(false);
      expect(pocket.mined).toEqual([]);
      expect((await row())?.state).toBe("pending");
    },
  );

  it("ends a Gateway-clear row with nothing returnable as returned-to-vault with returned_amount 0", async () => {
    const pocket = simulatedPocket({ available: 0n, eoa: GAS_RESERVE - GAS_COST });

    await expect(executeSlowPullbackFallback(slowInput(), pocket.dependencies)).resolves.toEqual({
      state: "returned-to-vault",
      amount: "0",
    });
    expect(pocket.requests).toEqual([]);
    expect(pocket.mined).toEqual([]);
    const persisted = await row();
    expect(persisted).toMatchObject({
      state: "returned-to-vault",
      returned_amount: "0",
      return_tx: null,
    });
  });

  it("returns a Gateway-clear funded pocket's EOA balance and asks for manual credit", async () => {
    const pocket = simulatedPocket({ available: 0n });

    const result = await runToTerminal(pocket, slowInput());
    expect(signedSteps(pocket)).toEqual(["return"]);
    expect(result).toEqual({
      state: "manual-return-required",
      amount: (GAS_GRANT - GAS_RESERVE).toString(),
    });
    expectGatewayAndEoaEmpty(pocket);
  });

  it("stops on a mined initiate whose withdrawal is gone without a withdraw_tx", async () => {
    const pocket = simulatedPocket({ available: DUST });
    const input = slowInput({ value: DUST, trigger: "closed-dust", closedPocketRecovery: true });
    expect((await pass(pocket, input)).state).toBe("waiting-withdrawal");
    pocket.state.withdrawing = 0n;

    await expect(pass(pocket, input)).rejects.toThrow(/SCR-153/);
    expect(signedSteps(pocket)).toEqual(["initiate"]);
    expect((await row())?.state).toBe("pending");
  });

  it.each([
    ["initiate", "recorded"],
    ["initiate", "mined"],
    ["withdraw", "recorded"],
    ["withdraw", "mined"],
    ["return", "recorded"],
    ["return", "mined"],
  ] as const)(
    "resumes in order after a crash once %s_tx is %s, and sends nothing twice",
    async (step, when) => {
      const pocket = simulatedPocket({ available: FUNDED, api: "down" });
      const input = slowInput();
      pocket.crashAt(step, when);

      const result = await runToTerminal(pocket, input);
      expect(result.state).toBe("manual-return-required");
      expect(signedSteps(pocket)).toEqual(["initiate", "withdraw", "return"]);
      expect(pocket.mined.map((entry) => entry.step)).toEqual(["initiate", "withdraw", "return"]);
      const persisted = await row();
      expect(persisted?.initiate_tx).toBe(pocket.mined[0]?.hash);
      expect(persisted?.withdraw_tx).toBe(pocket.mined[1]?.hash);
      expect(persisted?.return_tx).toBe(pocket.mined[2]?.hash);
      expectGatewayAndEoaEmpty(pocket);
    },
  );
});
