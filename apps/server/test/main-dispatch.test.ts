import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "@czar/logging";
import { createLocalServerMain } from "#src/local-main";
import { setupDatabase } from "#test/db";
import {
  makeObjectiveSubmission,
  seedDevice,
  testAppConfig,
  TEST_DEVICE_ID,
  TEST_USER_ID,
} from "#test/fixtures";
import { testSigner } from "#test/payer/test-signer";

const getPool = setupDatabase();
const OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const PLAN = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const VAULT = "0x0000000000000000000000000000000000000001" as const;
const ENVELOPE = `eip155:5042002:${VAULT}:1`;
const FACTORY = "0x0000000000000000000000000000000000000002" as const;

describe("started server payer composition", () => {
  beforeAll(async () => seedDevice(getPool()));

  it("dispatches an approved plan step from the local server entry composition", async () => {
    await clearRows();
    await getPool().query("UPDATE users SET vault=$1 WHERE user_id=$2", [VAULT, TEST_USER_ID]);
    const submission = makeObjectiveSubmission(OBJECTIVE);
    const step = {
      stepIndex: 0,
      stepId: "stp_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
      capability: "local-template",
      kind: "local",
      unitAmount: "0",
      expectedCalls: 0,
      stepCap: "0",
      routingReason: "below-pocket-threshold",
    };
    await getPool().query(
      `INSERT INTO objectives
       (objective_id,user_id,device_id,submission,objective_hash,state,plan_id,envelope_ref)
       VALUES ($1,$2,$3,$4::jsonb,$5,'executing',$6,$7)`,
      [
        OBJECTIVE,
        TEST_USER_ID,
        TEST_DEVICE_ID,
        JSON.stringify(submission),
        submission.objectiveHash,
        PLAN,
        ENVELOPE,
      ],
    );
    await getPool().query(
      `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
       VALUES ($1,$2,$3::jsonb,$4,$5,'approved')`,
      [
        PLAN,
        OBJECTIVE,
        JSON.stringify({ steps: [step] }),
        `0x${"11".repeat(32)}`,
        `0x${"22".repeat(32)}`,
      ],
    );
    await getPool().query(
      "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,$2::jsonb,'queued')",
      [PLAN, JSON.stringify(step)],
    );

    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "frozen" || functionName === "guardianPaused") return false;
      if (functionName === "factory") return FACTORY;
      throw new Error(`Unexpected chain read: ${functionName}`);
    });
    const root = await createLocalServerMain({
      pool: getPool(),
      config: testAppConfig(),
      logger: createLogger({ service: "server", component: "CZ-15", sink: () => undefined }),
      createSigner: testSigner,
      publicClient: { readContract } as never,
      walletClient: {} as never,
      safeFetch: vi.fn(),
      rpcUrl: "http://127.0.0.1:8549",
      factoryAddress: FACTORY,
      indexerUrl: "http://127.0.0.1:42069",
      objects: {
        put: async () => "body",
        get: async () => new Uint8Array(),
        delete: async () => undefined,
      },
      clock: { now: () => new Date("2026-10-25T12:00:00Z") },
      random: { bytes: (size: number) => Buffer.alloc(size, 1) },
    });
    try {
      await waitForHandOff();
      const result = await getPool().query<{ state: string }>(
        "SELECT state FROM steps WHERE plan_id=$1 AND step_index=0",
        [PLAN],
      );
      expect(result.rows[0]?.state).toBe("handed_off");
      expect(readContract).toHaveBeenCalled();
    } finally {
      await root.close();
      await clearRows();
      await getPool().query("UPDATE users SET vault=NULL WHERE user_id=$1", [TEST_USER_ID]);
    }
  });
});

async function waitForHandOff(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await getPool().query<{ state: string }>(
      "SELECT state FROM steps WHERE plan_id=$1 AND step_index=0",
      [PLAN],
    );
    if (result.rows[0]?.state === "handed_off") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Started server did not dispatch the approved local step.");
}

async function clearRows(): Promise<void> {
  await getPool().query("DELETE FROM executor_leases");
  await getPool().query("DELETE FROM step_executions");
  await getPool().query("DELETE FROM steps");
  await getPool().query("DELETE FROM plans");
  await getPool().query("DELETE FROM objectives");
}
