import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";
import { completeObjective } from "#src/objectives/completion";

const getPool = setupDatabase();
const OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const PLAN = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const ENVELOPE = "eip155:5042002:0x0000000000000000000000000000000000000001:1";
const VAULT = "0x0000000000000000000000000000000000000001" as const;
const HASH = `0x${"01".repeat(32)}`;

describe("objective completion", () => {
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
      "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,'{}','done')",
      [PLAN],
    );
  });

  it("closes an idle envelope and stores one delivered result and event", async () => {
    await getPool().query(
      `INSERT INTO step_executions(plan_id,step_index,attempt,phase,payload)
       VALUES($1,0,0,'step.result',$2::jsonb)`,
      [
        PLAN,
        JSON.stringify({
          stepResult: {
            schemaVersion: "1.0",
            stepIndex: 0,
            status: "delivered",
            source: { origin: "https://merchant.example", payTo: VAULT, paymentRefHash: HASH },
            fields: [{ name: "answer", value: "42", confidence: 1 }],
            flags: [],
            bodyCommit: HASH,
          },
        }),
      ],
    );
    let envelopeState: "Open" | "Closed" = "Open";
    const close = vi.fn(async () => {
      envelopeState = "Closed";
      return HASH;
    });
    const args = {
      objectiveId: OBJECTIVE,
      planId: PLAN,
      envelopeRef: ENVELOPE,
      vault: VAULT,
      envelopeId: 1n,
    };
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign: vi.fn(async () => ({ signedTransaction: "0x01" as `0x${string}` })) },
      chain: {
        readEnvelope: vi.fn(async () => ({
          state: envelopeState,
          openReservations: 0n,
          openPockets: 0n,
          openJobs: 0n,
        })),
        closeEnvelope: close,
        transactionCount: vi.fn(async () => 0),
        transactionStatus: vi.fn(
          async (): Promise<"success" | "reverted" | undefined> => undefined,
        ),
      },
      now: () => new Date("2026-10-25T12:00:00Z"),
      random: { bytes: (size: number) => Buffer.alloc(size, 1) },
    } as const;
    await expect(completeObjective(args, dependencies)).resolves.toBe(true);
    await expect(completeObjective(args, dependencies)).resolves.toBe(true);
    expect(close).toHaveBeenCalledOnce();
    const result = await getPool().query<{ rendered_body: string }>(
      "SELECT rendered_body FROM results WHERE objective_id=$1",
      [OBJECTIVE],
    );
    expect(JSON.parse(result.rows[0]?.rendered_body ?? "{}")).toMatchObject({
      steps: [{ stepIndex: 0, origin: "https://merchant.example", fields: [{ name: "answer" }] }],
    });
    const state = await getPool().query<{ state: string; result_id: string }>(
      "SELECT state,result_id FROM objectives WHERE objective_id=$1",
      [OBJECTIVE],
    );
    expect(state.rows[0]?.state).toBe("delivered");
    expect(state.rows[0]?.result_id).toMatch(/^res_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(
      (await getPool().query("SELECT event_id FROM outbox_events WHERE name='objective.delivered'"))
        .rowCount,
    ).toBe(1);
  });

  it("does not sign closeEnvelope while a reservation, pocket, or job remains open", async () => {
    const sign = vi.fn();
    const closed = await completeObjective(
      { objectiveId: OBJECTIVE, planId: PLAN, envelopeRef: ENVELOPE, vault: VAULT, envelopeId: 1n },
      {
        pool: getPool(),
        config: loadConfig(),
        signer: { sign },
        chain: {
          readEnvelope: async () => ({
            state: "Open",
            openReservations: 0n,
            openPockets: 1n,
            openJobs: 0n,
          }),
          closeEnvelope: vi.fn(),
          transactionCount: vi.fn(async () => 0),
          transactionStatus: vi.fn(
            async (): Promise<"success" | "reverted" | undefined> => undefined,
          ),
        },
        now: () => new Date("2026-10-25T12:00:00Z"),
        random: { bytes: (size: number) => Buffer.alloc(size, 2) },
      },
    );
    expect(closed).toBe(false);
    expect(sign).not.toHaveBeenCalled();
    expect(
      (await getPool().query("SELECT 1 FROM results WHERE objective_id=$1", [OBJECTIVE])).rowCount,
    ).toBe(0);
  });

  it("uses only the quarantine notice when every StepResult is quarantined", async () => {
    await getPool().query(
      `INSERT INTO step_executions(plan_id,step_index,attempt,phase,payload)
       VALUES($1,0,0,'step.result',$2::jsonb)`,
      [
        PLAN,
        JSON.stringify({
          stepResult: {
            schemaVersion: "1.0",
            stepIndex: 0,
            status: "unknown",
            source: { origin: "https://merchant.example", payTo: VAULT, paymentRefHash: HASH },
            fields: [],
            flags: ["injection-suspect"],
            bodyCommit: HASH,
          },
        }),
      ],
    );
    await completeObjective(
      { objectiveId: OBJECTIVE, planId: PLAN, envelopeRef: ENVELOPE, vault: VAULT, envelopeId: 1n },
      {
        pool: getPool(),
        config: loadConfig(),
        signer: { sign: vi.fn(async () => ({ signedTransaction: "0x01" as `0x${string}` })) },
        chain: {
          readEnvelope: async () => ({
            state: "Closed",
            openReservations: 0n,
            openPockets: 0n,
            openJobs: 0n,
          }),
          closeEnvelope: vi.fn(),
          transactionCount: vi.fn(async () => 0),
          transactionStatus: vi.fn(
            async (): Promise<"success" | "reverted" | undefined> => undefined,
          ),
        },
        now: () => new Date("2026-10-25T12:00:00Z"),
        random: { bytes: (size: number) => Buffer.alloc(size, 3) },
      },
    );
    const result = await getPool().query<{ rendered_body: string }>(
      "SELECT rendered_body FROM results WHERE objective_id=$1",
      [OBJECTIVE],
    );
    expect(result.rows[0]?.rendered_body).toContain("quarantined");
    expect(result.rows[0]?.rendered_body).not.toContain("merchant.example");
    const state = await getPool().query<{ state: string }>(
      "SELECT state FROM objectives WHERE objective_id=$1",
      [OBJECTIVE],
    );
    expect(state.rows[0]?.state).toBe("failed");
  });
});
