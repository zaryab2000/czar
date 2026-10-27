import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { loadConfig } from "@czar/config";
import { startPayerRuntime } from "#src/payer/runtime";
import { writeOffOverdueManualReturn } from "#src/payer/pullback";
import {
  listManualReturnsForUser,
  reconcileManualReturns,
  runManualReturnRecovery,
  type ManualReturnWriteOffCandidate,
} from "#src/payer/pullback-scheduler";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const OTHER_USER_ID = "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
const OTHER_DEVICE_ID = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
const OTHER_OBJECTIVE_ID = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
const OTHER_PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
const POCKET = "0x0000000000000000000000000000000000000001" as const;
const VAULT = "0x0000000000000000000000000000000000000002" as const;
const NOW = new Date("2026-10-26T00:00:00.000Z");
const MILLISECONDS_PER_HOUR = 3_600_000;
const MILLISECONDS_PER_SECOND = 1_000;

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
  await pool.query("INSERT INTO users(user_id) VALUES($1)", [OTHER_USER_ID]);
  await pool.query(
    `INSERT INTO devices(device_id,user_id,device_name,platform,token_hash)
     VALUES($1,$2,'Other user device','macos',$3)`,
    [OTHER_DEVICE_ID, OTHER_USER_ID, Buffer.alloc(32, 8)],
  );
  const otherSubmission = makeObjectiveSubmission(OTHER_OBJECTIVE_ID, {
    deviceId: OTHER_DEVICE_ID,
  });
  await pool.query(
    `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
     VALUES($1,$2,$3,$4::jsonb,$5,'received')`,
    [
      OTHER_OBJECTIVE_ID,
      OTHER_USER_ID,
      OTHER_DEVICE_ID,
      JSON.stringify(otherSubmission),
      otherSubmission.objectiveHash,
    ],
  );
  await pool.query(
    `INSERT INTO plans(plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES($1,$2,'{}',$3,$4,'offered')`,
    [OTHER_PLAN_ID, OTHER_OBJECTIVE_ID, `0x${"33".repeat(32)}`, `0x${"44".repeat(32)}`],
  );
});

beforeEach(async () => {
  await getPool().query(
    "DELETE FROM payer_pullback_gateway_failures WHERE plan_id=ANY($1::text[])",
    [[PLAN_ID, OTHER_PLAN_ID]],
  );
  await getPool().query(
    `INSERT INTO payer_pullback_gateway_failures
       (plan_id,step_index,envelope_ref,pocket,value,unavailable_since,state,
        pullback_id,vault_address,gateway_minter,attempt,return_tx,return_block,
        return_log_index,returned_amount)
     VALUES($1,0,$2,$3,90000,$4,'manual-return-required',NULL,$5,$6,0,$7,50,5,8000)`,
    [
      PLAN_ID,
      "eip155:5042002:0xvault:1",
      POCKET,
      NOW,
      VAULT,
      "0x0000000000000000000000000000000000000004",
      `0x${"33".repeat(32)}`,
    ],
  );
  await getPool().query(
    `INSERT INTO payer_pullback_gateway_failures
       (plan_id,step_index,envelope_ref,pocket,value,unavailable_since,state,
        pullback_id,vault_address,gateway_minter,attempt,return_tx,return_block,
        return_log_index,returned_amount,manual_return_required_at)
     VALUES($1,0,$2,$3,90000,$4,'manual-return-required',NULL,$5,$6,0,$7,50,5,9000,$4)`,
    [
      OTHER_PLAN_ID,
      "eip155:5042002:0xvault:2",
      "0x0000000000000000000000000000000000000003",
      NOW,
      VAULT,
      "0x0000000000000000000000000000000000000004",
      `0x${"55".repeat(32)}`,
    ],
  );
});

