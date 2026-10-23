import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deliverableUploadDigest,
  descriptionHash,
  inputCommit,
  jobKey,
  type Hash32,
} from "@czar/hashing";
import {
  buildJobBrief,
  buildJobDescription,
  claimJobRefund,
  executeJobStep,
  proofForJobProvider,
  purgeUnmatchedJobDeliverables,
  uploadJobDeliverable,
} from "#src/payer/job";
import type { TaskSpec } from "@czar/schemas";
import { validateSchema } from "@czar/schemas";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";
import { loadConfig } from "@czar/config";
import type { SignRequest } from "@czar/signer";
import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";

const getPool = setupDatabase();
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const expiredJobNow = () => new Date("2026-10-22T00:00:00.000Z");
const taskSpec: TaskSpec = {
  schemaVersion: "1.1",
  kind: "list-fill",
  topic: "Look up price",
  subjects: [{ label: "Item" }],
  fields: ["price"],
  sourceTrust: "user-file",
};

beforeAll(async () => {
  await seedDevice(getPool());
  const submission = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y");
  await getPool().query(
    `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state)
     VALUES ($1,$2,$3,$4::jsonb,$5,'received') ON CONFLICT (objective_id) DO NOTHING`,
    [
      submission.objectiveId,
      TEST_USER_ID,
      submission.deviceId,
      JSON.stringify(submission),
      submission.objectiveHash,
    ],
  );
  await getPool().query(
    `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES ($1,$2,'{}',$3,$4,'offered') ON CONFLICT (plan_id) DO NOTHING`,
    [PLAN_ID, submission.objectiveId, `0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`],
  );
});

beforeEach(async () => {
  await getPool().query("DELETE FROM payer_job_deliverables");
  await getPool().query("DELETE FROM payer_job_briefs");
  await getPool().query("DELETE FROM step_executions");
  await getPool().query("DELETE FROM steps WHERE plan_id=$1", [PLAN_ID]);
  await getPool().query(
    "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,'{}','queued')",
    [PLAN_ID],
  );
});

