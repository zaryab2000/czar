import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { validateRecordedExchange } from "@czar/api-contract";
import type { AppPage, ManualReturn } from "@czar/schemas";
import { setupDatabase } from "#test/db";
import {
  createTestContext,
  makeObjectiveSubmission,
  seedDevice,
  TEST_DEVICE_ID,
  TEST_USER_ID,
} from "#test/fixtures";

const getPool = setupDatabase();
const APP_TOKEN = Buffer.alloc(32, 31).toString("base64url");
const OTHER_TOKEN = Buffer.alloc(32, 32).toString("base64url");
const OTHER_USER_ID = "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
const OTHER_DEVICE_ID = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
const PRIMARY_PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2A";
const OTHER_PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2B";
const PRIMARY_OBJECTIVE_ID = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2A";
const OTHER_OBJECTIVE_ID = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2B";
const VAULT = "0x0000000000000000000000000000000000000001";
const OTHER_VAULT = "0x0000000000000000000000000000000000000002";
const PLAN_HASH = `0x${"11".repeat(32)}`;
const PAYEE_ROOT = `0x${"22".repeat(32)}`;
const RETURN_TXS = [`0x${"31".repeat(32)}`, `0x${"32".repeat(32)}`, `0x${"33".repeat(32)}`];

describe("listManualReturns app route", () => {
  beforeAll(async () => {
    const pool = getPool();
    await seedDevice(pool);
    await pool.query("INSERT INTO users(user_id) VALUES($1)", [OTHER_USER_ID]);
    await pool.query(
      `INSERT INTO devices(device_id,user_id,device_name,platform,token_hash)
       VALUES($1,$2,'Other user','macos',$3)`,
      [OTHER_DEVICE_ID, OTHER_USER_ID, Buffer.alloc(32, 41)],
    );
    await seedObjectiveAndPlan(TEST_USER_ID, TEST_DEVICE_ID, PRIMARY_OBJECTIVE_ID, PRIMARY_PLAN_ID);
    await seedObjectiveAndPlan(OTHER_USER_ID, OTHER_DEVICE_ID, OTHER_OBJECTIVE_ID, OTHER_PLAN_ID);
  });

  beforeEach(async () => {
    const pool = getPool();
    await pool.query("DELETE FROM sessions");
    await pool.query(
      `INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$4),($3,$5,$4)`,
      [
        createHash("sha256").update(APP_TOKEN).digest(),
        TEST_USER_ID,
        createHash("sha256").update(OTHER_TOKEN).digest(),
        new Date("2030-01-01T00:00:00Z"),
        OTHER_USER_ID,
      ],
    );
    await pool.query("DELETE FROM payer_pullback_gateway_failures WHERE plan_id=ANY($1::text[])", [
      [PRIMARY_PLAN_ID, OTHER_PLAN_ID],
    ]);
    await insertManualReturns(PRIMARY_PLAN_ID, VAULT, RETURN_TXS);
    await insertManualReturns(OTHER_PLAN_ID, OTHER_VAULT, [`0x${"44".repeat(32)}`]);
  });

  it("returns schema-valid manual returns only for the authenticated user", async () => {
    const context = createTestContext(getPool());
    const response = await context.app.request("/v1/pockets/manual-returns", {
      headers: appHeaders(APP_TOKEN),
    });
    const body = (await response.json()) as AppPage<ManualReturn>;

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(3);
    expect(body.items.map((item) => item.vault)).toEqual([VAULT, VAULT, VAULT]);
    expect(body.items.map((item) => item.state)).toEqual([
      "manual-return-required",
      "recorded",
      "expired",
    ]);
    expect(
      validateRecordedExchange("listManualReturns", {
        responseStatus: response.status,
        responseBody: body,
      }).valid,
    ).toBe(true);

    const otherResponse = await context.app.request("/v1/pockets/manual-returns", {
      headers: appHeaders(OTHER_TOKEN),
    });
    const otherBody = (await otherResponse.json()) as AppPage<ManualReturn>;
    expect(otherBody.items).toHaveLength(1);
    expect(otherBody.items[0]?.vault).toBe(OTHER_VAULT);
  });

  it("paginates using an opaque cursor and rejects malformed pagination", async () => {
    const context = createTestContext(getPool());
    const firstResponse = await context.app.request("/v1/pockets/manual-returns?limit=2", {
      headers: appHeaders(APP_TOKEN),
    });
    const firstPage = (await firstResponse.json()) as AppPage<ManualReturn>;
    expect(firstResponse.status).toBe(200);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const foreignCursorResponse = await context.app.request(
      `/v1/pockets/manual-returns?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
      { headers: appHeaders(OTHER_TOKEN) },
    );
    expect(foreignCursorResponse.status).toBe(400);

    const secondResponse = await context.app.request(
      `/v1/pockets/manual-returns?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
      { headers: appHeaders(APP_TOKEN) },
    );
    const secondPage = (await secondResponse.json()) as AppPage<ManualReturn>;
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();

    const invalidLimit = await context.app.request("/v1/pockets/manual-returns?limit=201", {
      headers: appHeaders(APP_TOKEN),
    });
    expect(invalidLimit.status).toBe(400);
    const invalidCursor = await context.app.request(
      "/v1/pockets/manual-returns?cursor=not-a-cursor",
      { headers: appHeaders(APP_TOKEN) },
    );
    expect(invalidCursor.status).toBe(400);
  });

  it("requires an AppSession bearer token", async () => {
    const context = createTestContext(getPool());
    const response = await context.app.request("/v1/pockets/manual-returns");
    expect(response.status).toBe(401);
  });
});

async function seedObjectiveAndPlan(
  userId: string,
  deviceId: string,
  objectiveId: string,
  planId: string,
): Promise<void> {
  const pool = getPool();
  const submission = makeObjectiveSubmission(objectiveId, { deviceId });
  await pool.query(
    `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
     VALUES($1,$2,$3,$4::jsonb,$5,'received')`,
    [objectiveId, userId, deviceId, JSON.stringify(submission), submission.objectiveHash],
  );
  await pool.query(
    `INSERT INTO plans(plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES($1,$2,'{}',$3,$4,'offered')`,
    [planId, objectiveId, PLAN_HASH, PAYEE_ROOT],
  );
}

async function insertManualReturns(
  planId: string,
  vault: string,
  returnTxs: readonly string[],
): Promise<void> {
  const pool = getPool();
  for (const [index, returnTx] of returnTxs.entries()) {
    const state = index === 0 ? "manual-return-required" : index === 1 ? "recorded" : "expired";
    await pool.query(
      `INSERT INTO payer_pullback_gateway_failures
       (plan_id,step_index,envelope_ref,pocket,value,unavailable_since,state,
        vault_address,gateway_minter,attempt,return_tx,return_block,return_log_index,
        returned_amount,manual_return_required_at,recorded_credit,recorded_tx)
       VALUES($1,$2,$3,$4,100000,$5,$6,$7,$8,0,$9,50,$2,80000,$5,$10,$11)`,
      [
        planId,
        index,
        `eip155:5042002:${vault.toLowerCase()}:${index + 1}`,
        `0x${(index + 1).toString(16).padStart(40, "0")}`,
        new Date(`2026-10-26T00:0${index}:00Z`),
        state,
        vault,
        "0x0000000000000000000000000000000000000099",
        returnTx,
        state === "recorded" ? "70000" : null,
        state === "recorded" ? `0x${"55".repeat(32)}` : null,
      ],
    );
  }
}

function appHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
