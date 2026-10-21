import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { categoryHash } from "@czar/hashing";
import { validateRecordedExchange } from "@czar/api-contract";
import { czarVaultAbi } from "@czar/vault-client";
import type { Plan, SubjectsRevision } from "@czar/schemas";
import { decodeFunctionData } from "viem";
import { recomputePlanHash } from "#src/planner/index";
import { setupDatabase } from "#test/db";
import {
  createTestContext,
  makeObjectiveSubmission,
  seedDevice,
  TEST_NOW,
  TEST_USER_ID,
} from "#test/fixtures";

const getPool = setupDatabase();
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const OBJECTIVE_ID = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const VAULT = "0x0000000000000000000000000000000000000011";
const HASH = `0x${"1".repeat(64)}` as `0x${string}`;
const APP_TOKEN = Buffer.alloc(32, 41).toString("base64url");

function planFixture(): Plan {
  const plan: Plan = {
    schemaVersion: "1.2",
    planId: PLAN_ID,
    objectiveId: OBJECTIVE_ID,
    objectiveHash: HASH,
    planHash: HASH,
    network: "eip155:5042002",
    category: "research",
    cap: "0",
    slackBps: 2500,
    maxStepAmount: "0",
    pocketCapBps: 0,
    expiresAt: "2026-10-23T00:00:00.000Z",
    steps: [],
    payeeLeaves: [],
    payeeRoot: HASH,
    shadow: false,
    createdAt: TEST_NOW.toISOString(),
    taskSpec: makeObjectiveSubmission(OBJECTIVE_ID).taskSpec,
  };
  return { ...plan, planHash: recomputePlanHash(plan) };
}

async function seedPlan(): Promise<void> {
  const pool = getPool();
  const submission = makeObjectiveSubmission(OBJECTIVE_ID);
  const plan = planFixture();
  await pool.query("UPDATE users SET vault=$2 WHERE user_id=$1", [TEST_USER_ID, VAULT]);
  await pool.query("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)", [
    createHash("sha256").update(APP_TOKEN).digest(),
    TEST_USER_ID,
    new Date("2030-01-01T00:00:00Z"),
  ]);
  await pool.query(
    `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state,plan_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,'awaiting-approval',$6,$7,$7)`,
    [
      OBJECTIVE_ID,
      TEST_USER_ID,
      submission.deviceId,
      JSON.stringify(submission),
      HASH,
      PLAN_ID,
      TEST_NOW,
    ],
  );
  await pool.query(
    `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state,created_at,updated_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,'offered',$6,$6)`,
    [PLAN_ID, OBJECTIVE_ID, JSON.stringify(plan), plan.planHash, plan.payeeRoot, TEST_NOW],
  );
}

