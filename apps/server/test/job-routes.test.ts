import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@czar/logging";
import { validateRecordedExchange } from "@czar/api-contract";
import { apiContracts } from "@czar/api-contract";
import { loadConfig } from "@czar/config";
import { briefRequestDigest, deliverableUploadDigest, type Hash32 } from "@czar/hashing";
import { buildJobBrief, uploadJobDeliverable } from "#src/payer/job";
import { createApp } from "#src/app";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_DEVICE_ID, TEST_USER_ID } from "#test/fixtures";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { keccak256 } from "viem";

const getPool = setupDatabase();
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const JOB_ESCROW = "0x0000000000000000000000000000000000000001" as const;
const now = new Date("2026-10-22T00:00:00.000Z");
const providerPrivateKey = generatePrivateKey();
const providerAccount = privateKeyToAccount(providerPrivateKey);
const brief = buildJobBrief({
  network: "eip155:5042002",
  jobEscrow: JOB_ESCROW,
  jobId: 7n,
  planHash: `0x${"11".repeat(32)}`,
  stepIndex: 0,
  acceptanceProfileId: "prof_00000000000000000000000000000000",
  capability: "web-search",
  callInputs: [{ query: "local test" }],
  taskSpec: {
    schemaVersion: "1.1",
    kind: "list-fill",
    topic: "local test",
    subjects: [{ label: "Item" }],
    fields: ["price"],
    sourceTrust: "user-file",
  },
  inputSalt: `0x${"22".repeat(32)}`,
  deliverable: { mimeType: "application/json", expectedKeys: ["price"] },
  budgetCap: "2000",
  targetBudget: "1000",
  evaluator: "0x0000000000000000000000000000000000000002",
  expiredAt: 1_800_000_000,
  submitBy: 1_799_990_000,
  decisionCutoff: 1_799_999_000,
  issuedAt: now.toISOString(),
});
const objects = new Map<string, Uint8Array>();
const config = loadConfig();
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const pool = getPool();
  app = createApp({
    pool,
    config,
    logger: createLogger({ service: "server", component: "CZ-15", sink: () => undefined }),
    clock: { now: () => now },
    random: { bytes: (length) => Buffer.alloc(length, 4) },
    jobDelivery: {
      pool,
      config,
      now: () => now,
      objectStore: {
        put: async (bytes) => {
          const ref = `body-${objects.size}`;
          objects.set(ref, bytes.slice());
          return ref;
        },
        delete: async (ref) => void objects.delete(ref),
      },
    },
  });
  const objective = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y");
  await seedDevice(pool);
  await pool.query(
    `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
     VALUES($1,$2,$3,$4::jsonb,$5,'received') ON CONFLICT DO NOTHING`,
    [
      objective.objectiveId,
      TEST_USER_ID,
      TEST_DEVICE_ID,
      JSON.stringify(objective),
      objective.objectiveHash,
    ],
  );
  await pool.query(
    `INSERT INTO plans(plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES($1,$2,'{}',$3,$4,'offered') ON CONFLICT DO NOTHING`,
    [PLAN_ID, objective.objectiveId, `0x${"33".repeat(32)}`, `0x${"44".repeat(32)}`],
  );
});

beforeEach(async () => {
  objects.clear();
  await getPool().query("DELETE FROM payer_job_deliverables");
  await getPool().query("DELETE FROM payer_job_briefs");
  await getPool().query(
    "INSERT INTO payer_job_briefs(job_key,plan_id,step_index,provider,brief) VALUES($1,$2,0,$3,$4::jsonb)",
    [brief.jobKey, PLAN_ID, providerAccount.address, JSON.stringify(brief)],
  );
});

describe("provider job routes", () => {
  it("returns a signed brief validated against the API contract", async () => {
    const issuedAt = BigInt(Math.floor(now.getTime() / 1000));
    const signature = await sign({
      hash: briefRequestDigest(5_042_002, { jobKey: brief.jobKey as Hash32, issuedAt }),
      privateKey: providerPrivateKey,
      to: "hex",
    });
    expect(
      validateRecordedExchange("getJobBrief", { responseStatus: 200, responseBody: brief }),
    ).toMatchObject({ valid: true });
    const response = await app.request(`/v1/jobs/${brief.jobKey}/brief`, {
      headers: {
        "X-Czar-Provider-Address": providerAccount.address,
        "X-Czar-Brief-Issued-At": issuedAt.toString(),
        "X-Czar-Brief-Signature": signature,
      },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { jobKey: string }).jobKey).toBe(brief.jobKey);
  });

  it("stores a signed octet-stream deliverable and returns its contract shape", async () => {
    const body = new TextEncoder().encode('{"price":"1.00"}');
    const contentHash = keccak256(body) as Hash32;
    const issuedAt = BigInt(Math.floor(now.getTime() / 1000));
    const signature = await sign({
      hash: deliverableUploadDigest(5_042_002, {
        jobKey: brief.jobKey as Hash32,
        contentHash,
        issuedAt,
      }),
      privateKey: providerPrivateKey,
      to: "hex",
    });
    expect(apiContracts.get("uploadJobDeliverable")?.responses.get("201")?.({ contentHash })).toBe(
      true,
    );
    await expect(
      uploadJobDeliverable(
        {
          jobKey: brief.jobKey as Hash32,
          issuedAt,
          signature,
          providerAddress: providerAccount.address,
          body,
        },
        {
          pool: getPool(),
          config,
          now: () => now,
          objectStore: { put: async () => "direct-body", delete: async () => undefined },
        },
      ),
    ).resolves.toMatchObject({ contentHash });
    await getPool().query("DELETE FROM payer_job_deliverables");
    const response = await app.request(`/v1/jobs/${brief.jobKey}/deliverables`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Czar-Provider-Address": providerAccount.address,
        "X-Czar-Upload-Issued-At": issuedAt.toString(),
        "X-Czar-Upload-Signature": signature,
      },
      body,
    });
    expect(response.status, `stored objects: ${objects.size}`).toBe(201);
    expect(await response.json()).toEqual({ contentHash });
    expect(objects.size).toBe(1);
  });
});
