import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { validateRecordedExchange } from "@czar/api-contract";
import { loadConfig } from "@czar/config";
import type { Pool } from "pg";
import { setupDatabase } from "#test/db";
import {
  createTestContext,
  seedDevice,
  TEST_DEVICE_ID,
  TEST_TOKEN,
  TEST_USER_ID,
} from "#test/fixtures";

const getPool = setupDatabase();
const promptHash = `0x${"a".repeat(64)}`;
const idempotencyKey = "8f4e8c7d-94a3-4c6a-8f77-6db94f240c0a";
const repeatedKey = "8f4e8c7d-94a3-4c6a-8f77-6db94f240c0b";
const capUserId = "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2A";
const capDeviceId = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2A";
const capToken = Buffer.alloc(32, 9).toString("base64url");
const inputMarker = "private-model-input-marker-218d3f";
const outputMarker = "private-model-output-marker-98b1a7";
const modelRequest = {
  prompt: "P-01",
  promptHash,
  input: { sourceLabel: { kind: "merchant-body" }, text: inputMarker },
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: {
      answer: { type: "string" },
    },
  },
};
const modelResponse = {
  output: { answer: outputMarker },
  usage: { inputTokens: 17, outputTokens: 5 },
};

describe("completeModelCall route", () => {
  beforeAll(async () => {
    await seedDevice(getPool());
  });

  it("returns the injected model result and stores and logs counts without either body", async () => {
    const modelClient = {
      complete: vi.fn(async (_request: unknown, _options: unknown) => modelResponse),
    };
    const context = createTestContext(getPool(), { modelClient });
    const response = await context.app.request("/v1/models/complete", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(modelRequest),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(modelResponse);
    expect(modelClient.complete).toHaveBeenCalledTimes(1);
    expect(modelClient.complete.mock.calls[0]?.[0]).toEqual(modelRequest);
    expect(
      validateRecordedExchange("completeModelCall", {
        requestBody: modelRequest,
        responseStatus: response.status,
        responseBody: body,
      }).valid,
    ).toBe(true);
    expect(context.logLines.join("\n")).not.toContain(inputMarker);
    expect(context.logLines.join("\n")).not.toContain(outputMarker);
    const persistedRows = await scanDatabaseFor(inputMarker, outputMarker);
    expect(persistedRows).toEqual([]);

    const idempotency = await getPool().query<{
      status: number;
      fingerprint: Buffer;
      response_body: unknown;
      response_hash: Buffer | null;
      replay_stored: boolean;
      model_input_tokens: number;
      model_output_tokens: number;
    }>(
      `SELECT status,fingerprint,response_body,response_hash,replay_stored,
         model_input_tokens::int,model_output_tokens::int
       FROM idempotency WHERE scope=$1 AND key=$2`,
      [`completeModelCall:${TEST_DEVICE_ID}`, idempotencyKey],
    );
    expect(idempotency.rows[0]).toMatchObject({
      status: 200,
      replay_stored: false,
      model_input_tokens: 17,
      model_output_tokens: 5,
    });
    expect(idempotency.rows[0]?.fingerprint).toHaveLength(32);
    expect(idempotency.rows[0]?.response_body).toBeNull();
    expect(idempotency.rows[0]?.response_hash).toBeNull();

    const usage = await getPool().query<{
      prompt: string;
      input_tokens: number;
      output_tokens: number;
    }>(
      `SELECT prompt,input_tokens::int,output_tokens::int
       FROM model_usage WHERE user_id=$1`,
      [TEST_USER_ID],
    );
    expect(usage.rows).toEqual([{ prompt: "P-01", input_tokens: 17, output_tokens: 5 }]);
  });

  it("modelProxy_sameKeyReturnsReplayNotStoredEvenForDifferentBody", async () => {
    const modelClient = { complete: vi.fn(async () => modelResponse) };
    const context = createTestContext(getPool(), { modelClient });
    const first = await postModelCall(context.app, modelRequest, repeatedKey);
    const changedRequest = {
      ...modelRequest,
      prompt: "P-04",
      input: { currentBeliefs: [], candidates: [], sections: [] },
    };
    const replay = await postModelCall(context.app, changedRequest, repeatedKey);
    const body = (await replay.json()) as Record<string, unknown>;

    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(body["czarCode"]).toBe("replay-not-stored");
    expect(modelClient.complete).toHaveBeenCalledTimes(1);
    expect(context.logLines.join("\n")).not.toContain(inputMarker);
    expect(context.logLines.join("\n")).not.toContain(outputMarker);
  });

  it("modelProxy_rejectsPromptsOutsideTheAllowlistBeforeCallingClient", async () => {
    const modelClient = { complete: vi.fn(async () => modelResponse) };
    const context = createTestContext(getPool(), { modelClient });
    const response = await postModelCall(
      context.app,
      { ...modelRequest, prompt: "P-02" },
      "8f4e8c7d-94a3-4c6a-8f77-6db94f240c0c",
    );

    expect(response.status).toBe(400);
    expect(modelClient.complete).not.toHaveBeenCalled();
  });

  it("modelProxy_rejectsOutputThatDoesNotMatchCallerSchemaWithoutStoringBodies", async () => {
    const modelClient = {
      complete: vi.fn(async () => ({
        output: { extra: outputMarker },
        usage: { inputTokens: 2, outputTokens: 3 },
      })),
    };
    const context = createTestContext(getPool(), { modelClient });
    const response = await postModelCall(
      context.app,
      modelRequest,
      "8f4e8c7d-94a3-4c6a-8f77-6db94f240c0d",
    );

    expect(response.status).toBe(503);
    expect(await scanDatabaseFor(inputMarker, outputMarker)).toEqual([]);
    expect(context.logLines.join("\n")).not.toContain(inputMarker);
    expect(context.logLines.join("\n")).not.toContain(outputMarker);
  });

  it("modelProxy_consumesIdempotencyKeyWhenClientReturnsMalformedResult", async () => {
    const modelClient = { complete: vi.fn(async () => undefined as never) };
    const context = createTestContext(getPool(), { modelClient });
    const key = "8f4e8c7d-94a3-4c6a-8f77-6db94f240c12";
    const response = await postModelCall(context.app, modelRequest, key);
    const duplicate = await postModelCall(context.app, modelRequest, key);
    const row = await getPool().query<{ status: number; replay_stored: boolean }>(
      "SELECT status,replay_stored FROM idempotency WHERE scope=$1 AND key=$2",
      [`completeModelCall:${TEST_DEVICE_ID}`, key],
    );

    expect(response.status).toBe(503);
    expect(duplicate.status).toBe(409);
    expect(row.rows[0]).toEqual({ status: 503, replay_stored: false });
    expect(modelClient.complete).toHaveBeenCalledTimes(1);
  });

  it("modelProxy_abortsAClientThatExceedsThePromptTimeout", async () => {
    const config = loadConfig({ envFile: { "models.screen.timeoutMs": 5 } });
    const modelClient = { complete: vi.fn(() => new Promise<never>(() => {})) };
    const context = createTestContext(getPool(), { modelClient, config });
    const response = await postModelCall(
      context.app,
      modelRequest,
      "8f4e8c7d-94a3-4c6a-8f77-6db94f240c13",
    );

    expect(response.status).toBe(503);
    expect(modelClient.complete).toHaveBeenCalledTimes(1);
  });

  it("modelProxy_enforcesUserAndP07MonthlyCapsSeparately", async () => {
    await seedModelDevice(getPool(), capUserId, capDeviceId, capToken);
    const config = loadConfig({
      envFile: {
        "models.userMonthlyTokens": 20,
        "models.sourceExtractorMonthlyTokens": 10,
      },
    });
    const modelClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          output: { answer: "source extracted" },
          usage: { inputTokens: 4, outputTokens: 6 },
        })
        .mockResolvedValueOnce({
          output: { answer: "screened" },
          usage: { inputTokens: 5, outputTokens: 5 },
        }),
    };
    const context = createTestContext(getPool(), { modelClient, config });
    const p07Request = {
      ...modelRequest,
      prompt: "P-07",
      input: {
        sourceClass: "agent-file",
        sourceKind: "agent-file",
        sourceReceiptId: "src_01K7ZT9P4N5Q6R7S8T9V0W1X2A",
        text: inputMarker,
        sections: ["mission"],
        maxProposals: 5,
      },
    };
    const p07First = await postModelCall(
      context.app,
      p07Request,
      "8f4e8c7d-94a3-4c6a-8f77-6db94f240c0e",
      capToken,
    );
    const p07OverCap = await postModelCall(
      context.app,
      p07Request,
      "8f4e8c7d-94a3-4c6a-8f77-6db94f240c0f",
      capToken,
    );
    const p01 = await postModelCall(
      context.app,
      modelRequest,
      "8f4e8c7d-94a3-4c6a-8f77-6db94f240c10",
      capToken,
    );
    const userOverCap = await postModelCall(
      context.app,
      modelRequest,
      "8f4e8c7d-94a3-4c6a-8f77-6db94f240c11",
      capToken,
    );

    expect(p07First.status).toBe(200);
    expect(p07OverCap.status).toBe(503);
    expect(p01.status).toBe(200);
    expect(userOverCap.status).toBe(503);
    expect(modelClient.complete).toHaveBeenCalledTimes(2);
    expect(modelClient.complete.mock.calls[0]?.[1]).toMatchObject({
      maxTotalTokens: 10,
      timeoutMs: 10_000,
    });
    expect(modelClient.complete.mock.calls[1]?.[1]).toMatchObject({
      maxTotalTokens: 10,
      timeoutMs: 2_000,
    });
    const usage = await getPool().query<{
      prompt: string;
      input_tokens: number;
      output_tokens: number;
    }>(
      `SELECT prompt,input_tokens::int,output_tokens::int
       FROM model_usage WHERE user_id=$1 ORDER BY prompt`,
      [capUserId],
    );
    expect(usage.rows).toEqual([
      { prompt: "P-01", input_tokens: 5, output_tokens: 5 },
      { prompt: "P-07", input_tokens: 4, output_tokens: 6 },
    ]);
    const reservations = await getPool().query(
      "SELECT 1 FROM model_reservations WHERE user_id=$1",
      [capUserId],
    );
    expect(reservations.rowCount).toBe(0);
  });

  it("modelProxy_capsEachCallAndEachPromptMonthlyBudget", async () => {
    const userId = "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2B";
    const token = Buffer.alloc(32, 11).toString("base64url");
    await seedModelDevice(getPool(), userId, "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2B", token);
    const config = loadConfig({ envFile: { "models.screenMonthlyTokens": 30 } });
    const modelClient = {
      complete: vi.fn(async (_request: unknown, _options: unknown) => ({
        output: { answer: "screened" },
        usage: { inputTokens: 10, outputTokens: 10 },
      })),
    };
    const context = createTestContext(getPool(), { modelClient, config });
    const first = await postModelCall(
      context.app,
      modelRequest,
      "8f4e8c7d-94a3-4c6a-8f77-6db94f240c21",
      token,
    );
    const second = await postModelCall(
      context.app,
      modelRequest,
      "8f4e8c7d-94a3-4c6a-8f77-6db94f240c22",
      token,
    );
    const third = await postModelCall(
      context.app,
      modelRequest,
      "8f4e8c7d-94a3-4c6a-8f77-6db94f240c23",
      token,
    );
    // First call: the 30-token P-01 monthly cap is below the 4,000 per-call cap.
    expect(modelClient.complete.mock.calls[0]?.[1]).toMatchObject({ maxTotalTokens: 30 });
    expect(first.status).toBe(200);
    // Second call: 10 tokens left in the P-01 month; the model used 20, so it is refused.
    expect(modelClient.complete.mock.calls[1]?.[1]).toMatchObject({ maxTotalTokens: 10 });
    expect(second.status).toBe(503);
    // Third call: the P-01 month is spent; the provider is not called.
    expect(third.status).toBe(503);
    expect(modelClient.complete).toHaveBeenCalledTimes(2);

    const perCall = createTestContext(getPool(), { modelClient });
    await postModelCall(perCall.app, modelRequest, "8f4e8c7d-94a3-4c6a-8f77-6db94f240c24");
    expect(modelClient.complete.mock.calls[2]?.[1]).toMatchObject({ maxTotalTokens: 4000 });
  });

  it("modelProxy_holdsNoLockDuringTheProviderCallAndReservesConcurrentBudget", async () => {
    const userId = "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2C";
    const token = Buffer.alloc(32, 12).toString("base64url");
    await seedModelDevice(getPool(), userId, "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2C", token);
    const config = loadConfig({ envFile: { "models.screenMonthlyTokens": 6000 } });
    const firstGate = deferred();
    const releaseFirst = firstGate.resolve;
    const modelClient = {
      complete: vi
        .fn()
        .mockImplementationOnce(async () => {
          await firstGate.promise;
          return { output: { answer: "slow" }, usage: { inputTokens: 1, outputTokens: 1 } };
        })
        .mockImplementationOnce(async () => ({
          output: { answer: "fast" },
          usage: { inputTokens: 1, outputTokens: 1 },
        })),
    };
    const context = createTestContext(getPool(), { modelClient, config });
    const slow = postModelCall(
      context.app,
      modelRequest,
      "8f4e8c7d-94a3-4c6a-8f77-6db94f240c25",
      token,
    );
    await vi.waitFor(() => expect(modelClient.complete).toHaveBeenCalledTimes(1));
    // While the first call is in flight, its reservation is visible and no lock blocks a second call.
    const inFlight = await getPool().query<{ tokens: string }>(
      "SELECT tokens FROM model_reservations WHERE user_id=$1",
      [userId],
    );
    expect(inFlight.rows.map((row) => Number(row.tokens))).toEqual([4000]);
    const fast = await postModelCall(
      context.app,
      modelRequest,
      "8f4e8c7d-94a3-4c6a-8f77-6db94f240c26",
      token,
    );
    expect(fast.status).toBe(200);
    expect(modelClient.complete.mock.calls[1]?.[1]).toMatchObject({ maxTotalTokens: 2000 });
    releaseFirst();
    expect((await slow).status).toBe(200);
    const left = await getPool().query("SELECT 1 FROM model_reservations WHERE user_id=$1", [
      userId,
    ]);
    expect(left.rowCount).toBe(0);
  });

  it("modelProxy_sameKeyWhileInFlightGetsReplayNotStored", async () => {
    const gate = deferred();
    const release = gate.resolve;
    const modelClient = {
      complete: vi.fn(async () => {
        await gate.promise;
        return modelResponse;
      }),
    };
    const context = createTestContext(getPool(), { modelClient });
    const key = "8f4e8c7d-94a3-4c6a-8f77-6db94f240c27";
    const first = postModelCall(context.app, modelRequest, key);
    await vi.waitFor(() => expect(modelClient.complete).toHaveBeenCalledTimes(1));
    const again = await postModelCall(context.app, modelRequest, key);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { czarCode: string }).czarCode).toBe("replay-not-stored");
    release();
    expect((await first).status).toBe(200);
    expect(modelClient.complete).toHaveBeenCalledTimes(1);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  const handle: { resolve?: () => void } = {};
  const promise = new Promise<void>((done) => {
    handle.resolve = done;
  });
  return { promise, resolve: () => handle.resolve?.() };
}

async function postModelCall(
  app: ReturnType<typeof createTestContext>["app"],
  body: unknown,
  key: string,
  token = TEST_TOKEN,
): Promise<Response> {
  return app.request("/v1/models/complete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
}

async function seedModelDevice(
  pool: Pool,
  userId: string,
  deviceId: string,
  token: string,
): Promise<void> {
  await pool.query("INSERT INTO users (user_id) VALUES ($1)", [userId]);
  await pool.query(
    `INSERT INTO devices (device_id,user_id,device_name,platform,token_hash)
     VALUES ($1,$2,'Budget test device','macos',$3)`,
    [deviceId, userId, createHash("sha256").update(token).digest()],
  );
}

async function scanDatabaseFor(...markers: string[]): Promise<string[]> {
  const tables = await getPool().query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
  );
  const found: string[] = [];
  for (const { table_name: tableName } of tables.rows) {
    const rows = await getPool().query<{ row_json: string }>(
      `SELECT to_jsonb(row_data)::text AS row_json FROM "${tableName}" AS row_data`,
    );
    for (const { row_json: rowJson } of rows.rows) {
      if (markers.some((marker) => rowJson.includes(marker))) found.push(`${tableName}:${rowJson}`);
    }
  }
  return found;
}