describe("job brief commitments", () => {
  it("requires each alternate job provider to have its own approved leaf proof", () => {
    const primary = "0x0000000000000000000000000000000000000003";
    const alternate = "0x0000000000000000000000000000000000000004";
    const primaryProof = [`0x${"11".repeat(32)}` as const];
    const alternateProof = [`0x${"22".repeat(32)}` as const];
    const input = {
      provider: primary,
      proof: primaryProof,
      alternateProofsByProvider: { [alternate]: alternateProof },
    } as const;
    expect(proofForJobProvider(input, primary)).toBe(primaryProof);
    expect(proofForJobProvider(input, alternate)).toBe(alternateProof);
    expect(() =>
      proofForJobProvider({ provider: primary, proof: primaryProof }, alternate),
    ).toThrow("Alternate job provider has no committed payee proof.");
  });

  it("derives the description hash from the input commit and prefixes it for ERC-8183", () => {
    const input = {
      planHash: `0x${"11".repeat(32)}`,
      stepIndex: 2,
      provider: "0x0000000000000000000000000000000000000003" as const,
      acceptanceProfileId: "prof_00000000000000000000000000000000",
      inputs: { subject: "Ada" },
      inputSalt: `0x${"22".repeat(32)}`,
    };
    const actual = buildJobDescription(input);
    const commit = inputCommit(input.inputs, input.inputSalt);
    const expectedHash = descriptionHash({ ...input, inputCommit: commit });
    expect(actual).toEqual({
      descriptionHash: expectedHash,
      description: `czar:${expectedHash.slice(2)}`,
    });
  });

  it("builds a schema-valid v2 brief from the single planned call input", () => {
    const brief = buildJobBrief({
      network: "eip155:5042002",
      jobEscrow: "0x0000000000000000000000000000000000000001",
      jobId: 1n,
      planHash: `0x${"11".repeat(32)}`,
      stepIndex: 0,
      acceptanceProfileId: "prof_00000000000000000000000000000000",
      capability: "web-search",
      callInputs: [{ query: "Item price" }],
      taskSpec,
      inputSalt: `0x${"22".repeat(32)}`,
      deliverable: { mimeType: "application/json", expectedKeys: ["price"], maxBytes: 65_536 },
      budgetCap: "2000",
      targetBudget: "1000",
      evaluator: "0x0000000000000000000000000000000000000002",
      expiredAt: 1_800_000_000,
      submitBy: 1_799_990_000,
      decisionCutoff: 1_799_999_000,
      issuedAt: "2026-10-22T00:00:00.000Z",
    });
    expect(brief.jobKey).toBe(jobKey("0x0000000000000000000000000000000000000001", 1n));
    expect(brief.inputs).toEqual({ query: "Item price" });
    expect(brief.inputCommit).toBe(inputCommit(brief.inputs, brief.inputSalt));
    expect(validateSchema("job-brief", brief)).toBe(true);
  });

  it("job_deliverables_enforce_upload_count_limit", async () => {
    const privateKey = generatePrivateKey();
    const provider = privateKeyToAccount(privateKey).address;
    const currentTime = new Date("2026-10-22T00:00:00Z");
    const issuedAt = BigInt(Math.floor(currentTime.getTime() / 1000));
    const brief = buildJobBrief({
      network: "eip155:5042002",
      jobEscrow: "0x0000000000000000000000000000000000000001",
      jobId: 1n,
      planHash: `0x${"11".repeat(32)}`,
      stepIndex: 0,
      acceptanceProfileId: "prof_00000000000000000000000000000000",
      capability: "web-search",
      callInputs: [{ query: "Item price" }],
      taskSpec,
      inputSalt: `0x${"22".repeat(32)}`,
      deliverable: { mimeType: "application/json", expectedKeys: ["price"], maxBytes: 65_536 },
      budgetCap: "2000",
      targetBudget: "1000",
      evaluator: "0x0000000000000000000000000000000000000002",
      expiredAt: 1_800_000_000,
      submitBy: 1_799_990_000,
      decisionCutoff: 1_799_999_000,
      issuedAt: currentTime.toISOString(),
    });
    const jobKeyHash = brief.jobKey as Hash32;
    await getPool().query(
      "INSERT INTO payer_job_briefs (job_key,plan_id,step_index,provider,brief) VALUES ($1,$2,0,$3,$4::jsonb)",
      [brief.jobKey, PLAN_ID, provider, JSON.stringify(brief)],
    );
    const objects = new Map<string, Uint8Array>();
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      now: () => currentTime,
      publicClient: { verifyHash: async () => true } as never,
      objectStore: {
        put: vi.fn(async (body: Uint8Array) => {
          const ref = `body-${objects.size + 1}`;
          objects.set(ref, body.slice());
          return ref;
        }),
        delete: vi.fn(async (ref: string) => {
          objects.delete(ref);
        }),
      },
    };
    const upload = async (body: Uint8Array) => {
      const contentHash = keccak256(body) as Hash32;
      const signature = await sign({
        hash: deliverableUploadDigest(5042002, { jobKey: jobKeyHash, contentHash, issuedAt }),
        privateKey,
        to: "hex",
      });
      return uploadJobDeliverable({ jobKey: jobKeyHash, issuedAt, signature, body }, dependencies);
    };
    const uploads: { readonly contentHash: Hash32; readonly bodyRef: string }[] = [];
    for (let index = 0; index < 10; index += 1)
      uploads.push(await upload(new TextEncoder().encode(`deliverable-${index}`)));
    await expect(upload(new TextEncoder().encode("eleventh-deliverable"))).rejects.toThrow(
      "Job exceeds acceptance.maxUploadsPerJob.",
    );
    const matched = uploads[0];
    if (!matched) throw new Error("First deliverable fixture was not uploaded.");
    await expect(upload(new TextEncoder().encode("deliverable-0"))).resolves.toEqual(matched);
    const shared = uploads[1];
    if (!shared) throw new Error("Second deliverable fixture was not uploaded.");
    const sharedJob = `0x${"ab".repeat(32)}`;
    await getPool().query(
      "INSERT INTO payer_job_briefs (job_key,plan_id,step_index,provider,brief) VALUES ($1,$2,1,$3,$4::jsonb)",
      [sharedJob, PLAN_ID, provider, JSON.stringify({ ...brief, jobKey: sharedJob })],
    );
    await getPool().query(
      "INSERT INTO payer_job_deliverables (job_key,content_hash,body_ref,bytes) VALUES ($1,$2,$3,1)",
      [sharedJob, `0x${"ab".repeat(32)}`, shared.bodyRef],
    );
    await expect(
      purgeUnmatchedJobDeliverables(
        {
          jobKey: jobKeyHash,
          matchedContentHash: matched.contentHash,
          decisionAt: new Date("2026-10-20T00:00:00Z"),
        },
        dependencies,
      ),
    ).resolves.toHaveLength(9);
    const remaining = await getPool().query(
      "SELECT content_hash FROM payer_job_deliverables WHERE job_key=$1",
      [brief.jobKey],
    );
    expect(remaining.rows).toEqual([{ content_hash: matched.contentHash }]);
    expect(objects.has(shared.bodyRef)).toBe(true);
  });

  it("opens, waits for the provider budget and funds without premature sync", async () => {
    const chain = {
      findJob: vi.fn(async () => undefined),
      openJob: vi.fn(async () => ({
        jobKey: jobKey("0x0000000000000000000000000000000000000003", 1n),
        jobId: 1n,
        txHash: "open-tx",
      })),
      getJob: vi.fn(async () => ({
        vaultState: "Opened" as const,
        escrowState: "Open" as const,
        expiredAt: 1_700_000_000,
      })),
      waitForResult: vi.fn(async () => ({
        vaultState: "Funded" as const,
        escrowState: "Funded" as const,
        budget: 1_000n,
        expiredAt: 1_700_000_000,
      })),
      waitForBudget: vi.fn(async () => 1_000n),
      fundJob: vi.fn(async () => "fund-tx"),
      syncJob: vi.fn(async () => ({ state: "Funded" as const, txHash: "sync-tx" })),
      cancelJob: vi.fn(async () => "cancel-tx"),
      claimJobRefund: vi.fn(async () => "refund-tx"),
      isFrozenOrPaused: vi.fn(async () => false),
      envelopeOpen: vi.fn(async () => true),
      hasDecisionPending: vi.fn(async () => false),
    };
    const signer = {
      sign: vi.fn(async () => ({ signedTransaction: "0x1234" as const })),
    };
    const result = await executeJobStep(
      {
        planId: PLAN_ID,
        envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
        envelopeId: 1n,
        vault: "0x0000000000000000000000000000000000000001" as const,
        stepIndex: 0,
        provider: "0x0000000000000000000000000000000000000003",
        alternates: [],
        stepCap: 2_000n,
        proof: [],
        planHash: `0x${"11".repeat(32)}`,
        network: "eip155:5042002",
        jobEscrow: "0x0000000000000000000000000000000000000003" as const,
        acceptanceProfileId: "prof_00000000000000000000000000000000",
        capability: "web-search",
        callInputs: [{ query: "Item price" }],
        taskSpec,
        deliverable: { mimeType: "application/json", expectedKeys: ["price"] },
        targetBudget: "1000",
        evaluator: "0x0000000000000000000000000000000000000002" as const,
        envelopeExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      },
      {
        pool: getPool(),
        config: loadConfig(),
        signer,
        chain,
        vault: "0x0000000000000000000000000000000000000001" as const,
        now: () => new Date("2026-10-22T00:00:00.000Z"),
        randomSalt: () => `0x${"22".repeat(32)}`,
      },
    );
    expect(result).toMatchObject({ state: "Funded", budget: "1000" });
    expect(chain.syncJob).not.toHaveBeenCalled();
    expect(chain.fundJob).toHaveBeenCalledWith(expect.objectContaining({ expectedBudget: 1_000n }));
    expect(chain.waitForBudget).toHaveBeenCalledWith(expect.any(String), 2 * 60 * 60 * 1000);
    const storedBrief = await getPool().query<{ brief: { decisionCutoff: number } }>(
      "SELECT brief FROM payer_job_briefs WHERE plan_id=$1 AND step_index=0",
      [PLAN_ID],
    );
    const nowSeconds = Math.floor(new Date("2026-10-22T00:00:00.000Z").getTime() / 1000);
    const expectedCutoff = nowSeconds + 24 * 60 * 60 - 900 - 300;
    expect(storedBrief.rows[0]?.brief.decisionCutoff).toBe(expectedCutoff);
  });

  it("rejects and syncs an escrow front-run while the vault is still Opened", async () => {
    const job = jobKey("0x0000000000000000000000000000000000000003", 1n);
    const chain = {
      findJob: vi.fn(async () => ({ jobKey: job, jobId: 1n })),
      openJob: vi.fn(),
      getJob: vi.fn(async () => ({
        vaultState: "Opened" as const,
        escrowState: "Submitted" as const,
        expiredAt: 1_800_000_000,
      })),
      waitForResult: vi.fn(),
      waitForBudget: vi.fn(),
      fundJob: vi.fn(),
      syncJob: vi.fn(async () => ({ state: "Rejected" as const, txHash: "sync-tx" })),
      cancelJob: vi.fn(),
      claimJobRefund: vi.fn(),
      isFrozenOrPaused: vi.fn(),
      envelopeOpen: vi.fn(),
      hasDecisionPending: vi.fn(),
    };
    const evaluator = { reject: vi.fn(async () => undefined) };

    const result = await executeJobStep(
      {
        planId: PLAN_ID,
        envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
        envelopeId: 1n,
        vault: "0x0000000000000000000000000000000000000001" as const,
        stepIndex: 0,
        provider: "0x0000000000000000000000000000000000000003" as const,
        alternates: [],
        stepCap: 2_000n,
        proof: [],
        planHash: `0x${"11".repeat(32)}`,
        network: "eip155:5042002",
        jobEscrow: "0x0000000000000000000000000000000000000003" as const,
        acceptanceProfileId: "prof_00000000000000000000000000000000",
        capability: "web-search",
        callInputs: [{ query: "Item price" }],
        taskSpec,
        deliverable: { mimeType: "application/json", expectedKeys: ["price"] },
        targetBudget: "1000",
        evaluator: "0x0000000000000000000000000000000000000002" as const,
        envelopeExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      },
      {
        pool: getPool(),
        config: loadConfig(),
        signer: { sign: vi.fn(async () => ({ signedTransaction: "0x1234" as const })) },
        chain,
        vault: "0x0000000000000000000000000000000000000001" as const,
        now: () => new Date("2026-10-22T00:00:00.000Z"),
        randomSalt: () => `0x${"22".repeat(32)}`,
        evaluator,
      },
    );

    expect(result.state).toBe("Rejected");
    expect(evaluator.reject).toHaveBeenCalledWith({ jobKey: job, escrowState: "Submitted" });
    expect(chain.waitForBudget).not.toHaveBeenCalled();
    expect(chain.fundJob).not.toHaveBeenCalled();
    expect(chain.syncJob).toHaveBeenCalledOnce();
  });

  it("claims and syncs an expired funded job when no decision is pending", async () => {
    const job = jobKey("0x0000000000000000000000000000000000000003", 1n);
    let refunded = false;
    const chain = {
      findJob: vi.fn(async () => ({ jobKey: job, jobId: 1n })),
      openJob: vi.fn(),
      getJob: vi.fn(async () => ({
        vaultState: refunded ? ("Expired" as const) : ("Funded" as const),
        escrowState: "Funded" as const,
        budget: 1_000n,
        expiredAt: 1_700_000_000,
      })),
      waitForResult: vi.fn(async () => ({
        vaultState: "Funded" as const,
        escrowState: "Funded" as const,
        budget: 1_000n,
        expiredAt: 1_700_000_000,
      })),
      waitForBudget: vi.fn(),
      fundJob: vi.fn(),
      syncJob: vi.fn(async () => ({ state: "Expired" as const, txHash: "sync-tx" })),
      cancelJob: vi.fn(),
      claimJobRefund: vi.fn(async () => {
        refunded = true;
        return "refund-tx";
      }),
      isFrozenOrPaused: vi.fn(),
      envelopeOpen: vi.fn(),
      hasDecisionPending: vi.fn(async () => false),
    };
    const result = await executeJobStep(
      {
        planId: PLAN_ID,
        envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
        envelopeId: 1n,
        vault: "0x0000000000000000000000000000000000000001" as const,
        stepIndex: 0,
        provider: "0x0000000000000000000000000000000000000003" as const,
        alternates: [],
        stepCap: 2_000n,
        proof: [],
        planHash: `0x${"11".repeat(32)}`,
        network: "eip155:5042002",
        jobEscrow: "0x0000000000000000000000000000000000000003" as const,
        acceptanceProfileId: "prof_00000000000000000000000000000000",
        capability: "web-search",
        callInputs: [{ query: "Item price" }],
        taskSpec,
        deliverable: { mimeType: "application/json", expectedKeys: ["price"] },
        targetBudget: "1000",
        evaluator: "0x0000000000000000000000000000000000000002" as const,
        envelopeExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      },
      {
        pool: getPool(),
        config: loadConfig(),
        signer: { sign: vi.fn(async () => ({ signedTransaction: "0x1234" as const })) },
        chain,
        vault: "0x0000000000000000000000000000000000000001" as const,
        now: expiredJobNow,
        randomSalt: () => `0x${"22".repeat(32)}`,
      },
    );

    expect(chain.waitForResult).toHaveBeenCalledWith(job, 1_700_000_000);
    expect(result.state).toBe("Expired");
    expect(chain.claimJobRefund).toHaveBeenCalledOnce();
    expect(chain.syncJob).toHaveBeenCalledOnce();
  });

  it("cancels a provider that misses the budget deadline and opens the approved alternate", async () => {
    const provider = "0x0000000000000000000000000000000000000003" as const;
    const alternate = "0x0000000000000000000000000000000000000004" as const;
    const jobIds = new Map<string, bigint>();
    let currentProvider: string = provider;
    let currentJob = 0n;
    let waitCount = 0;
    let budget: bigint | undefined;
    let state: "Opened" | "Funded" | "Released" = "Opened";
    const chain = {
      findJob: vi.fn(async (input: { provider: string }) => {
        const jobId = jobIds.get(input.provider.toLowerCase());
        return jobId === undefined
          ? undefined
          : { jobKey: jobKey("0x0000000000000000000000000000000000000003", jobId), jobId };
      }),
      openJob: vi.fn(async () => {
        currentJob += 1n;
        jobIds.set(currentProvider.toLowerCase(), currentJob);
        budget = undefined;
        state = "Opened";
        return {
          jobKey: jobKey("0x0000000000000000000000000000000000000003", currentJob),
          jobId: currentJob,
          txHash: "open-tx",
        };
      }),
      getJob: vi.fn(async () => ({
        vaultState: state,
        escrowState: state === "Funded" ? ("Funded" as const) : ("Open" as const),
        expiredAt: 1_800_000_000,
        ...(budget ? { budget } : {}),
      })),
      waitForResult: vi.fn(async () => ({
        vaultState: state,
        escrowState: state === "Funded" ? ("Funded" as const) : ("Open" as const),
        expiredAt: 1_800_000_000,
        ...(budget ? { budget } : {}),
      })),
      waitForBudget: vi.fn(async () => {
        waitCount += 1;
        if (waitCount === 1) return undefined;
        budget = 1_000n;
        return budget;
      }),
      fundJob: vi.fn(async () => {
        state = "Funded";
        return "fund-tx";
      }),
      syncJob: vi.fn(async () => ({ state, txHash: "sync-tx" })),
      cancelJob: vi.fn(async () => "cancel-tx"),
      claimJobRefund: vi.fn(async () => "refund-tx"),
      isFrozenOrPaused: vi.fn(async () => false),
      envelopeOpen: vi.fn(async () => true),
      hasDecisionPending: vi.fn(async () => false),
    };
    const signer = {
      sign: vi.fn(async (_caller: string, request: SignRequest) => {
        const payload = request.payload as Record<string, unknown>;
        if (payload["selector"] === "openJob") {
          currentProvider = (payload["args"] as { provider: string }).provider;
        }
        return { signedTransaction: "0x1234" as const };
      }),
    };
    const result = await executeJobStep(
      {
        planId: PLAN_ID,
        envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
        envelopeId: 1n,
        vault: "0x0000000000000000000000000000000000000001" as const,
        stepIndex: 0,
        provider,
        alternates: [alternate],
        stepCap: 2_000n,
        proof: [`0x${"11".repeat(32)}`],
        alternateProofsByProvider: { [alternate]: [`0x${"22".repeat(32)}`] },
        planHash: `0x${"11".repeat(32)}`,
        network: "eip155:5042002",
        jobEscrow: "0x0000000000000000000000000000000000000003",
        acceptanceProfileId: "prof_00000000000000000000000000000000",
        capability: "web-search",
        callInputs: [{ query: "Item price" }],
        taskSpec,
        deliverable: { mimeType: "application/json", expectedKeys: ["price"] },
        targetBudget: "1000",
        evaluator: "0x0000000000000000000000000000000000000002",
        envelopeExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      },
      {
        pool: getPool(),
        config: loadConfig(),
        signer,
        chain,
        vault: "0x0000000000000000000000000000000000000001" as const,
        now: () => new Date("2026-10-22T00:00:00.000Z"),
        randomSalt: () => `0x${"22".repeat(32)}`,
      },
    );
    expect(result).toMatchObject({ state: "Funded", alternateProvider: alternate });
    expect(chain.cancelJob).toHaveBeenCalledOnce();
    expect(chain.fundJob).toHaveBeenCalledOnce();
  });

  it("job_killResume_matrix_rereadsChainStateWithoutOpeningOrFundingTwice", async () => {
    const phases = ["open", "budget-wait", "fund", "submit", "sync"] as const;
    for (const failAt of phases) {
      await getPool().query("DELETE FROM step_executions");
      let exists = failAt === "submit" || failAt === "sync";
      let state: "Opened" | "Funded" | "Submitted" =
        failAt === "submit" || failAt === "sync" ? "Submitted" : "Opened";
      let budget: bigint | undefined = state === "Submitted" ? 1_000n : undefined;
      let failed = false;
      const currentJobKey = jobKey("0x0000000000000000000000000000000000000003", 1n);
      const chain = {
        findJob: vi.fn(async () => (exists ? { jobKey: currentJobKey, jobId: 1n } : undefined)),
        openJob: vi.fn(async () => {
          exists = true;
          if (failAt === "open" && !failed) {
            failed = true;
            throw new Error("executor stopped after openJob mined");
          }
          return { jobKey: currentJobKey, jobId: 1n, txHash: "open-tx" };
        }),
        getJob: vi.fn(async () => ({
          vaultState: state,
          escrowState:
            state === "Funded"
              ? ("Funded" as const)
              : state === "Submitted"
                ? ("Submitted" as const)
                : ("Open" as const),
          expiredAt: 1_800_000_000,
          ...(budget ? { budget } : {}),
        })),
        waitForResult: vi.fn(async () => ({
          vaultState: state,
          escrowState:
            state === "Funded"
              ? ("Funded" as const)
              : state === "Submitted"
                ? ("Submitted" as const)
                : ("Open" as const),
          expiredAt: 1_800_000_000,
          ...(budget ? { budget } : {}),
        })),
        waitForBudget: vi.fn(async () => {
          budget = 1_000n;
          if (failAt === "budget-wait" && !failed) {
            failed = true;
            throw new Error("executor stopped after budget was set");
          }
          return budget;
        }),
        fundJob: vi.fn(async () => {
          state = "Funded";
          if (failAt === "fund" && !failed) {
            failed = true;
            throw new Error("executor stopped after fundJob mined");
          }
          return "fund-tx";
        }),
        syncJob: vi.fn(async () => {
          if (failAt === "sync" && !failed) {
            failed = true;
            throw new Error("executor stopped after syncJob mined");
          }
          return { state, txHash: "sync-tx" };
        }),
        cancelJob: vi.fn(async () => "cancel-tx"),
        claimJobRefund: vi.fn(async () => "refund-tx"),
        isFrozenOrPaused: vi.fn(async () => false),
        envelopeOpen: vi.fn(async () => true),
        hasDecisionPending: vi.fn(async () => false),
      };
      const input = {
        planId: PLAN_ID,
        envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
        envelopeId: 1n,
        vault: "0x0000000000000000000000000000000000000001" as const,
        stepIndex: 0,
        provider: "0x0000000000000000000000000000000000000003" as const,
        alternates: [],
        stepCap: 2_000n,
        proof: [],
        planHash: `0x${"11".repeat(32)}`,
        network: "eip155:5042002",
        jobEscrow: "0x0000000000000000000000000000000000000003" as const,
        acceptanceProfileId: "prof_00000000000000000000000000000000",
        capability: "web-search",
        callInputs: [{ query: "Item price" }],
        taskSpec,
        deliverable: { mimeType: "application/json", expectedKeys: ["price"] },
        targetBudget: "1000",
        evaluator: "0x0000000000000000000000000000000000000002" as const,
        envelopeExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      };
      const dependencies = {
        pool: getPool(),
        config: loadConfig(),
        signer: { sign: vi.fn(async () => ({ signedTransaction: "0x1234" as const })) },
        chain,
        vault: "0x0000000000000000000000000000000000000001" as const,
        now: () => new Date("2026-10-22T00:00:00.000Z"),
        randomSalt: () => `0x${"22".repeat(32)}` as const,
      };
      if (failAt !== "submit")
        await expect(executeJobStep(input, dependencies)).rejects.toThrow("executor stopped");
      const result = await executeJobStep(input, dependencies);
      expect(result.state).toBe(failAt === "submit" || failAt === "sync" ? "Submitted" : "Funded");
      expect(chain.openJob).toHaveBeenCalledTimes(
        failAt === "open" ? 1 : failAt === "submit" || failAt === "sync" ? 0 : 1,
      );
      expect(chain.fundJob).toHaveBeenCalledTimes(
        failAt === "fund" ? 1 : failAt === "submit" || failAt === "sync" ? 0 : 1,
      );
    }
  });

  it("never claims a refund while an evaluator decision is pending", async () => {
    const claim = vi.fn();
    const signer = { sign: vi.fn() };
    const chain = {
      hasDecisionPending: vi.fn(async () => true),
      getJob: vi.fn(),
      claimJobRefund: claim,
      syncJob: vi.fn(),
    };
    await expect(
      claimJobRefund(
        {
          planId: PLAN_ID,
          stepIndex: 0,
          envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
          jobKey: `0x${"11".repeat(32)}`,
        },
        {
          pool: getPool(),
          config: loadConfig(),
          chain,
          signer,
          vault: "0x0000000000000000000000000000000000000001",
          now: () => new Date("2026-10-22T00:00:00Z"),
        } as never,
      ),
    ).resolves.toBeUndefined();
    expect(claim).not.toHaveBeenCalled();
    expect(signer.sign).not.toHaveBeenCalled();
  });
});
