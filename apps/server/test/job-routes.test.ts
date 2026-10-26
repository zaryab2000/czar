import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@czar/logging";
import { validateRecordedExchange } from "@czar/api-contract";
import { apiContracts } from "@czar/api-contract";
import { briefRequestDigest, deliverableUploadDigest, type Hash32 } from "@czar/hashing";
import { buildJobBrief, uploadJobDeliverable } from "#src/payer/job";
import { createApp } from "#src/app";
import { setupDatabaseConnection } from "#test/db";
import {
  makeObjectiveSubmission,
  seedDevice,
  testAppConfig,
  TEST_DEVICE_ID,
  TEST_USER_ID,
} from "#test/fixtures";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { keccak256 } from "viem";

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
  deliverable: { mimeType: "application/json", expectedKeys: ["price"], maxBytes: 65_536 },
  budgetCap: "2000",
  targetBudget: "1000",
  evaluator: "0x0000000000000000000000000000000000000002",
  expiredAt: 1_800_000_000,
  submitBy: 1_799_990_000,
  decisionCutoff: 1_799_999_000,
  issuedAt: now.toISOString(),
});
const objects = new Map<string, Uint8Array>();
const config = testAppConfig();
const testDatabase = setupDatabaseConnection();
const getPool = testDatabase.getPool;
let app: ReturnType<typeof createApp>;
let objectDirectory: string;
const localServerOutput = new WeakMap<ChildProcess, string[]>();
const STARTUP_TIMEOUT_MS = 20_000;
const STARTUP_POLL_MS = 100;
const STOP_TIMEOUT_MS = 5_000;
const STARTUP_TEST_TIMEOUT_MS = 30_000;

beforeAll(async () => {
  const pool = getPool();
  objectDirectory = await mkdtemp(join(tmpdir(), "czar-local-job-delivery-"));
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
      publicClient: { verifyHash: async () => true } as never,
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

afterAll(async () => {
  if (objectDirectory) await rm(objectDirectory, { recursive: true, force: true });
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
  it(
    "serves briefs and persists uploads from the runnable local server",
    async () => {
      const issuedAt = BigInt(Math.floor(Date.now() / 1000));
      const signature = await sign({
        hash: briefRequestDigest(5_042_002, { jobKey: brief.jobKey as Hash32, issuedAt }),
        privateKey: providerPrivateKey,
        to: "hex",
      });
      const port = await findFreePort();
      const child = startLocalServer(port, testDatabase.getUrl(), objectDirectory);
      const baseUrl = `http://localhost:${port}`;
      try {
        await waitForServer(`${baseUrl}/`, child);
        const response = await fetch(`${baseUrl}/v1/jobs/${brief.jobKey}/brief`, {
          headers: briefHeaders(issuedAt, signature),
        });
        expect(response.status).toBe(200);
        const body = new TextEncoder().encode('{"price":"1.00"}');
        const contentHash = keccak256(body) as Hash32;
        const uploadSignature = await sign({
          hash: deliverableUploadDigest(5_042_002, {
            jobKey: brief.jobKey as Hash32,
            contentHash,
            issuedAt,
          }),
          privateKey: providerPrivateKey,
          to: "hex",
        });
        const uploaded = await fetch(`${baseUrl}/v1/jobs/${brief.jobKey}/deliverable`, {
          method: "POST",
          body: new Blob([body]),
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Czar-Provider-Address": providerAccount.address,
            "X-Czar-Upload-Issued-At": issuedAt.toString(),
            "X-Czar-Upload-Signature": uploadSignature,
          },
        });
        expect(uploaded.status).toBe(201);
        expect(await uploaded.json()).toEqual({ contentHash });
        const ref = createHash("sha256").update(body).digest("hex");
        expect(new Uint8Array(await readFile(join(objectDirectory, ref)))).toEqual(body);
      } finally {
        await stopLocalServer(child);
      }
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

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

  it("rejects a provider brief signature older than the configured maximum age", async () => {
    const maxAge = Number(config.get("api.briefSignatureMaxAgeSeconds"));
    const issuedAt = BigInt(Math.floor(now.getTime() / 1000) - maxAge - 1);
    const signature = await sign({
      hash: briefRequestDigest(5_042_002, { jobKey: brief.jobKey as Hash32, issuedAt }),
      privateKey: providerPrivateKey,
      to: "hex",
    });
    const response = await app.request(`/v1/jobs/${brief.jobKey}/brief`, {
      headers: {
        "X-Czar-Provider-Address": providerAccount.address,
        "X-Czar-Brief-Issued-At": issuedAt.toString(),
        "X-Czar-Brief-Signature": signature,
      },
    });
    expect(response.status).toBe(404);
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
          publicClient: { verifyHash: async () => true } as never,
          objectStore: { put: async () => "direct-body", delete: async () => undefined },
        },
      ),
    ).resolves.toMatchObject({ contentHash });
    await getPool().query("DELETE FROM payer_job_deliverables");
    const response = await app.request(`/v1/jobs/${brief.jobKey}/deliverable`, {
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

function briefHeaders(issuedAt: bigint, signature: string): Record<string, string> {
  return {
    "X-Czar-Provider-Address": providerAccount.address,
    "X-Czar-Brief-Issued-At": issuedAt.toString(),
    "X-Czar-Brief-Signature": signature,
  };
}

async function findFreePort(): Promise<number> {
  const socket = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port.");
  const { port } = address;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function startLocalServer(port: number, databaseUrl: string, objectPath: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/local-main.ts"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        CZAR_DATABASE_URL: databaseUrl,
        CZAR_LOCAL_OBJECT_STORE_PATH: objectPath,
        CZAR_ARC_RPC_URL: "http://127.0.0.1:1",
        CZAR_INDEXER_URL: "http://127.0.0.1:42069",
        CZAR_APP_CIRCLE_CLIENT_URL: "https://wallet.example.test",
        CZAR_APP_CIRCLE_CLIENT_KEY: "e2e-public-client-key",
        CZAR_APP_ARC_RPC_URL: "https://rpc.example.test",
        CZAR_SERVER_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  localServerOutput.set(child, output);
  return child;
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Local server exited with ${child.exitCode}: ${localServerOutput.get(child)?.join("")}`,
      );
    }
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
    }
  }
  throw new Error("Timed out waiting for the local server to start.");
}

async function stopLocalServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}
