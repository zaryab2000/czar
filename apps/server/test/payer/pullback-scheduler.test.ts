import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { keccak256 } from "viem";
import { runPendingPullbackFallbacks } from "#src/payer/pullback-scheduler";
import { appendExecutionPhase } from "#src/payer/executions";
import type { CancelPullbackInput } from "#src/payer/pullback";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const POCKET = "0x0000000000000000000000000000000000000001" as const;
const VAULT = "0x0000000000000000000000000000000000000002" as const;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const NOW = new Date("2026-10-22T00:00:00.000Z");

beforeAll(async () => {
  const pool = getPool();
  await seedDevice(pool);
  const submission = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y");
  await pool.query(
    `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
     VALUES($1,$2,$3,$4::jsonb,$5,'received') ON CONFLICT DO NOTHING`,
    [
      submission.objectiveId,
      TEST_USER_ID,
      submission.deviceId,
      JSON.stringify(submission),
      submission.objectiveHash,
    ],
  );
  await pool.query(
    `INSERT INTO plans(plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES($1,$2,'{}',$3,$4,'offered') ON CONFLICT DO NOTHING`,
    [PLAN_ID, submission.objectiveId, `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`],
  );
});

beforeEach(async () => {
  await getPool().query("DELETE FROM payer_pullback_gateway_failures");
  await getPool().query("DELETE FROM step_executions");
  await getPool().query("DELETE FROM steps WHERE plan_id=$1", [PLAN_ID]);
  await getPool().query(
    "INSERT INTO steps(plan_id,step_index,step,state) VALUES($1,0,'{}','queued')",
    [PLAN_ID],
  );
  await getPool().query(
    `INSERT INTO payer_pullback_gateway_failures
       (plan_id,step_index,envelope_ref,pocket,value,unavailable_since,state,
        pullback_id,vault_address,gateway_minter,attempt)
     VALUES($1,0,$2,$3,90000,$4,'pending',9,$5,$6,0)`,
    [
      PLAN_ID,
      "eip155:31337:0xvault:1",
      POCKET,
      new Date(NOW.getTime() - 86_400_000),
      "0x0000000000000000000000000000000000000002",
      "0x0000000000000000000000000000000000000004",
    ],
  );
});