describe("manual return reconciliation", () => {
  it("recovers legacy return receipt coordinates before event matching", async () => {
    await getPool().query(
      `UPDATE payer_pullback_gateway_failures
       SET attempt=0,return_tx=NULL,return_block=NULL,return_log_index=NULL,returned_amount=NULL
       WHERE plan_id=$1`,
      [PLAN_ID],
    );
    const recoverReturnPosition = vi.fn(async () => ({
      txHash: `0x${"66".repeat(32)}` as `0x${string}`,
      amount: "8000",
      block: "50",
      logIndex: 5,
    }));
    await reconcileManualReturns({
      pool: getPool(),
      manualReturnsForVault: async () => [
        {
          pocket: POCKET,
          credit: "7000",
          txHash: `0x${"44".repeat(32)}`,
          block: "50",
          logIndex: 6,
        },
      ],
      manualReturnsAfterClosure: async () => [],
      recoverReturnPosition,
      isPocketClosed: async () => false,
      onRowError: vi.fn(),
      now: () => NOW,
    });

    const row = await getPool().query<{
      state: string;
      return_tx: string;
      return_block: string;
      return_log_index: number;
      returned_amount: string;
    }>(
      `SELECT state,return_tx,return_block,return_log_index,returned_amount
       FROM payer_pullback_gateway_failures WHERE plan_id=$1`,
      [PLAN_ID],
    );
    expect(recoverReturnPosition).toHaveBeenCalledOnce();
    expect(row.rows[0]).toEqual({
      state: "recorded",
      return_tx: `0x${"66".repeat(32)}`,
      return_block: "50",
      return_log_index: 5,
      returned_amount: "8000",
    });
  });

  it("continues reconciling when a legacy receipt is not yet recoverable", async () => {
    await getPool().query(
      `UPDATE payer_pullback_gateway_failures
       SET attempt=0,return_tx=NULL,return_block=NULL,return_log_index=NULL
       WHERE plan_id=$1`,
      [PLAN_ID],
    );
    const onRowError = vi.fn();
    await reconcileManualReturns({
      pool: getPool(),
      manualReturnsForVault: async () => [
        {
          pocket: "0x0000000000000000000000000000000000000003",
          credit: "7000",
          txHash: `0x${"44".repeat(32)}`,
          block: "50",
          logIndex: 6,
        },
      ],
      manualReturnsAfterClosure: async () => [],
      recoverReturnPosition: async () => {
        throw new Error("receipt not indexed yet");
      },
      isPocketClosed: async () => false,
      onRowError,
      now: () => NOW,
    });

    const rows = await getPool().query<{ plan_id: string; state: string }>(
      `SELECT plan_id,state FROM payer_pullback_gateway_failures
       WHERE plan_id=ANY($1::text[]) ORDER BY plan_id`,
      [[PLAN_ID, OTHER_PLAN_ID]],
    );
    expect(onRowError).toHaveBeenCalledOnce();
    expect(rows.rows).toEqual([
      { plan_id: PLAN_ID, state: "manual-return-required" },
      { plan_id: OTHER_PLAN_ID, state: "recorded" },
    ]);
  });

  it("records only a matching event ordered after the return transfer", async () => {
    await reconcileManualReturns({
      pool: getPool(),
      manualReturnsForVault: async () => [
        {
          pocket: POCKET,
          credit: "7000",
          txHash: `0x${"44".repeat(32)}`,
          block: "50",
          logIndex: 6,
        },
      ],
      manualReturnsAfterClosure: async () => [],
      recoverReturnPosition: async () => null,
      isPocketClosed: async () => false,
      onRowError: vi.fn(),
      now: () => NOW,
    });

    const row = await getPool().query<{
      state: string;
      recorded_credit: string | null;
      recorded_tx: string | null;
      recorded_at: Date | null;
    }>(
      `SELECT state,recorded_credit,recorded_tx,recorded_at
       FROM payer_pullback_gateway_failures WHERE plan_id=$1`,
      [PLAN_ID],
    );
    expect(row.rows[0]).toEqual({
      state: "recorded",
      recorded_credit: "7000",
      recorded_tx: `0x${"44".repeat(32)}`,
      recorded_at: NOW,
    });
  });

  it("does not match a lower log index in the return transfer's block", async () => {
    await reconcileManualReturns({
      pool: getPool(),
      manualReturnsForVault: async () => [
        {
          pocket: POCKET,
          credit: "8000",
          txHash: `0x${"44".repeat(32)}`,
          block: "50",
          logIndex: 4,
        },
      ],
      manualReturnsAfterClosure: async () => [],
      recoverReturnPosition: async () => null,
      isPocketClosed: async () => false,
      onRowError: vi.fn(),
      now: () => NOW,
    });

    const row = await getPool().query<{ state: string; recorded_credit: string | null }>(
      `SELECT state,recorded_credit FROM payer_pullback_gateway_failures WHERE plan_id=$1`,
      [PLAN_ID],
    );
    expect(row.rows[0]).toEqual({ state: "manual-return-required", recorded_credit: null });
  });

  it("expires the pending manual return when the pocket closed first", async () => {
    let closedPocketRead = false;
    await reconcileManualReturns({
      pool: getPool(),
      manualReturnsForVault: async () => [],
      manualReturnsAfterClosure: async () => [],
      recoverReturnPosition: async () => null,
      isPocketClosed: async (vault, pocket) => {
        closedPocketRead = true;
        expect(vault).toBe(VAULT);
        return pocket.toLowerCase() === POCKET.toLowerCase();
      },
      onRowError: vi.fn(),
      now: () => NOW,
    });

    const row = await getPool().query<{ state: string }>(
      "SELECT state FROM payer_pullback_gateway_failures WHERE plan_id=$1",
      [PLAN_ID],
    );
    expect(closedPocketRead).toBe(true);
    expect(row.rows[0]?.state).toBe("expired");
  });

  it("uses chain events before expiring when indexer lags behind pocket closure", async () => {
    const chainEvent = {
      pocket: POCKET,
      credit: "8000",
      txHash: `0x${"77".repeat(32)}` as `0x${string}`,
      block: "51",
      logIndex: 2,
    };
    await reconcileManualReturns({
      pool: getPool(),
      manualReturnsForVault: async () => [],
      manualReturnsAfterClosure: async (vault, pocket, fromBlock) => {
        expect(vault).toBe(VAULT);
        expect(pocket).toBe(POCKET);
        expect(fromBlock).toBe(50n);
        return [chainEvent];
      },
      recoverReturnPosition: async () => null,
      isPocketClosed: async () => true,
      onRowError: vi.fn(),
      now: () => NOW,
    });

    const row = await getPool().query<{ state: string; recorded_tx: string | null }>(
      `SELECT state,recorded_tx FROM payer_pullback_gateway_failures WHERE plan_id=$1`,
      [PLAN_ID],
    );
    expect(row.rows[0]).toEqual({ state: "recorded", recorded_tx: chainEvent.txHash });
  });

  it("returns manual-return rows only to the objective's owning user", async () => {
    const firstUserPage = await listManualReturnsForUser(getPool(), TEST_USER_ID, {
      cursor: null,
      limit: 10,
    });
    const secondUserPage = await listManualReturnsForUser(getPool(), OTHER_USER_ID, {
      cursor: null,
      limit: 10,
    });

    expect(firstUserPage.items).toHaveLength(1);
    expect(firstUserPage.items[0]?.envelopeRef).toBe("eip155:5042002:0xvault:1");
    expect(secondUserPage.items).toHaveLength(1);
    expect(secondUserPage.items[0]?.envelopeRef).toBe("eip155:5042002:0xvault:2");
    await expect(
      listManualReturnsForUser(getPool(), "usr_01K7ZT9P4N5Q6R7S8T9V0W1X3A", {
        cursor: null,
        limit: 10,
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("bounds each manual-return page in SQL and uses a lookahead row", async () => {
    const rows = [0, 1, 2].map((stepIndex) => ({
      envelopeRef: `eip155:5042002:${VAULT}:${stepIndex + 1}`,
      vault: VAULT,
      pocket: POCKET,
      returnedAmount: "100",
      returnTx: `0x${String(stepIndex + 1).repeat(64)}`,
      state: "manual-return-required" as const,
      recordedCredit: null,
      recordedTx: null,
      manualReturnRequiredAt: `2026-10-26 00:00:0${stepIndex}+00`,
      planId: `pln_01K7ZT9P4N5Q6R7S8T9V0W1X2${stepIndex}`,
      stepIndex,
    }));
    const query = vi.fn().mockResolvedValue({ rows });
    const pool = { query } as unknown as Pool;

    const page = await listManualReturnsForUser(pool, TEST_USER_ID, {
      cursor: null,
      limit: 2,
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining("LIMIT $6"), [
      TEST_USER_ID,
      null,
      null,
      null,
      false,
      3,
    ]);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toEqual({
      manualReturnRequiredAt: rows[1]?.manualReturnRequiredAt,
      planId: rows[1]?.planId,
      stepIndex: 1,
    });
  });

  it("starts write-off only when the configured hold has elapsed", async () => {
    const now = new Date(NOW);
    await getPool().query(
      `UPDATE payer_pullback_gateway_failures SET manual_return_required_at=$2
       WHERE plan_id=$1`,
      [PLAN_ID, NOW],
    );
    const writeOffManualReturn = vi.fn(async (row: { plan_id: string }) => {
      if (row.plan_id === PLAN_ID) throw new Error("signer refused write-off");
    });
    const onWriteOffError = vi.fn();
    const dependencies = {
      pool: getPool(),
      config: loadConfig({ envFile: { "payer.manualReturnHoldHours": 72 } }),
      manualReturnsForVault: async () => [],
      manualReturnsAfterClosure: async () => [],
      recoverReturnPosition: async () => null,
      isPocketClosed: async () => false,
      onRowError: vi.fn(),
      writeOffManualReturn,
      onWriteOffError,
      now: () => now,
    };

    await expect(runManualReturnRecovery(dependencies)).resolves.toBe(0);
    expect(writeOffManualReturn).not.toHaveBeenCalled();
    now.setTime(now.getTime() + 72 * 60 * 60 * 1000);
    await expect(runManualReturnRecovery(dependencies)).resolves.toBe(2);
    expect(writeOffManualReturn).toHaveBeenCalledTimes(2);
    expect(onWriteOffError).toHaveBeenCalledOnce();
    expect(onWriteOffError).toHaveBeenCalledWith(
      expect.objectContaining({ plan_id: PLAN_ID }),
      expect.any(Error),
    );
    expect(writeOffManualReturn).toHaveBeenLastCalledWith(
      expect.objectContaining({ plan_id: OTHER_PLAN_ID }),
    );
  });

  it("retries signer-denied write-off at the configured recovery interval", async () => {
    const config = loadConfig();
    const recoveryPollSeconds = Number(config.get("payer.gatewayRecoveryPollSeconds"));
    const holdMs = Number(config.get("payer.manualReturnHoldHours")) * MILLISECONDS_PER_HOUR;
    const now = new Date(NOW.getTime() + holdMs);
    const onWriteOffError = vi.fn();
    const signer = {
      sign: vi.fn(async () => {
        throw new Error("kms_denied: gateway-balance-stale");
      }),
    };
    const writeOffPocket = vi.fn(async () => "write-off-tx");
    const writeOffManualReturn = vi.fn((row: ManualReturnWriteOffCandidate) => {
      if (row.vault_address === null) throw new Error("Missing vault for test row.");
      return writeOffOverdueManualReturn(
        {
          planId: row.plan_id,
          stepIndex: row.step_index,
          attempt: row.attempt ?? 0,
          envelopeRef: row.envelope_ref,
          vault: row.vault_address,
          pocket: row.pocket,
        },
        {
          pool: getPool(),
          config,
          signer,
          chain: {
            pocketWriteOffStatus: async () => ({ state: "funded", pendingPullback: 0n }),
            writeOffPocket,
          },
          now: () => now,
        },
      );
    });
    const reconcile = () =>
      runManualReturnRecovery({
        pool: getPool(),
        config,
        manualReturnsForVault: async () => [],
        manualReturnsAfterClosure: async () => [],
        recoverReturnPosition: async () => null,
        isPocketClosed: async () => false,
        onRowError: vi.fn(),
        writeOffManualReturn,
        onWriteOffError,
        now: () => now,
      });
    const recoveryPass = vi.fn(reconcile);

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const runtime = startPayerRuntime({
      recoveryPollSeconds,
      runClosedRecovery: recoveryPass,
    });
    try {
      await vi.advanceTimersByTimeAsync(recoveryPollSeconds * MILLISECONDS_PER_SECOND);
      expect(recoveryPass).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(writeOffManualReturn).toHaveBeenCalledOnce());
      expect(onWriteOffError).toHaveBeenCalledOnce();
      expect(signer.sign).toHaveBeenCalledOnce();
      expect(writeOffPocket).not.toHaveBeenCalled();
      const firstState = await getPool().query<{ state: string }>(
        `SELECT state FROM payer_pullback_gateway_failures WHERE plan_id=$1`,
        [OTHER_PLAN_ID],
      );
      expect(firstState.rows[0]?.state).toBe("manual-return-required");

      await vi.advanceTimersByTimeAsync(recoveryPollSeconds * MILLISECONDS_PER_SECOND);
      expect(recoveryPass).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(writeOffManualReturn).toHaveBeenCalledTimes(2));
      expect(signer.sign).toHaveBeenCalledTimes(2);
      expect(onWriteOffError).toHaveBeenCalledTimes(2);
      const retriedState = await getPool().query<{ state: string }>(
        `SELECT state FROM payer_pullback_gateway_failures WHERE plan_id=$1`,
        [OTHER_PLAN_ID],
      );
      expect(retriedState.rows[0]?.state).toBe("manual-return-required");
    } finally {
      runtime.stop();
      vi.useRealTimers();
    }
  });
});