describe("approval app routes", () => {
  beforeAll(async () => seedDevice(getPool()));

  beforeEach(async () => {
    await getPool().query("DELETE FROM outbox_events");
    await getPool().query("DELETE FROM plans");
    await getPool().query("DELETE FROM objectives");
    await getPool().query("DELETE FROM sessions");
  });

  it("lists only owned pending plans and returns the full plan", async () => {
    await seedPlan();
    const { app } = createTestContext(getPool());
    const headers = { Authorization: `Bearer ${APP_TOKEN}` };
    const list = await app.request("/v1/approvals?status=pending", { headers });
    const page = (await list.json()) as {
      items: { planId: string; objectiveId: string; status: string }[];
    };
    expect(list.status).toBe(200);
    expect(
      validateRecordedExchange("listApprovals", { responseStatus: list.status, responseBody: page })
        .valid,
    ).toBe(true);
    expect(page.items[0]).toMatchObject({
      planId: PLAN_ID,
      objectiveId: OBJECTIVE_ID,
      status: "pending",
    });

    const detail = await app.request(`/v1/approvals/${PLAN_ID}`, { headers });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ planId: PLAN_ID });
  });

  it("creates exact openEnvelope calldata from the owned offered plan", async () => {
    await seedPlan();
    const { app } = createTestContext(getPool());
    const requestBody = { fillInPlace: true };
    const response = await app.request(`/v1/approvals/${PLAN_ID}/intent`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APP_TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "4f4e8c7d-94a3-4c6a-8f77-6db94f240c0a",
      },
      body: JSON.stringify(requestBody),
    });
    const body = (await response.json()) as {
      vault: string;
      to: string;
      value: string;
      chainId: number;
      decoded: { categoryId: string };
    };
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ vault: VAULT, to: VAULT, value: "0", chainId: 5042002 });
    expect(body.decoded.categoryId).toBe(categoryHash("research"));
    expect(
      validateRecordedExchange("createApprovalIntent", {
        requestBody,
        responseStatus: response.status,
        responseBody: body,
      }).valid,
    ).toBe(true);
    const replay = await app.request(`/v1/approvals/${PLAN_ID}/intent`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APP_TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "4f4e8c7d-94a3-4c6a-8f77-6db94f240c0a",
      },
      body: JSON.stringify(requestBody),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
    const conflict = await app.request(`/v1/approvals/${PLAN_ID}/intent`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APP_TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "4f4e8c7d-94a3-4c6a-8f77-6db94f240c0a",
      },
      body: JSON.stringify({ fillInPlace: false }),
    });
    expect(conflict.status).toBe(409);
    const issued = await app.request("/v1/approvals?status=intent-issued", {
      headers: { Authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(((await issued.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("revises plan subjects through the planner and replays idempotently", async () => {
    await seedPlan();
    const revision: SubjectsRevision = { subjects: [{ label: "Vendor Beta", addedByUser: true }] };
    const priorPlan = planFixture();
    const revised: Plan = {
      ...priorPlan,
      taskSpec: {
        ...priorPlan.taskSpec!,
        subjects: [{ label: "Vendor Beta", addedByUser: true }],
      },
    };
    const result: Plan = { ...revised, planHash: recomputePlanHash(revised) };
    const revisePlanSubjects = vi.fn(
      async (_userId: string, _planId: string, _revision: SubjectsRevision) => result,
    );
    const { app } = createTestContext(getPool(), { revisePlanSubjects });
    const headers = {
      Authorization: `Bearer ${APP_TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "30c905e9-cc7a-4f7d-b865-d13af189346b",
    };
    const request = {
      method: "POST",
      headers,
      body: JSON.stringify(revision),
    } as const;
    const response = await app.request(`/v1/approvals/${PLAN_ID}/subjects`, request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      taskSpec: { subjects: revision.subjects },
      planHash: result.planHash,
    });
    const replay = await app.request(`/v1/approvals/${PLAN_ID}/subjects`, request);
    expect(replay.status).toBe(200);
    expect(revisePlanSubjects).toHaveBeenCalledTimes(1);
  });

  it.each(["freeze", "unfreeze"] as const)("creates the %s owner intent", async (action) => {
    await seedPlan();
    const { app } = createTestContext(getPool());
    const requestBody = { action };
    const response = await app.request("/v1/freeze/intent", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APP_TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "4f4e8c7d-94a3-4c6a-8f77-6db94f240c0a",
      },
      body: JSON.stringify(requestBody),
    });
    const body = (await response.json()) as { calldata: `0x${string}`; vault: string; to: string };
    expect(response.status).toBe(200);
    expect(body.vault).toBe(VAULT);
    expect(body.to).toBe(VAULT);
    expect(decodeFunctionData({ abi: czarVaultAbi, data: body.calldata }).functionName).toBe(
      action,
    );
    expect(
      validateRecordedExchange("createFreezeIntent", {
        requestBody,
        responseStatus: response.status,
        responseBody: body,
      }).valid,
    ).toBe(true);
  });

  it("records a submitted UserOperation idempotently", async () => {
    await seedPlan();
    const { app } = createTestContext(getPool());
    const requestBody = { userOpHash: `0x${"3".repeat(64)}`, bundler: "circle" };
    const send = () =>
      app.request(`/v1/approvals/${PLAN_ID}/submitted`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${APP_TOKEN}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "4f4e8c7d-94a3-4c6a-8f77-6db94f240c0a",
        },
        body: JSON.stringify(requestBody),
      });
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(202);
    const objective = await getPool().query<{ state: string }>(
      "SELECT state FROM objectives WHERE objective_id=$1",
      [OBJECTIVE_ID],
    );
    expect(objective.rows[0]?.state).toBe("opening");
    const conflicting = await app.request(`/v1/approvals/${PLAN_ID}/submitted`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APP_TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "4f4e8c7d-94a3-4c6a-8f77-6db94f240c0a",
      },
      body: JSON.stringify({ userOpHash: `0x${"4".repeat(64)}`, bundler: "circle" }),
    });
    expect(conflicting.status).toBe(409);
  });
});