describe("slow pullback scheduler", () => {
  it("executes the fallback after persisted Gateway downtime reaches the threshold", async () => {
    const phases: string[] = [];
    const sign = vi.fn(async () => ({ signedTransaction: "0x1234" as const }));
    const dependencies = {
      pool: getPool(),
      config: loadConfig({ envFile: { "payer.pullbackApiDownHours": 24 } }),
      signer: { sign },
      readGatewayBalance: vi.fn(async () => ({
        gatewayAvailableAtomic: 450_000n,
        gatewayWithdrawingAtomic: 0n,
        apiObservedAt: new Date(NOW.getTime() - 86_400_000),
        apiConsecutiveFailures: 0,
      })),
      cancelPendingPullback: async (input: CancelPullbackInput) => {
        expect(input).toMatchObject({ pullbackId: 9n, attempt: 0 });
        phases.push("pullback.cancelled");
      },
      chain: {
        getBlockNumber: async () => 1n,
        withdrawalBlock: async () => 0n,
        withdrawingBalance: async () => 0n,
        pocketReturnable: async () => 0n,
        transactionReceipt: async () => null,
        sendPocketTransaction: async (transaction: `0x${string}`, step: string) => {
          phases.push(step);
          return keccak256(transaction);
        },
      },
      now: () => NOW,
    };
    await expect(runPendingPullbackFallbacks(dependencies)).resolves.toBe(1);
    expect(sign).toHaveBeenCalledWith(
      "cz-15",
      expect.objectContaining({ payload: expect.objectContaining({ value: "450000" }) }),
    );
    expect(phases).toEqual(["pullback.cancelled", "pullback.slow.initiate"]);
    const rows = await getPool().query(
      "SELECT phase FROM step_executions WHERE plan_id=$1 ORDER BY execution_id",
      [PLAN_ID],
    );
    expect(rows.rows.map((row) => row.phase)).toEqual([
      "pullback.slow.initiate.sent",
      "pullback.slow.initiated",
    ]);
  });

  it("records a missing Gateway figure and waits without cancelling or signing", async () => {
    const sign = vi.fn();
    const cancelPendingPullback = vi.fn();
    await expect(
      runPendingPullbackFallbacks({
        pool: getPool(),
        config: loadConfig({ envFile: { "payer.pullbackApiDownHours": 24 } }),
        signer: { sign },
        readGatewayBalance: vi.fn(async () => ({
          gatewayAvailableAtomic: 0n,
          gatewayWithdrawingAtomic: 0n,
          apiObservedAt: null,
          apiConsecutiveFailures: 0,
        })),
        cancelPendingPullback,
        chain: {
          getBlockNumber: async () => 1n,
          withdrawalBlock: async () => 0n,
          withdrawingBalance: async () => 0n,
          pocketReturnable: async () => 0n,
          transactionReceipt: async () => null,
          sendPocketTransaction: async () => "tx",
        },
        now: () => NOW,
      }),
    ).resolves.toBe(1);
    expect(cancelPendingPullback).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    const rows = await getPool().query(
      "SELECT phase FROM step_executions WHERE plan_id=$1 ORDER BY execution_id",
      [PLAN_ID],
    );
    expect(rows.rows.map((row) => row.phase)).toEqual(["pullback.gateway-figure-missing"]);
  });

  it("waits on an observed zero balance without cancelling the pullback", async () => {
    const sign = vi.fn();
    const cancelPendingPullback = vi.fn();
    await expect(
      runPendingPullbackFallbacks({
        pool: getPool(),
        config: loadConfig({ envFile: { "payer.pullbackApiDownHours": 24 } }),
        signer: { sign },
        readGatewayBalance: vi.fn(async () => ({
          gatewayAvailableAtomic: 0n,
          gatewayWithdrawingAtomic: 0n,
          apiObservedAt: new Date(NOW.getTime() - 86_400_000),
          apiConsecutiveFailures: 0,
        })),
        cancelPendingPullback,
        chain: {
          getBlockNumber: async () => 1n,
          withdrawalBlock: async () => 0n,
          withdrawingBalance: async () => 0n,
          pocketReturnable: async () => 0n,
          transactionReceipt: async () => null,
          sendPocketTransaction: async () => "tx",
        },
        now: () => NOW,
      }),
    ).resolves.toBe(1);
    expect(cancelPendingPullback).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    const rows = await getPool().query(
      "SELECT phase FROM step_executions WHERE plan_id=$1 ORDER BY execution_id",
      [PLAN_ID],
    );
    expect(rows.rows.map((row) => row.phase)).toEqual(["pullback.gateway-balance-empty"]);
  });

  it("resumes an initiated withdrawal and returns its USDC without an API figure", async () => {
    await appendExecutionPhase(getPool(), {
      planId: PLAN_ID,
      stepIndex: 0,
      attempt: 0,
      phase: "pullback.slow.initiated",
      payload: { txHash: "initiate-tx" },
    });
    const signer = vi.fn(async () => ({ signedTransaction: "0x1234" as const }));
    const cancelPendingPullback = vi.fn();
    const sends: string[] = [];
    let pocketReturnable = 12_000n;
    let withdrawingBalance = 10_000n;
    const dependencies = {
      pool: getPool(),
      config: loadConfig({ envFile: { "payer.pullbackApiDownHours": 24 } }),
      signer: { sign: signer },
      readGatewayBalance: vi.fn(async () => ({
        gatewayAvailableAtomic: 0n,
        gatewayWithdrawingAtomic: 0n,
        apiObservedAt: null,
        apiConsecutiveFailures: 0,
      })),
      cancelPendingPullback,
      chain: {
        getBlockNumber: async () => 100n,
        withdrawalBlock: async () => 100n,
        withdrawingBalance: async () => withdrawingBalance,
        pocketReturnable: async () => pocketReturnable,
        transactionReceipt: async () => ({
          status: "success" as const,
          blockNumber: 400n,
          logs: [
            {
              address: USDC,
              from: POCKET,
              to: VAULT,
              value: 12_000n,
              logIndex: 3,
            },
          ],
        }),
        sendPocketTransaction: async (transaction: `0x${string}`, kind: string) => {
          sends.push(kind);
          if (kind === "pullback.slow.withdraw") pocketReturnable = 12_000n;
          if (kind === "pullback.slow.withdraw") withdrawingBalance = 0n;
          if (kind === "pocket-return:usdc") pocketReturnable = 0n;
          return keccak256(transaction);
        },
      },
      now: () => NOW,
    };

    await runPendingPullbackFallbacks(dependencies);
    await runPendingPullbackFallbacks(dependencies);

    expect(cancelPendingPullback).not.toHaveBeenCalled();
    expect(signer).toHaveBeenCalledWith(
      "cz-15",
      expect.objectContaining({ payload: expect.objectContaining({ step: "withdraw" }) }),
    );
    expect(sends).toEqual(["pullback.slow.withdraw", "pocket-return:usdc"]);
    const row = await getPool().query(
      "SELECT state FROM payer_pullback_gateway_failures WHERE plan_id=$1 AND step_index=0",
      [PLAN_ID],
    );
    expect(row.rows[0]?.state).toBe("manual-return-required");
  });

  it("recovers a mined withdrawal after restart and records the verified vault return", async () => {
    await getPool().query(
      `UPDATE payer_pullback_gateway_failures
       SET closed_pocket=true,unavailable_since=$2,initiate_tx='initiate-tx',
           withdraw_tx='withdraw-tx' WHERE plan_id=$1`,
      [PLAN_ID, NOW],
    );
    for (const phase of [
      "pullback.slow.initiate.sent",
      "pullback.slow.initiated",
      "pullback.slow.withdraw.sent",
      "pullback.slow.withdrawn",
    ])
      await appendExecutionPhase(getPool(), {
        planId: PLAN_ID,
        stepIndex: 0,
        attempt: 0,
        phase,
        payload: { transaction: "0x1234", txHash: `${phase}-hash` },
      });

    let pocketReturnable = 12_000n;
    const send = vi.fn(async (transaction: `0x${string}`) => {
      pocketReturnable = 0n;
      return keccak256(transaction);
    });
    const dependencies = {
      pool: getPool(),
      config: loadConfig({ envFile: { "payer.pullbackApiDownHours": 24 } }),
      signer: { sign: vi.fn(async () => ({ signedTransaction: "0x5678" as const })) },
      readGatewayBalance: vi.fn(async () => {
        throw new Error("closed pocket is no longer indexed");
      }),
      cancelPendingPullback: vi.fn(),
      chain: {
        getBlockNumber: async () => 400n,
        withdrawalBlock: async () => 0n,
        withdrawingBalance: async () => 0n,
        pocketReturnable: async () => pocketReturnable,
        transactionReceipt: async () => ({
          status: "success" as const,
          blockNumber: 400n,
          logs: [
            {
              address: USDC,
              from: POCKET,
              to: VAULT,
              value: 12_000n,
              logIndex: 3,
            },
          ],
        }),
        sendPocketTransaction: send,
      },
      now: () => NOW,
    };

    await expect(runPendingPullbackFallbacks(dependencies)).resolves.toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(dependencies.readGatewayBalance).not.toHaveBeenCalled();
    const row = await getPool().query(
      `SELECT state,return_tx,return_block,return_log_index,returned_amount
       FROM payer_pullback_gateway_failures WHERE plan_id=$1 AND step_index=0`,
      [PLAN_ID],
    );
    expect(row.rows[0]).toMatchObject({
      state: "returned-to-vault",
      return_tx: keccak256("0x5678"),
      return_block: "400",
      return_log_index: 3,
      returned_amount: "12000",
    });
  });

  it("recognizes a mined pocket return after restart without sending it twice", async () => {
    await getPool().query(
      `UPDATE payer_pullback_gateway_failures
       SET closed_pocket=true,unavailable_since=$2,initiate_tx='initiate-tx',
           withdraw_tx='withdraw-tx',return_tx='return-tx'
       WHERE plan_id=$1`,
      [PLAN_ID, NOW],
    );
    const send = vi.fn(async () => {
      throw new Error("a mined return must not be sent again");
    });
    const dependencies = {
      pool: getPool(),
      config: loadConfig({ envFile: { "payer.pullbackApiDownHours": 24 } }),
      signer: { sign: vi.fn() },
      readGatewayBalance: vi.fn(async () => {
        throw new Error("closed pocket is no longer indexed");
      }),
      cancelPendingPullback: vi.fn(),
      chain: {
        getBlockNumber: async () => 500n,
        withdrawalBlock: async () => 0n,
        withdrawingBalance: async () => 0n,
        pocketReturnable: async () => 0n,
        transactionReceipt: async () => ({
          status: "success" as const,
          blockNumber: 400n,
          logs: [
            {
              address: USDC,
              from: POCKET,
              to: VAULT,
              value: 12_000n,
              logIndex: 4,
            },
          ],
        }),
        sendPocketTransaction: send,
      },
      now: () => NOW,
    };

    await expect(runPendingPullbackFallbacks(dependencies)).resolves.toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(dependencies.signer.sign).not.toHaveBeenCalled();
    const row = await getPool().query(
      `SELECT state,return_tx,return_block,return_log_index,returned_amount
       FROM payer_pullback_gateway_failures WHERE plan_id=$1 AND step_index=0`,
      [PLAN_ID],
    );
    expect(row.rows[0]).toMatchObject({
      state: "returned-to-vault",
      return_tx: "return-tx",
      return_block: "400",
      return_log_index: 4,
      returned_amount: "12000",
    });
  });

  it("starts the API-down path when the outage predates any pullback request", async () => {
    await getPool().query(
      `UPDATE payer_pullback_gateway_failures
       SET pullback_id=NULL,gateway_minter=NULL WHERE plan_id=$1`,
      [PLAN_ID],
    );
    const send = vi.fn(async (transaction: `0x${string}`) => keccak256(transaction));
    const signer = vi.fn(async () => ({ signedTransaction: "0x1234" as const }));
    const cancelPendingPullback = vi.fn();

    await expect(
      runPendingPullbackFallbacks({
        pool: getPool(),
        config: loadConfig({ envFile: { "payer.pullbackApiDownHours": 24 } }),
        signer: { sign: signer },
        readGatewayBalance: vi.fn(async () => ({
          gatewayAvailableAtomic: 450_000n,
          gatewayWithdrawingAtomic: 0n,
          apiObservedAt: new Date(NOW.getTime() - 172_800_000),
          apiConsecutiveFailures: 0,
        })),
        cancelPendingPullback,
        chain: {
          getBlockNumber: async () => 1n,
          withdrawalBlock: async () => 0n,
          withdrawingBalance: async () => 0n,
          pocketReturnable: async () => 0n,
          transactionReceipt: async () => null,
          sendPocketTransaction: send,
        },
        now: () => NOW,
      }),
    ).resolves.toBe(1);

    expect(cancelPendingPullback).not.toHaveBeenCalled();
    expect(signer).toHaveBeenCalledWith(
      "cz-15",
      expect.objectContaining({ payload: expect.objectContaining({ value: "450000" }) }),
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("returns a closed-pocket API-down recovery to the vault without a manual prompt", async () => {
    await getPool().query(
      "UPDATE payer_pullback_gateway_failures SET attempt=1,closed_pocket=true WHERE plan_id=$1",
      [PLAN_ID],
    );
    await appendExecutionPhase(getPool(), {
      planId: PLAN_ID,
      stepIndex: 0,
      attempt: 1,
      phase: "pullback.transfer.sent",
      payload: { pullbackId: "9" },
    });
    let withdrawingBalance = 0n;
    const send = vi.fn(async (transaction: `0x${string}`, kind: string) => {
      if (kind === "pullback.slow.initiate") withdrawingBalance = 450_000n;
      if (kind === "pullback.slow.withdraw") withdrawingBalance = 0n;
      if (kind === "pocket-return:usdc") pocketBalance = 0n;
      return keccak256(transaction);
    });
    let head = 100n;
    let pocketBalance = 0n;
    let withdrawalBlock = 0n;
    const dependencies = {
      pool: getPool(),
      config: loadConfig({ envFile: { "payer.pullbackApiDownHours": 24 } }),
      signer: { sign: vi.fn(async () => ({ signedTransaction: "0x1234" as const })) },
      readGatewayBalance: vi.fn(async () => ({
        gatewayAvailableAtomic: 450_000n,
        gatewayWithdrawingAtomic: 0n,
        apiObservedAt: new Date(NOW.getTime() - 86_400_000),
        apiConsecutiveFailures: 0,
      })),
      cancelPendingPullback: vi.fn(async () => undefined),
      chain: {
        getBlockNumber: async () => head,
        withdrawalBlock: async () => withdrawalBlock,
        withdrawingBalance: async () => withdrawingBalance,
        pocketReturnable: async () => pocketBalance,
        transactionReceipt: async () => ({
          status: "success" as const,
          blockNumber: 200n,
          logs: [{ address: USDC, from: POCKET, to: VAULT, value: 5_000n, logIndex: 0 }],
        }),
        sendPocketTransaction: send,
      },
      now: () => NOW,
    };

    await runPendingPullbackFallbacks(dependencies);
    withdrawalBlock = 200n;
    head = 200n;
    pocketBalance = 5_000n;
    await runPendingPullbackFallbacks(dependencies);
    await runPendingPullbackFallbacks(dependencies);

    expect(send.mock.calls.map(([, kind]) => kind)).toEqual([
      "pullback.slow.initiate",
      "pullback.slow.withdraw",
      "pocket-return:usdc",
    ]);
    const row = await getPool().query(
      "SELECT state FROM payer_pullback_gateway_failures WHERE plan_id=$1 AND step_index=0",
      [PLAN_ID],
    );
    expect(row.rows[0]?.state).toBe("returned-to-vault");
  });
});
