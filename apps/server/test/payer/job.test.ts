import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { descriptionHash, inputCommit, jobKey } from "@czar/hashing";
import {
  buildJobBrief,
  buildJobDescription,
  claimJobRefund,
  executeJobStep,
  proofForJobProvider,
} from "#src/payer/job";
import type { TaskSpec } from "@czar/schemas";
import { validateSchema } from "@czar/schemas";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";
import { loadConfig } from "@czar/config";

const getPool = setupDatabase();
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
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
      deliverable: { mimeType: "application/json", expectedKeys: ["price"] },
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

  it("opens, waits for the provider budget, funds the observed amount and syncs", async () => {
    const chain = {
      findJob: vi.fn(async () => undefined),
      openJob: vi.fn(async () => ({
        jobKey: jobKey("0x0000000000000000000000000000000000000003", 1n),
        jobId: 1n,
        txHash: "open-tx",
      })),
      getJob: vi.fn(async () => ({ state: "Opened" as const, expiredAt: 1_800_000_000 })),
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
        stepIndex: 0,
        provider: "0x0000000000000000000000000000000000000003",
        alternates: [],
        stepCap: 2_000n,
        proof: [],
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
        vault: "0x0000000000000000000000000000000000000001",
        now: () => new Date("2026-10-22T00:00:00.000Z"),
        randomSalt: () => `0x${"22".repeat(32)}`,
      },
    );
    expect(result).toMatchObject({ state: "Funded", budget: "1000" });
    expect(chain.fundJob).toHaveBeenCalledWith(expect.objectContaining({ expectedBudget: 1_000n }));
    expect(chain.waitForBudget).toHaveBeenCalledWith(expect.any(String), 2 * 60 * 60 * 1000);
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
