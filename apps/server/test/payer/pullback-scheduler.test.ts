import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { runPendingPullbackFallbacks } from "#src/payer/pullback-scheduler";
import type { CancelPullbackInput } from "#src/payer/pullback";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const POCKET = "0x0000000000000000000000000000000000000001" as const;
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
      })),
      cancelPendingPullback: async (input: CancelPullbackInput) => {
        expect(input).toMatchObject({ pullbackId: 9n, attempt: 0 });
        phases.push("pullback.cancelled");
      },
      chain: {
        getBlockNumber: async () => 1n,
        withdrawalBlock: async () => 0n,
        pocketUsdcBalance: async () => 0n,
        sendPocketTransaction: async (_transaction: `0x${string}`, step: string) => {
          phases.push(step);
          return `tx-${step}`;
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
        })),
        cancelPendingPullback,
        chain: {
          getBlockNumber: async () => 1n,
          withdrawalBlock: async () => 0n,
          pocketUsdcBalance: async () => 0n,
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
        })),
        cancelPendingPullback,
        chain: {
          getBlockNumber: async () => 1n,
          withdrawalBlock: async () => 0n,
          pocketUsdcBalance: async () => 0n,
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
});
