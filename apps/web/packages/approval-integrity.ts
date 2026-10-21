import {
  buildTree,
  callInputsHash,
  categoryHash,
  PAYEE_KIND,
  payeeLeaf,
  pocketLeaf,
  planHash,
  taskSpecHash,
} from "@czar/hashing";
import type { ApprovalIntent, AppPlan } from "@czar/schemas";
import { encodeOpenEnvelope } from "@czar/vault-client";

export const PLAN_MISMATCH_MESSAGE = "Something changed in this plan. Please reload.";

function recomputePlanHash(plan: AppPlan): string {
  if (!plan.taskSpec) throw new Error(PLAN_MISMATCH_MESSAGE);
  return planHash({
    planId: plan.planId,
    objectiveHash: plan.objectiveHash,
    network: plan.network,
    category: plan.category,
    cap: plan.cap,
    slackBps: plan.slackBps,
    maxStepAmount: plan.maxStepAmount,
    pocketCapBps: plan.pocketCapBps,
    expiresAt: plan.expiresAt,
    payeeRoot: plan.payeeRoot,
    taskSpecHash: taskSpecHash(plan.taskSpec),
    steps: plan.steps.map((step) => ({
      stepIndex: step.stepIndex,
      kind: step.kind,
      ...(step.payee ? { payee: step.payee } : {}),
      ...(step.alternates ? { alternates: step.alternates } : {}),
      unitAmount: step.unitAmount,
      expectedCalls: step.expectedCalls,
      stepCap: step.stepCap,
      acceptanceProfileId: step.acceptanceProfileId,
      ...(step.serviceId ? { serviceId: step.serviceId } : {}),
      ...(step.fanOut ? { fanOut: step.fanOut } : {}),
      ...(step.callInputs ? { callInputsHash: callInputsHash(step.callInputs) } : {}),
    })),
  });
}

/** Verifies the displayed plan and payees against the server intent before wallet signing. */
export function assertApprovalIntent(
  plan: AppPlan,
  intent: ApprovalIntent,
  now = Date.now(),
): void {
  try {
    assertIntentMatchesPlan(plan, intent, now);
  } catch {
    throw new Error(PLAN_MISMATCH_MESSAGE);
  }
}

function assertIntentMatchesPlan(plan: AppPlan, intent: ApprovalIntent, now: number): void {
  const displayedRoot = displayedPayeeRoot(plan);
  const displayedPlanHash = recomputePlanHash(plan);
  const displayedExpiry = Math.floor(Date.parse(plan.expiresAt) / 1000);
  const expectedChainId = Number(plan.network.split(":")[1]);
  if (
    !Number.isFinite(Date.parse(intent.expiresAt)) ||
    Date.parse(intent.expiresAt) <= now ||
    displayedExpiry <= Math.floor(now / 1000) ||
    !Number.isSafeInteger(expectedChainId) ||
    intent.chainId !== expectedChainId ||
    intent.planId !== plan.planId ||
    intent.planHash.toLowerCase() !== displayedPlanHash.toLowerCase() ||
    plan.planHash.toLowerCase() !== displayedPlanHash.toLowerCase() ||
    intent.objectiveHash.toLowerCase() !== plan.objectiveHash.toLowerCase() ||
    intent.payeeRoot.toLowerCase() !== displayedRoot.toLowerCase() ||
    plan.payeeRoot.toLowerCase() !== displayedRoot.toLowerCase() ||
    intent.decoded.planHash.toLowerCase() !== displayedPlanHash.toLowerCase() ||
    intent.decoded.objectiveHash.toLowerCase() !== plan.objectiveHash.toLowerCase() ||
    intent.decoded.payeeRoot.toLowerCase() !== displayedRoot.toLowerCase() ||
    intent.decoded.categoryId.toLowerCase() !== categoryHash(plan.category).toLowerCase() ||
    intent.decoded.cap !== plan.cap ||
    intent.decoded.maxStepAmount !== plan.maxStepAmount ||
    intent.decoded.pocketCapBps !== plan.pocketCapBps ||
    intent.decoded.expiresAt !== displayedExpiry ||
    intent.to.toLowerCase() !== intent.vault.toLowerCase() ||
    intent.value !== "0"
  ) {
    throw new Error(PLAN_MISMATCH_MESSAGE);
  }
  assertCalldata(intent);
}

function assertCalldata(intent: ApprovalIntent): void {
  const calldata = encodeOpenEnvelope({
    cap: BigInt(intent.decoded.cap),
    maxStepAmount: BigInt(intent.decoded.maxStepAmount),
    pocketCapBps: intent.decoded.pocketCapBps,
    expiresAt: BigInt(intent.decoded.expiresAt),
    categoryId: intent.decoded.categoryId,
    objectiveHash: intent.decoded.objectiveHash,
    planHash: intent.decoded.planHash,
    payeeRoot: intent.decoded.payeeRoot,
  });
  if (calldata !== intent.calldata) throw new Error(PLAN_MISMATCH_MESSAGE);
}

function displayedPayeeRoot(plan: AppPlan): string {
  const shownLeaves = plan.steps.flatMap((step) => {
    const kind = payeeKind(step.kind);
    if (kind === undefined) return [];
    const payees = [step.payee, ...(step.alternates ?? [])].filter(
      (payee): payee is string => payee !== undefined,
    );
    return payees.map((payee) =>
      payeeLeaf(payee as `0x${string}`, kind, step.stepIndex, BigInt(step.stepCap)),
    );
  });
  if (plan.pocket) shownLeaves.push(pocketLeaf(plan.pocket as `0x${string}`));
  const planLeaves = plan.payeeLeaves.map((leaf) =>
    payeeLeaf(leaf.payee as `0x${string}`, leaf.kind, leaf.stepIndex, BigInt(leaf.stepCap)),
  );
  const shownTree = buildTree(shownLeaves);
  const planTree = buildTree(planLeaves);
  if (
    shownLeaves.length !== planLeaves.length ||
    shownTree.leaves.some((leaf, index) => leaf !== planTree.leaves[index])
  ) {
    throw new Error(PLAN_MISMATCH_MESSAGE);
  }
  return shownTree.root;
}

function payeeKind(kind: AppPlan["steps"][number]["kind"]): number | undefined {
  switch (kind) {
    case "x402-exact":
    case "gateway-nano":
      return PAYEE_KIND.X402_PAY_TO;
    case "erc8183-job":
      return PAYEE_KIND.ERC8183_PROVIDER;
    case "tip":
      return PAYEE_KIND.TIP_REPO;
    case "local":
    case "agent-assist":
      return undefined;
  }
}
