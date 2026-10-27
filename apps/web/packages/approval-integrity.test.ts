import { buildTree, categoryHash, payeeLeaf, planHash, taskSpecHash } from "@czar/hashing";
import type { AppPlan, ApprovalIntent } from "@czar/schemas";
import { encodeOpenEnvelope } from "@czar/vault-client";
import { describe, expect, it } from "vitest";
import { assertApprovalIntent, PLAN_MISMATCH_MESSAGE } from "#src/approval-integrity";

const addresses = [
  "0x0000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000002",
  "0x0000000000000000000000000000000000000003",
  "0x0000000000000000000000000000000000000004",
] as const;

function fixture(): { plan: AppPlan; intent: ApprovalIntent; extraRoot: `0x${string}` } {
  const leaves = addresses.slice(0, 3).map((payee, stepIndex) => ({
    payee,
    kind: 1 as const,
    stepIndex,
    stepCap: "1000000",
  }));
  const planRoot = buildTree(
    leaves.map((leaf) => payeeLeaf(leaf.payee, leaf.kind, leaf.stepIndex, BigInt(leaf.stepCap))),
  ).root;
  const taskSpec = {
    schemaVersion: "1.1" as const,
    kind: "list-fill" as const,
    topic: "services",
    subjects: [],
    fields: [],
    sourceTrust: "user-prompt" as const,
  };
  const planBase = {
    schemaVersion: "1.2" as const,
    planId: "pln_01J00000000000000000000000",
    objectiveId: "obj_01J00000000000000000000000",
    objectiveHash: `0x${"1".repeat(64)}`,
    network: "eip155:5042002",
    category: "research",
    cap: "3000000",
    slackBps: 0,
    maxStepAmount: "1000000",
    pocketCapBps: 0,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    steps: leaves.map((leaf, stepIndex) => ({
      stepIndex,
      stepId: `step-${stepIndex}`,
      kind: "x402-exact" as const,
      capability: "web-search",
      payee: leaf.payee,
      unitAmount: leaf.stepCap,
      expectedCalls: 1,
      stepCap: leaf.stepCap,
      routingReason: "vault-direct",
      acceptanceProfileId: "basic",
      resource: { url: `https://merchant-${stepIndex}.example/search`, method: "GET" as const },
    })),
    payeeLeaves: leaves,
    payeeRoot: planRoot,
    shadow: false,
    createdAt: "2026-10-21T00:00:00Z",
    taskSpec,
  };
  const computedPlanHash = planHash({
    planId: planBase.planId,
    objectiveHash: planBase.objectiveHash,
    network: planBase.network,
    category: planBase.category,
    cap: planBase.cap,
    slackBps: planBase.slackBps,
    maxStepAmount: planBase.maxStepAmount,
    pocketCapBps: planBase.pocketCapBps,
    expiresAt: planBase.expiresAt,
    payeeRoot: planRoot,
    taskSpecHash: taskSpecHash(taskSpec),
    steps: planBase.steps.map((step) => ({
      stepIndex: step.stepIndex,
      kind: step.kind,
      payee: step.payee,
      unitAmount: step.unitAmount,
      expectedCalls: step.expectedCalls,
      stepCap: step.stepCap,
      acceptanceProfileId: step.acceptanceProfileId,
    })),
  });
  const plan: AppPlan = { ...planBase, planHash: computedPlanHash };
  const extraRoot = buildTree([
    ...leaves.map((leaf) => payeeLeaf(leaf.payee, leaf.kind, leaf.stepIndex, BigInt(leaf.stepCap))),
    payeeLeaf(addresses[3], 1, 3, 1_000_000n),
  ]).root;
  const vault = "0x00000000000000000000000000000000000000aa";
  const decoded = {
    cap: plan.cap,
    maxStepAmount: plan.maxStepAmount,
    pocketCapBps: plan.pocketCapBps,
    expiresAt: Math.floor(Date.parse(plan.expiresAt) / 1000),
    categoryId: categoryHash(plan.category),
    objectiveHash: plan.objectiveHash as `0x${string}`,
    planHash: computedPlanHash,
    payeeRoot: extraRoot,
  };
  const intent: ApprovalIntent = {
    planId: plan.planId,
    planHash: computedPlanHash,
    objectiveHash: plan.objectiveHash,
    payeeRoot: extraRoot,
    vault,
    to: vault,
    calldata: encodeOpenEnvelope({
      cap: BigInt(decoded.cap),
      maxStepAmount: BigInt(decoded.maxStepAmount),
      pocketCapBps: decoded.pocketCapBps,
      expiresAt: BigInt(decoded.expiresAt),
      categoryId: decoded.categoryId,
      objectiveHash: decoded.objectiveHash,
      planHash: decoded.planHash,
      payeeRoot: decoded.payeeRoot,
    }),
    value: "0",
    chainId: 5042002,
    decoded,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
  return { plan, intent, extraRoot };
}

describe("approval intent integrity", () => {
  it("accepts the exact displayed payees and openEnvelope calldata", () => {
    const { plan, intent } = fixture();
    const validRoot = buildTree(
      plan.payeeLeaves.map((leaf) =>
        payeeLeaf(leaf.payee as `0x${string}`, leaf.kind, leaf.stepIndex, BigInt(leaf.stepCap)),
      ),
    ).root;
    const decoded = { ...intent.decoded, payeeRoot: validRoot };
    const acceptedIntent = {
      ...intent,
      payeeRoot: validRoot,
      decoded,
      calldata: encodeOpenEnvelope({
        cap: BigInt(decoded.cap),
        maxStepAmount: BigInt(decoded.maxStepAmount),
        pocketCapBps: decoded.pocketCapBps,
        expiresAt: BigInt(decoded.expiresAt),
        categoryId: decoded.categoryId,
        objectiveHash: decoded.objectiveHash,
        planHash: decoded.planHash,
        payeeRoot: decoded.payeeRoot,
      }),
    };
    expect(() => assertApprovalIntent(plan, acceptedIntent)).not.toThrow();
  });

  it("refuses calldata that commits a fourth payee absent from the displayed plan", () => {
    const { plan, intent, extraRoot } = fixture();
    expect(intent.decoded.payeeRoot).toBe(extraRoot);
    expect(plan.payeeLeaves).toHaveLength(3);
    expect(() => assertApprovalIntent(plan, intent)).toThrow(PLAN_MISMATCH_MESSAGE);
  });

  it("refuses the previous plan hash after the displayed subjects change", () => {
    const { plan, intent } = fixture();
    const taskSpec = plan.taskSpec;
    if (!taskSpec) throw new Error("fixture requires TaskSpec");
    const editedPlan: AppPlan = {
      ...plan,
      taskSpec: {
        ...taskSpec,
        subjects: [{ label: "Edited subject" }],
        editedByUser: true,
      },
    };
    expect(() => assertApprovalIntent(editedPlan, intent)).toThrow(PLAN_MISMATCH_MESSAGE);
  });
});
