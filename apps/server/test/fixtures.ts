import { createHash } from "node:crypto";
import { createLogger } from "@czar/logging";
import type { Config } from "@czar/config";
import { objectiveHash, taskSpecHash } from "@czar/hashing";
import type { TaskSpec } from "@czar/schemas";
import type { Plan, SubjectsRevision } from "@czar/schemas";
import { loadConfig } from "@czar/config";
import type { Pool } from "pg";
import { createApp } from "#src/app";
import type { AppReadOptions } from "#src/app/reads";
import type { ModelClient } from "#src/models/proxy";

export const TEST_NOW = new Date("2026-10-21T00:00:00.000Z");
export const TEST_USER_ID = "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
export const TEST_DEVICE_ID = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
export const TEST_TOKEN = Buffer.alloc(32, 7).toString("base64url");
let contextRandomOffset = 0;

export function testAppConfig(overrides: Record<string, unknown> = {}): Config {
  return loadConfig({
    envFile: {
      "app.circleClientUrl": "http://127.0.0.1:4337",
      "app.circleClientKey": "e2e-public-client-key",
      "app.arcRpcUrl": "http://127.0.0.1:8549",
      ...overrides,
    },
  });
}

export function createTestContext(
  pool: Pool,
  options: {
    modelClient?: ModelClient;
    config?: Config;
    appReadOptions?: AppReadOptions;
    revisePlanSubjects?: (
      userId: string,
      planId: string,
      revision: SubjectsRevision,
    ) => Promise<Plan | null>;
  } = {},
) {
  let currentTime = new Date(TEST_NOW);
  let randomCall = contextRandomOffset;
  contextRandomOffset += 32;
  const logLines: string[] = [];
  const clock = {
    now: () => new Date(currentTime),
    monotonicMs: () => currentTime.getTime(),
    advance: (milliseconds: number) => {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    },
  };
  const random = {
    bytes: (length: number) => {
      const bytes = Buffer.alloc(length, randomCall % 256);
      randomCall += 1;
      return bytes;
    },
  };
  const logger = createLogger({
    service: "server",
    component: "CZ-12",
    now: clock.now,
    sink: (line) => logLines.push(line),
  });
  const app = createApp({
    pool,
    config: options.config ?? testAppConfig(),
    logger,
    clock,
    random,
    ...(options.modelClient ? { modelClient: options.modelClient } : {}),
    ...(options.appReadOptions ? { appReadOptions: options.appReadOptions } : {}),
    ...(options.revisePlanSubjects ? { revisePlanSubjects: options.revisePlanSubjects } : {}),
  });
  return { app, clock, random, logger, logLines };
}

export async function seedDevice(pool: Pool, token = TEST_TOKEN): Promise<void> {
  await pool.query("INSERT INTO users (user_id) VALUES ($1)", [TEST_USER_ID]);
  await pool.query(
    `INSERT INTO devices (device_id, user_id, device_name, platform, token_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      TEST_DEVICE_ID,
      TEST_USER_ID,
      "Test device",
      "macos",
      createHash("sha256").update(token).digest(),
      TEST_NOW,
    ],
  );
}

export async function seedPairingCode(pool: Pool, code: string): Promise<void> {
  await pool.query("INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [
    TEST_USER_ID,
  ]);
  await pool.query(
    `INSERT INTO pairing_codes (code_digest, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [
      createHash("sha256").update(code).digest(),
      TEST_USER_ID,
      new Date(TEST_NOW.getTime() + 5 * 60_000),
    ],
  );
}

export function makeObjectiveSubmission(
  objectiveId: string,
  options: { deviceId?: string; goal?: string; subject?: string } = {},
) {
  const taskSpec: TaskSpec = {
    schemaVersion: "1.1" as const,
    kind: "table-fill" as const,
    topic: "Vendor pricing",
    subjects: [{ label: options.subject ?? "Vendor Alpha" }],
    fields: ["Monthly price"],
    sourceTrust: "user-prompt" as const,
  };
  const input = {
    objectiveId,
    soulVersionHash: `0x${"1".repeat(64)}`,
    observationHashes: [`0x${"2".repeat(64)}`],
    detector: "placeholder" as const,
    goal: options.goal ?? "Find monthly pricing for Vendor Alpha",
    capabilities: ["web-search"],
    minutesSaved: 30,
    hourlyBand: "B" as const,
    taskSpecHash: taskSpecHash(taskSpec),
  };
  const { taskSpecHash: computedTaskSpecHash, ...submissionFields } = input;
  return {
    schemaVersion: "1.0" as const,
    ...submissionFields,
    objectiveHash: objectiveHash({ ...submissionFields, taskSpecHash: computedTaskSpecHash }),
    redaction: { layer2: { hits: 0, entities: [] } },
    deviceId: options.deviceId ?? TEST_DEVICE_ID,
    submittedAt: TEST_NOW.toISOString(),
    taskSpec,
  };
}
