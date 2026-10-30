import {
  descriptionHash,
  briefRequestDigest,
  deliverableUploadDigest,
  inputCommit,
  jobKey,
  type Hash32,
} from "@czar/hashing";
import { validateSchema, type JobBrief, type TaskSpec } from "@czar/schemas";
import type { Config } from "@czar/config";
import type { Signer } from "@czar/signer";
import type { Pool } from "pg";
import { decodeErrorResult, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { randomUUID } from "node:crypto";
import { czarVaultAbi } from "@czar/vault-client";
import {
  acquireExecutorLease,
  appendExecutionPhase,
  getExecutionTrace,
  releaseExecutorLease,
  startExecutorLeaseRenewal,
  type ExecutorLeaseGuard,
  type ExecutionPhaseRow,
} from "#src/payer/executions";

const SECONDS_PER_HOUR = 60 * 60;
const MILLISECONDS_PER_SECOND = 1000;

export interface JobDescriptionInput {
  readonly planHash: string;
  readonly stepIndex: number;
  readonly acceptanceProfileId: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly inputSalt: string;
}

export interface JobDescription {
  readonly descriptionHash: Hash32;
  readonly description: string;
}

export interface JobBriefInput {
  readonly network: string;
  readonly jobEscrow: `0x${string}`;
  readonly jobId: bigint;
  readonly planHash: string;
  readonly stepIndex: number;
  readonly acceptanceProfileId: string;
  readonly capability: string;
  readonly callInputs: readonly Readonly<Record<string, string | number | boolean>>[];
  readonly taskSpec: TaskSpec;
  readonly inputSalt: string;
  readonly deliverable: {
    readonly mimeType: string;
    readonly expectedKeys?: readonly string[];
    readonly schema?: Readonly<Record<string, unknown>>;
    readonly maxBytes: number;
  };
  readonly budgetCap: string;
  readonly targetBudget: string;
  readonly evaluator: `0x${string}`;
  readonly expiredAt: number;
  readonly submitBy: number;
  readonly decisionCutoff: number;
  readonly issuedAt: string;
}

export interface JobExecutionInput {
  readonly planId: string;
  readonly envelopeRef: string;
  readonly envelopeId: bigint;
  readonly vault: Address;
  readonly stepIndex: number;
  readonly provider: Address;
  readonly alternates: readonly Address[];
  readonly stepCap: bigint;
  readonly proof: readonly Hash32[];
  readonly alternateProofsByProvider?: Readonly<Record<string, readonly Hash32[]>>;
  readonly planHash: string;
  readonly network: string;
  readonly jobEscrow: Address;
  readonly acceptanceProfileId: string;
  readonly capability: string;
  readonly callInputs: readonly Readonly<Record<string, string | number | boolean>>[];
  readonly taskSpec: TaskSpec;
  readonly deliverable: Omit<JobBriefInput["deliverable"], "maxBytes"> & {
    readonly maxBytes?: number;
  };
  readonly targetBudget: string;
  readonly evaluator: Address;
  readonly envelopeExpiresAt: Date;
  readonly attempt?: number;
  readonly workerId?: string;
  readonly dispatchLease?: ExecutorLeaseGuard;
}

export interface JobChainView {
  readonly vaultState:
    | "Opened"
    | "Funded"
    | "Submitted"
    | "Completed"
    | "Rejected"
    | "Expired"
    | "Released";
  readonly escrowState?: "Open" | "Funded" | "Submitted" | "Completed" | "Rejected" | "Expired";
  readonly budget?: bigint;
  readonly expiredAt: number;
}

export interface JobChain {
  findJob(input: {
    readonly planId: string;
    readonly stepIndex: number;
    readonly provider: Address;
  }): Promise<{ readonly jobKey: Hash32; readonly jobId: bigint } | undefined>;
  openJob(
    transaction: Hex,
  ): Promise<{ readonly jobKey: Hash32; readonly jobId: bigint; readonly txHash: string }>;
  getJob(jobKey: Hash32): Promise<JobChainView>;
  /** Resolves on a result, or once chain time reaches `expiredAt` (SCR-157 §1). */
  waitForResult(jobKey: Hash32, expiredAt: number): Promise<JobChainView>;
  /**
   * The latest block's timestamp in seconds from a fresh read. It is "now" for every job deadline the chain
   * enforces: the openJob expiry lead and the refund at `expiredAt` (SCR-157 §1).
   */
  latestBlockTimestamp(): Promise<number>;
  waitForBudget(jobKey: Hash32, timeoutMs: number): Promise<bigint | undefined>;
  fundJob(input: {
    readonly jobKey: Hash32;
    readonly expectedBudget: bigint;
    readonly transaction: Hex;
  }): Promise<string>;
  syncJob(input: {
    readonly jobKey: Hash32;
    readonly transaction: Hex;
  }): Promise<{ readonly state: JobChainView["vaultState"]; readonly txHash: string }>;
  cancelJob(input: { readonly jobKey: Hash32; readonly transaction: Hex }): Promise<string>;
  claimJobRefund(input: { readonly jobKey: Hash32; readonly transaction: Hex }): Promise<string>;
  isFrozenOrPaused(vault: Address): Promise<boolean>;
  envelopeOpen(envelopeId: bigint): Promise<boolean>;
  hasDecisionPending(jobKey: Hash32): Promise<boolean>;
}

export interface JobExecutionDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly signer: Pick<Signer, "sign">;
  readonly chain: JobChain;
  readonly now: () => Date;
  readonly randomSalt: () => Hash32;
  readonly vault: Address;
  readonly evaluator?: {
    reject(input: {
      readonly jobKey: Hash32;
      readonly escrowState: "Submitted" | "Completed";
    }): Promise<void>;
  };
}

export interface JobExecutionResult {
  readonly state: JobChainView["vaultState"];
  readonly jobKey?: Hash32;
  readonly budget?: string;
  readonly alternateProvider?: Address;
}

export interface BriefRequestInput {
  readonly jobKey: Hash32;
  readonly issuedAt: bigint;
  readonly signature: Hex;
  readonly providerAddress?: Address;
}

export interface JobDeliverableInput extends BriefRequestInput {
  readonly body: Uint8Array;
}

export interface JobDeliveryDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly now: () => Date;
  readonly publicClient: Pick<PublicClient, "verifyHash">;
  readonly objectStore: {
    put(bytes: Uint8Array): Promise<string>;
    delete(bodyRef: string): Promise<void>;
  };
}

export class JobRequestRejected extends Error {
  constructor() {
    super("Job request was not authorized.");
    this.name = "JobRequestRejected";
  }
}

export function buildJobDescription(input: JobDescriptionInput): JobDescription {
  const commit = inputCommit(input.inputs, input.inputSalt);
  const hash = descriptionHash({
    planHash: input.planHash,
    stepIndex: input.stepIndex,
    acceptanceProfileId: input.acceptanceProfileId,
    inputCommit: commit,
  });
  return {
    descriptionHash: hash,
    description: `czar:${hash.slice(2)}`,
  };
}

export function buildJobBrief(input: JobBriefInput): JobBrief {
  const callInput = input.callInputs[0];
  if (input.callInputs.length !== 1 || callInput === undefined)
    throw new Error("A Phase 1 ERC-8183 job must have exactly one rendered call input.");
  const key = jobKey(input.jobEscrow, input.jobId);
  const commit = inputCommit(callInput, input.inputSalt);
  const brief: JobBrief = {
    schemaVersion: "1.0",
    briefVersion: 2,
    network: input.network,
    jobEscrow: input.jobEscrow,
    jobId: input.jobId.toString(),
    jobKey: key,
    planHash: input.planHash,
    stepIndex: input.stepIndex,
    acceptanceProfileId: input.acceptanceProfileId,
    capability: input.capability,
    inputs: callInput,
    taskSpec: input.taskSpec,
    inputSalt: input.inputSalt,
    inputCommit: commit,
    deliverable: {
      mimeType: input.deliverable.mimeType,
      ...(input.deliverable.expectedKeys
        ? { expectedKeys: [...input.deliverable.expectedKeys] }
        : {}),
      ...(input.deliverable.schema ? { schema: input.deliverable.schema } : {}),
      delivery: "push",
      uploadRoute: "POST /v1/jobs/{jobKey}/deliverable",
      maxBytes: input.deliverable.maxBytes,
    },
    budgetCap: input.budgetCap,
    targetBudget: input.targetBudget,
    evaluator: input.evaluator,
    expiredAt: input.expiredAt,
    submitBy: input.submitBy,
    decisionCutoff: input.decisionCutoff,
    issuedAt: input.issuedAt,
    terms: {
      evaluatorIsBuyerAgent: true,
      checks: ["delivery", "structural", "requirement"],
      correctnessChecked: false,
      onBuyerFreeze: "reject-unsubmitted-hold-submitted",
    },
  };
  if (!validateSchema("job-brief", brief))
    throw new Error("Built JobBrief failed schema validation.");
  return brief;
}

export async function executeJobStep(
  input: JobExecutionInput,
  dependencies: JobExecutionDependencies,
): Promise<JobExecutionResult> {
  const attempt = input.attempt ?? 0;
  if (input.dispatchLease)
    return executeJobProviders(input, dependencies, attempt, input.dispatchLease.assertHeld);
  const workerId = input.workerId ?? `job-${process.pid}-${randomUUID()}`;
  const leaseSeconds = Number(dependencies.config.get("payer.leaseSeconds"));
  const leased = await acquireExecutorLease(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    leaseSeconds,
    dependencies.now,
  );
  if (!leased) throw new Error("Another payer executor holds the envelope lease.");
  const renewal = startExecutorLeaseRenewal(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    leaseSeconds,
    dependencies.now,
  );
  try {
    return await executeJobProviders(input, dependencies, attempt, renewal.assertHeld);
  } finally {
    await renewal.stop();
    await releaseExecutorLease(dependencies.pool, input.envelopeRef, workerId);
  }
}

async function executeJobProviders(
  input: JobExecutionInput,
  dependencies: JobExecutionDependencies,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<JobExecutionResult> {
  const providers = [input.provider, ...input.alternates];
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    if (!provider) continue;
    const opened = await openOrRecoverJob(input, dependencies, provider, attempt, assertLeaseHeld);
    const funded = await awaitAndFundJob(input, dependencies, opened, attempt, assertLeaseHeld);
    if (funded !== undefined)
      return index === 0 ? funded : { ...funded, alternateProvider: provider };
  }
  return { state: "Released" };
}

interface OpenedJob {
  readonly jobKey: Hash32;
  readonly jobId: bigint;
  readonly provider: Address;
  readonly expiredAt: number;
  readonly inputSalt: Hash32;
}

async function openOrRecoverJob(
  input: JobExecutionInput,
  dependencies: JobExecutionDependencies,
  provider: Address,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<OpenedJob> {
  const trace = await getExecutionTrace(dependencies.pool, input.planId, input.stepIndex, attempt);
  const existing = await dependencies.chain.findJob({
    planId: input.planId,
    stepIndex: input.stepIndex,
    provider,
  });
  const inputSalt = priorSalt(trace) ?? dependencies.randomSalt();
  if (existing) {
    const view = await dependencies.chain.getJob(existing.jobKey);
    const recovered = { ...existing, provider, expiredAt: view.expiredAt, inputSalt };
    await persistBrief(input, dependencies, recovered);
    return recovered;
  }
  const expiration = calculateJobExpiration(
    await dependencies.chain.latestBlockTimestamp(),
    jobDurationHours(dependencies.config, input.capability),
    input.envelopeExpiresAt,
    Number(dependencies.config.get("payer.job.minExpiryLeadSeconds")),
  );
  const description = buildJobDescription({
    planHash: input.planHash,
    stepIndex: input.stepIndex,
    acceptanceProfileId: input.acceptanceProfileId,
    inputs: jobInputs(input.callInputs),
    inputSalt,
  });
  const proof = proofForJobProvider(input, provider);
  const savedOpen = trace.findLast(
    (row) => row.phase === "job.open.sent" && row.payload["provider"] === provider,
  );
  const savedTransaction = savedOpen?.payload["transaction"];
  if (typeof savedTransaction === "string" && savedOpen) {
    const ageSeconds =
      (dependencies.now().getTime() - savedOpen.at.getTime()) / MILLISECONDS_PER_SECOND;
    const waitSeconds = Number(dependencies.config.get("payer.txWaitSeconds"));
    if (ageSeconds < waitSeconds)
      throw new Error("Stored openJob transaction is still within payer.txWaitSeconds.");
  }
  const transaction =
    typeof savedTransaction === "string"
      ? (savedTransaction as Hex)
      : await signVaultCall(dependencies, "openJob", {
          envelopeId: input.envelopeId.toString(),
          stepIndex: input.stepIndex.toString(),
          provider,
          stepCap: input.stepCap.toString(),
          proof,
          expiredAt: BigInt(expiration).toString(),
          descriptionHash: description.descriptionHash,
        });
  if (typeof savedTransaction !== "string")
    await recordJobPhase(dependencies, input, attempt, "job.open.sent", {
      provider,
      transaction,
      descriptionHash: description.descriptionHash,
      expiredAt: expiration,
      inputSalt,
    });
  assertLeaseHeld();
  const opened = await dependencies.chain.openJob(transaction);
  const job = { ...opened, provider, expiredAt: expiration, inputSalt };
  await persistBrief(input, dependencies, job);
  await recordJobPhase(dependencies, input, attempt, "job.opened", {
    jobKey: opened.jobKey,
    jobId: opened.jobId.toString(),
    provider,
    txHash: opened.txHash,
    expiredAt: expiration,
  });
  return job;
}

export function proofForJobProvider(
  input: Pick<JobExecutionInput, "provider" | "proof" | "alternateProofsByProvider">,
  provider: Address,
): readonly Hash32[] {
  if (provider.toLowerCase() === input.provider.toLowerCase()) return input.proof;
  const proof = input.alternateProofsByProvider?.[provider.toLowerCase()];
  if (!proof) throw new Error("Alternate job provider has no committed payee proof.");
  return proof;
}

async function awaitAndFundJob(
  input: JobExecutionInput,
  dependencies: JobExecutionDependencies,
  job: OpenedJob,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<JobExecutionResult | undefined> {
  let view = await dependencies.chain.getJob(job.jobKey);
  let budget = view.budget;
  if (view.vaultState === "Released") return undefined;
  if (
    view.vaultState === "Completed" ||
    view.vaultState === "Rejected" ||
    view.vaultState === "Expired"
  )
    return {
      state: view.vaultState,
      jobKey: job.jobKey,
      ...(budget === undefined ? {} : { budget: budget.toString() }),
    };
  if (
    view.vaultState === "Opened" &&
    (view.escrowState === "Submitted" || view.escrowState === "Completed")
  ) {
    if (!dependencies.evaluator)
      throw new Error("Job evaluator port is required for an escrow front-run outcome.");
    await dependencies.evaluator.reject({ jobKey: job.jobKey, escrowState: view.escrowState });
    return syncAndReturn(input, dependencies, job, view, attempt, assertLeaseHeld);
  }
  if (view.escrowState === "Expired")
    return syncAndReturn(input, dependencies, job, view, attempt, assertLeaseHeld);
  if (view.vaultState === "Opened" && budget === undefined) {
    const waitHours = Number(dependencies.config.get("payer.jobBudgetWaitHours"));
    const trace = await getExecutionTrace(
      dependencies.pool,
      input.planId,
      input.stepIndex,
      attempt,
    );
    const waiting = trace.find(
      (row) => row.phase === "job.budget.wait" && row.payload["jobKey"] === job.jobKey,
    );
    if (!waiting)
      await recordJobPhase(dependencies, input, attempt, "job.budget.wait", { jobKey: job.jobKey });
    const timeoutMs = Math.max(
      0,
      waitHours * SECONDS_PER_HOUR * MILLISECONDS_PER_SECOND -
        (waiting ? dependencies.now().getTime() - waiting.at.getTime() : 0),
    );
    budget = await dependencies.chain.waitForBudget(job.jobKey, timeoutMs);
    view = await dependencies.chain.getJob(job.jobKey);
    budget = view.budget ?? budget;
  }
  if (budget === undefined || budget <= 0n || budget > input.stepCap) {
    await cancelOrSyncJob(input, dependencies, job, attempt, assertLeaseHeld);
    return undefined;
  }
  if (
    view.escrowState === "Submitted" ||
    view.escrowState === "Completed" ||
    view.escrowState === "Rejected"
  )
    if (
      view.vaultState === "Opened" &&
      (view.escrowState === "Submitted" || view.escrowState === "Completed")
    ) {
      if (!dependencies.evaluator)
        throw new Error("Job evaluator port is required for an escrow front-run outcome.");
      await dependencies.evaluator.reject({ jobKey: job.jobKey, escrowState: view.escrowState });
    }
  if (
    view.escrowState === "Submitted" ||
    view.escrowState === "Completed" ||
    view.escrowState === "Rejected"
  )
    return await syncAndReturn(input, dependencies, job, view, attempt, assertLeaseHeld);
  if (view.vaultState === "Funded")
    return await waitForJobResult(input, dependencies, job, view, attempt, assertLeaseHeld);
  if (await dependencies.chain.isFrozenOrPaused(dependencies.vault))
    throw new Error("Cannot fund an ERC-8183 job while the vault is frozen or paused.");
  if (!(await dependencies.chain.envelopeOpen(input.envelopeId)))
    throw new Error("Cannot fund an ERC-8183 job after its envelope closes or expires.");
  let txHash: string;
  try {
    txHash = await fundAtBudget(input, dependencies, job.jobKey, budget, attempt, assertLeaseHeld);
  } catch (error) {
    if (!isBudgetChanged(error)) throw error;
    const updated = await dependencies.chain.getJob(job.jobKey);
    if (updated.budget === undefined || updated.budget <= 0n || updated.budget > input.stepCap) {
      await cancelOrSyncJob(input, dependencies, job, attempt, assertLeaseHeld);
      return undefined;
    }
    await recordJobPhase(dependencies, input, attempt, "job.budget.changed", {
      jobKey: job.jobKey,
      expectedBudget: updated.budget.toString(),
    });
    txHash = await fundAtBudget(
      input,
      dependencies,
      job.jobKey,
      updated.budget,
      attempt,
      assertLeaseHeld,
    );
    budget = updated.budget;
  }
  await recordJobPhase(dependencies, input, attempt, "job.funded", {
    jobKey: job.jobKey,
    budget: budget.toString(),
    txHash,
  });
  const fundedView = await dependencies.chain.getJob(job.jobKey);
  return await waitForJobResult(input, dependencies, job, fundedView, attempt, assertLeaseHeld);
}

async function waitForJobResult(
  input: JobExecutionInput,
  dependencies: JobExecutionDependencies,
  job: OpenedJob,
  view: JobChainView,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<JobExecutionResult> {
  const result = await dependencies.chain.waitForResult(job.jobKey, job.expiredAt);
  if (
    result.escrowState === "Submitted" ||
    result.escrowState === "Completed" ||
    result.escrowState === "Rejected" ||
    result.escrowState === "Expired"
  )
    return syncAndReturn(input, dependencies, job, result, attempt, assertLeaseHeld);
  const expired = (await dependencies.chain.latestBlockTimestamp()) >= job.expiredAt;
  if (expired && !(await dependencies.chain.hasDecisionPending(job.jobKey))) {
    const transaction =
      (await priorJobTransaction(dependencies, input, attempt, "job.refund.sent", job.jobKey)) ??
      (await signVaultCall(dependencies, "claimJobRefund", { jobKey: job.jobKey }));
    if (!(await hasJobPhase(dependencies, input, attempt, "job.refund.sent", job.jobKey)))
      await recordJobPhase(dependencies, input, attempt, "job.refund.sent", {
        jobKey: job.jobKey,
        transaction,
      });
    assertLeaseHeld();
    const txHash = await dependencies.chain.claimJobRefund({ jobKey: job.jobKey, transaction });
    await recordJobPhase(dependencies, input, attempt, "job.refund.claimed", {
      jobKey: job.jobKey,
      txHash,
    });
    await syncJob(input, dependencies, job.jobKey, attempt, assertLeaseHeld);
    const synced = await dependencies.chain.getJob(job.jobKey);
    return {
      state: synced.vaultState,
      jobKey: job.jobKey,
      ...(view.budget ? { budget: view.budget.toString() } : {}),
    };
  }
  return {
    state: result.vaultState,
    jobKey: job.jobKey,
    ...(result.budget === undefined ? {} : { budget: result.budget.toString() }),
  };
}

async function fundAtBudget(
  input: JobExecutionInput,
  dependencies: JobExecutionDependencies,
  jobKeyValue: Hash32,
  expectedBudget: bigint,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<string> {
  const transaction =
    (await priorJobTransaction(dependencies, input, attempt, "job.fund.sent", jobKeyValue)) ??
    (await signVaultCall(dependencies, "fundJob", {
      jobKey: jobKeyValue,
      expectedBudget: expectedBudget.toString(),
    }));
  if (!(await hasJobPhase(dependencies, input, attempt, "job.fund.sent", jobKeyValue)))
    await recordJobPhase(dependencies, input, attempt, "job.fund.sent", {
      jobKey: jobKeyValue,
      expectedBudget: expectedBudget.toString(),
      transaction,
    });
  assertLeaseHeld();
  return dependencies.chain.fundJob({ jobKey: jobKeyValue, expectedBudget, transaction });
}

async function cancelOrSyncJob(
  input: JobExecutionInput,
  dependencies: JobExecutionDependencies,
  job: OpenedJob,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<void> {
  const transaction =
    (await priorJobTransaction(dependencies, input, attempt, "job.cancel.sent", job.jobKey)) ??
    (await signVaultCall(dependencies, "cancelJob", { jobKey: job.jobKey }));
  if (!(await hasJobPhase(dependencies, input, attempt, "job.cancel.sent", job.jobKey)))
    await recordJobPhase(dependencies, input, attempt, "job.cancel.sent", {
      jobKey: job.jobKey,
      transaction,
    });
  assertLeaseHeld();
  try {
    const txHash = await dependencies.chain.cancelJob({ jobKey: job.jobKey, transaction });
    await recordJobPhase(dependencies, input, attempt, "job.cancelled", {
      jobKey: job.jobKey,
      txHash,
    });
  } catch (error) {
    if (!isJobNotCancellable(error)) throw error;
    await syncJob(input, dependencies, job.jobKey, attempt, assertLeaseHeld);
  }
}

async function syncAndReturn(
  input: JobExecutionInput,
  dependencies: JobExecutionDependencies,
  job: OpenedJob,
  view: JobChainView,
  attempt: number,
  assertLeaseHeld: () => void,
  budget = view.budget,
): Promise<JobExecutionResult> {
  const transaction =
    (await priorJobTransaction(dependencies, input, attempt, "job.sync.sent", job.jobKey)) ??
    (await signVaultCall(dependencies, "syncJob", { jobKey: job.jobKey }));
  if (!(await hasJobPhase(dependencies, input, attempt, "job.sync.sent", job.jobKey)))
    await recordJobPhase(dependencies, input, attempt, "job.sync.sent", {
      jobKey: job.jobKey,
      transaction,
    });
  assertLeaseHeld();
  const synced = await dependencies.chain.syncJob({ jobKey: job.jobKey, transaction });
  await recordJobPhase(dependencies, input, attempt, "job.synced", {
    jobKey: job.jobKey,
    state: synced.state,
    txHash: synced.txHash,
  });
  return {
    state: synced.state,
    jobKey: job.jobKey,
    ...(budget === undefined ? {} : { budget: budget.toString() }),
  };
}

export async function claimJobRefund(
  input: {
    readonly planId: string;
    readonly stepIndex: number;
    readonly envelopeRef: string;
    readonly attempt?: number;
    readonly workerId?: string;
    readonly jobKey: Hash32;
  },
  dependencies: JobExecutionDependencies,
): Promise<string | undefined> {
  const attempt = input.attempt ?? 0;
  const workerId = input.workerId ?? `job-refund-${process.pid}-${randomUUID()}`;
  const leaseSeconds = Number(dependencies.config.get("payer.leaseSeconds"));
  const leased = await acquireExecutorLease(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    leaseSeconds,
    dependencies.now,
  );
  if (!leased) throw new Error("Another payer executor holds the envelope lease.");
  const renewal = startExecutorLeaseRenewal(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    leaseSeconds,
    dependencies.now,
  );
  try {
    return await runJobRefund(input, dependencies, attempt, renewal.assertHeld);
  } finally {
    await renewal.stop();
    await releaseExecutorLease(dependencies.pool, input.envelopeRef, workerId);
  }
}

async function runJobRefund(
  input: {
    readonly planId: string;
    readonly stepIndex: number;
    readonly envelopeRef: string;
    readonly attempt?: number;
    readonly jobKey: Hash32;
  },
  dependencies: JobExecutionDependencies,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<string | undefined> {
  if (await dependencies.chain.hasDecisionPending(input.jobKey)) return undefined;
  const view = await dependencies.chain.getJob(input.jobKey);
  if (view.vaultState !== "Funded" && view.vaultState !== "Submitted") return undefined;
  if ((await dependencies.chain.latestBlockTimestamp()) < view.expiredAt) return undefined;
  const refundAlreadyClaimed = view.escrowState === "Expired" || view.escrowState === "Rejected";
  let txHash: string | undefined;
  if (!refundAlreadyClaimed) {
    const transaction =
      (await priorJobTransaction(dependencies, input, attempt, "job.refund.sent", input.jobKey)) ??
      (await signVaultCall(dependencies, "claimJobRefund", { jobKey: input.jobKey }));
    if (!(await hasJobPhase(dependencies, input, attempt, "job.refund.sent", input.jobKey)))
      await appendExecutionPhase(dependencies.pool, {
        planId: input.planId,
        stepIndex: input.stepIndex,
        attempt,
        phase: "job.refund.sent",
        payload: { jobKey: input.jobKey, transaction },
      });
    assertLeaseHeld();
    txHash = await dependencies.chain.claimJobRefund({ jobKey: input.jobKey, transaction });
    await appendExecutionPhase(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.stepIndex,
      attempt,
      phase: "job.refund.claimed",
      payload: { jobKey: input.jobKey, txHash },
    });
  }
  const syncTransaction =
    (await priorJobTransaction(dependencies, input, attempt, "job.sync.sent", input.jobKey)) ??
    (await signVaultCall(dependencies, "syncJob", { jobKey: input.jobKey }));
  if (!(await hasJobPhase(dependencies, input, attempt, "job.sync.sent", input.jobKey)))
    await appendExecutionPhase(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.stepIndex,
      attempt,
      phase: "job.sync.sent",
      payload: { jobKey: input.jobKey, transaction: syncTransaction },
    });
  assertLeaseHeld();
  const synced = await dependencies.chain.syncJob({
    jobKey: input.jobKey,
    transaction: syncTransaction,
  });
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.stepIndex,
    attempt,
    phase: "job.synced",
    payload: { jobKey: input.jobKey, state: synced.state, txHash: synced.txHash },
  });
  return txHash ?? synced.txHash;
}

async function persistBrief(
  input: JobExecutionInput,
  dependencies: JobExecutionDependencies,
  job: OpenedJob,
): Promise<void> {
  const brief = buildJobBrief({
    network: input.network,
    jobEscrow: input.jobEscrow,
    jobId: job.jobId,
    planHash: input.planHash,
    stepIndex: input.stepIndex,
    acceptanceProfileId: input.acceptanceProfileId,
    capability: input.capability,
    callInputs: input.callInputs,
    taskSpec: input.taskSpec,
    inputSalt: job.inputSalt,
    deliverable: {
      ...input.deliverable,
      maxBytes:
        input.deliverable.maxBytes ??
        Number(dependencies.config.get("acceptance.deliverableMaxBytes")),
    },
    budgetCap: input.stepCap.toString(),
    targetBudget: input.targetBudget,
    evaluator: input.evaluator,
    expiredAt: job.expiredAt,
    submitBy: job.expiredAt - Number(dependencies.config.get("acceptance.evaluationWindowSeconds")),
    decisionCutoff:
      job.expiredAt -
      Number(dependencies.config.get("acceptance.decisionMarginSeconds")) -
      Number(dependencies.config.get("acceptance.txMarginSeconds")),
    issuedAt: dependencies.now().toISOString(),
  });
  await dependencies.pool.query(
    `INSERT INTO payer_job_briefs (job_key,plan_id,step_index,provider,brief)
     VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (job_key) DO NOTHING`,
    [job.jobKey, input.planId, input.stepIndex, job.provider, JSON.stringify(brief)],
  );
}

export async function getJobBrief(
  request: BriefRequestInput,
  dependencies: JobDeliveryDependencies,
): Promise<JobBrief> {
  assertIssuedAt(
    request.issuedAt,
    dependencies.now(),
    Number(dependencies.config.get("api.briefSignatureMaxAgeSeconds")),
  );
  const result = await dependencies.pool.query<{
    readonly provider: Address;
    readonly brief: JobBrief;
  }>("SELECT provider,brief FROM payer_job_briefs WHERE job_key=$1", [
    request.jobKey.toLowerCase(),
  ]);
  const row = result.rows[0];
  if (!row) throw new JobRequestRejected();
  const network = row.brief.network;
  const chainId = parseChainId(network);
  const digest = briefRequestDigest(chainId, {
    jobKey: request.jobKey.toLowerCase() as Hash32,
    issuedAt: request.issuedAt,
  });
  const signerAddress = request.providerAddress ?? row.provider;
  const validSignature = await dependencies.publicClient.verifyHash({
    address: signerAddress,
    hash: digest,
    signature: request.signature,
  });
  if (!validSignature || signerAddress.toLowerCase() !== row.provider.toLowerCase())
    throw new JobRequestRejected();
  if (
    !validateSchema("job-brief", row.brief) ||
    row.brief.jobKey.toLowerCase() !== request.jobKey.toLowerCase()
  )
    throw new JobRequestRejected();
  return row.brief;
}

export async function uploadJobDeliverable(
  request: JobDeliverableInput,
  dependencies: JobDeliveryDependencies,
): Promise<{ readonly contentHash: Hash32; readonly bodyRef: string }> {
  assertIssuedAt(
    request.issuedAt,
    dependencies.now(),
    Number(dependencies.config.get("api.briefSignatureMaxAgeSeconds")),
  );
  const row = await dependencies.pool.query<{
    readonly provider: Address;
    readonly brief: JobBrief;
  }>("SELECT provider,brief FROM payer_job_briefs WHERE job_key=$1", [
    request.jobKey.toLowerCase(),
  ]);
  const brief = row.rows[0]?.brief;
  const provider = row.rows[0]?.provider;
  if (!brief || !provider) throw new JobRequestRejected();
  const contentHash = keccak256(request.body);
  const digest = deliverableUploadDigest(parseChainId(brief.network), {
    jobKey: request.jobKey.toLowerCase() as Hash32,
    contentHash,
    issuedAt: request.issuedAt,
  });
  const signerAddress = request.providerAddress ?? provider;
  const validSignature = await dependencies.publicClient.verifyHash({
    address: signerAddress,
    hash: digest,
    signature: request.signature,
  });
  if (!validSignature || signerAddress.toLowerCase() !== provider.toLowerCase())
    throw new JobRequestRejected();
  const configuredLimit = Number(dependencies.config.get("acceptance.deliverableMaxBytes"));
  const declaredLimit = brief.deliverable.maxBytes ?? configuredLimit;
  const limit = Math.min(configuredLimit, declaredLimit);
  if (request.body.byteLength > limit)
    throw new RangeError("Job deliverable exceeds acceptance.deliverableMaxBytes.");
  const bodyRef = await dependencies.objectStore.put(request.body);
  try {
    const stored = await persistDeliverableWithinLimits(
      request.jobKey.toLowerCase() as Hash32,
      contentHash,
      bodyRef,
      request.body.byteLength,
      dependencies,
    );
    if (stored.bodyRef !== bodyRef) await deleteObjectIfUnreferenced(bodyRef, dependencies);
    return { contentHash, bodyRef: stored.bodyRef };
  } catch (error) {
    await deleteObjectIfUnreferenced(bodyRef, dependencies);
    throw error;
  }
}

export async function authorizeJobDeliverableRequest(
  request: JobDeliverableInput,
  dependencies: JobDeliveryDependencies,
): Promise<void> {
  assertIssuedAt(
    request.issuedAt,
    dependencies.now(),
    Number(dependencies.config.get("api.briefSignatureMaxAgeSeconds")),
  );
  const rows = await dependencies.pool.query<{
    readonly provider: Address;
    readonly brief: JobBrief;
  }>("SELECT provider,brief FROM payer_job_briefs WHERE job_key=$1", [
    request.jobKey.toLowerCase(),
  ]);
  const row = rows.rows[0];
  if (!row) throw new JobRequestRejected();
  const hash = keccak256(request.body);
  const digest = deliverableUploadDigest(parseChainId(row.brief.network), {
    jobKey: request.jobKey.toLowerCase() as Hash32,
    contentHash: hash,
    issuedAt: request.issuedAt,
  });
  const address = request.providerAddress ?? row.provider;
  if (
    address.toLowerCase() !== row.provider.toLowerCase() ||
    !(await dependencies.publicClient.verifyHash({
      address,
      hash: digest,
      signature: request.signature,
    }))
  )
    throw new JobRequestRejected();
}

async function persistDeliverableWithinLimits(
  jobKeyValue: Hash32,
  contentHash: Hash32,
  bodyRef: string,
  bytes: number,
  dependencies: JobDeliveryDependencies,
): Promise<{ readonly bodyRef: string }> {
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT job_key FROM payer_job_briefs WHERE job_key=$1 FOR UPDATE", [
      jobKeyValue,
    ]);
    const existing = await client.query<{ readonly body_ref: string }>(
      "SELECT body_ref FROM payer_job_deliverables WHERE job_key=$1 AND content_hash=$2",
      [jobKeyValue, contentHash],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { bodyRef: existing.rows[0].body_ref };
    }
    const totals = await client.query<{ readonly count: number; readonly bytes: string }>(
      `SELECT count(*)::int AS count,COALESCE(sum(bytes),0)::text AS bytes
       FROM payer_job_deliverables WHERE job_key=$1`,
      [jobKeyValue],
    );
    const uploads = Number(dependencies.config.get("acceptance.maxUploadsPerJob"));
    const totalBytes = BigInt(totals.rows[0]?.bytes ?? "0");
    const maxBytes = BigInt(Number(dependencies.config.get("acceptance.deliverableMaxBytes"))) * 2n;
    if ((totals.rows[0]?.count ?? 0) >= uploads)
      throw new RangeError("Job exceeds acceptance.maxUploadsPerJob.");
    if (totalBytes + BigInt(bytes) > maxBytes)
      throw new RangeError("Job deliverables exceed twice acceptance.deliverableMaxBytes.");
    await client.query(
      `INSERT INTO payer_job_deliverables (job_key,content_hash,body_ref,bytes)
       VALUES ($1,$2,$3,$4)`,
      [jobKeyValue, contentHash, bodyRef, bytes],
    );
    await client.query("COMMIT");
    return { bodyRef };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function purgeUnmatchedJobDeliverables(
  input: {
    readonly jobKey: Hash32;
    readonly matchedContentHash: Hash32;
    readonly decisionAt: Date;
  },
  dependencies: JobDeliveryDependencies,
): Promise<readonly Hash32[]> {
  const retainMs =
    Number(dependencies.config.get("acceptance.uploadRetentionHours")) *
    MILLISECONDS_PER_SECOND *
    SECONDS_PER_HOUR;
  if (dependencies.now().getTime() < input.decisionAt.getTime() + retainMs) return [];
  const rows = await dependencies.pool.query<{
    readonly content_hash: Hash32;
    readonly body_ref: string;
  }>(
    `SELECT content_hash,body_ref FROM payer_job_deliverables
     WHERE job_key=$1 AND content_hash<>$2 ORDER BY uploaded_at`,
    [input.jobKey, input.matchedContentHash],
  );
  if (rows.rows.length > 0) {
    await dependencies.pool.query(
      "DELETE FROM payer_job_deliverables WHERE job_key=$1 AND content_hash<>$2",
      [input.jobKey, input.matchedContentHash],
    );
  }
  for (const row of rows.rows) await deleteObjectIfUnreferenced(row.body_ref, dependencies);
  return rows.rows.map((row) => row.content_hash);
}

function assertIssuedAt(issuedAt: bigint, now: Date, maxAgeSeconds: number): void {
  const nowSeconds = BigInt(Math.floor(now.getTime() / MILLISECONDS_PER_SECOND));
  if (issuedAt <= 0n || issuedAt > nowSeconds || nowSeconds - issuedAt > BigInt(maxAgeSeconds))
    throw new JobRequestRejected();
}

async function deleteObjectIfUnreferenced(
  bodyRef: string,
  dependencies: JobDeliveryDependencies,
): Promise<void> {
  const refs = await dependencies.pool.query(
    `SELECT 1 FROM payer_job_deliverables WHERE body_ref=$1
     UNION ALL SELECT 1 FROM acceptance_reports WHERE body_ref=$1
     UNION ALL SELECT 1 FROM evidence_receipts WHERE body_ref=$1 LIMIT 1`,
    [bodyRef],
  );
  if (refs.rowCount === 0) await dependencies.objectStore.delete(bodyRef);
}

function parseChainId(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error("Unsupported job network for BriefRequest authentication.");
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId))
    throw new Error("Job chain id is outside the safe integer range.");
  return chainId;
}

function calculateJobExpiration(
  nowSeconds: number,
  durationHours: number,
  envelopeExpiresAt: Date,
  minimumLeadSeconds: number,
): number {
  const requested = nowSeconds + durationHours * SECONDS_PER_HOUR;
  const envelope = Math.floor(envelopeExpiresAt.getTime() / MILLISECONDS_PER_SECOND);
  const expiration = Math.min(requested, envelope);
  if (expiration - nowSeconds < minimumLeadSeconds)
    throw new Error("Job expiry is below the contract's minimum lead time.");
  return expiration;
}

function jobDurationHours(config: Config, capability: string): number {
  const overrides = config.has("payer.jobDurationHoursByCapability")
    ? config.get("payer.jobDurationHoursByCapability")
    : undefined;
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    const duration = (overrides as Record<string, number>)[capability];
    if (duration !== undefined) return duration;
  }
  return Number(config.get("payer.jobDurationHours"));
}

function jobInputs(inputs: JobExecutionInput["callInputs"]): Readonly<Record<string, unknown>> {
  if (inputs.length !== 1)
    throw new Error("ERC-8183 JobBrief supports one rendered call input per job.");
  const first = inputs[0];
  if (!first) throw new Error("ERC-8183 job has no call input.");
  return first;
}

function priorSalt(trace: readonly ExecutionPhaseRow[]): Hash32 | undefined {
  const prior = trace.findLast((row) => row.phase === "job.open.sent")?.payload["inputSalt"];
  return typeof prior === "string" ? (prior as Hash32) : undefined;
}

async function syncJob(
  input: JobExecutionInput,
  dependencies: JobExecutionDependencies,
  jobKeyValue: Hash32,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<void> {
  const transaction =
    (await priorJobTransaction(dependencies, input, attempt, "job.sync.sent", jobKeyValue)) ??
    (await signVaultCall(dependencies, "syncJob", { jobKey: jobKeyValue }));
  if (!(await hasJobPhase(dependencies, input, attempt, "job.sync.sent", jobKeyValue)))
    await recordJobPhase(dependencies, input, attempt, "job.sync.sent", {
      jobKey: jobKeyValue,
      transaction,
    });
  assertLeaseHeld();
  const synced = await dependencies.chain.syncJob({ jobKey: jobKeyValue, transaction });
  await recordJobPhase(dependencies, input, attempt, "job.synced", {
    jobKey: jobKeyValue,
    state: synced.state,
    txHash: synced.txHash,
  });
}

function isJobNotCancellable(error: unknown): boolean {
  const data = errorData(error);
  if (!data) return false;
  try {
    return decodeErrorResult({ abi: czarVaultAbi, data }).errorName === "JobNotCancellable";
  } catch {
    return false;
  }
}

function isBudgetChanged(error: unknown): boolean {
  const data = errorData(error);
  if (!data) return false;
  try {
    return decodeErrorResult({ abi: czarVaultAbi, data }).errorName === "BudgetChanged";
  } catch {
    return false;
  }
}

function errorData(error: unknown): Hex | undefined {
  if (typeof error !== "object" || error === null || !("data" in error)) return undefined;
  const data = error.data;
  return typeof data === "string" && /^0x[0-9a-fA-F]+$/.test(data) ? (data as Hex) : undefined;
}

async function signVaultCall(
  dependencies: JobExecutionDependencies,
  selector: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Hex> {
  const result = await dependencies.signer.sign("cz-15", {
    keyId: "K3",
    kind: "vault-call",
    payload: { vault: dependencies.vault, selector, args },
  });
  if (!("signedTransaction" in result)) throw new Error(`K3 did not sign ${selector}.`);
  return result.signedTransaction;
}

async function priorJobTransaction(
  dependencies: JobExecutionDependencies,
  input: Pick<JobExecutionInput, "planId" | "stepIndex">,
  attempt: number,
  phase: string,
  jobKeyValue: Hash32,
): Promise<Hex | undefined> {
  const trace = await getExecutionTrace(dependencies.pool, input.planId, input.stepIndex, attempt);
  const transaction = trace.findLast(
    (row) => row.phase === phase && row.payload["jobKey"] === jobKeyValue,
  )?.payload["transaction"];
  return typeof transaction === "string" ? (transaction as Hex) : undefined;
}

async function hasJobPhase(
  dependencies: JobExecutionDependencies,
  input: Pick<JobExecutionInput, "planId" | "stepIndex">,
  attempt: number,
  phase: string,
  jobKeyValue: Hash32,
): Promise<boolean> {
  const trace = await getExecutionTrace(dependencies.pool, input.planId, input.stepIndex, attempt);
  return trace.some((row) => row.phase === phase && row.payload["jobKey"] === jobKeyValue);
}

async function recordJobPhase(
  dependencies: JobExecutionDependencies,
  input: JobExecutionInput,
  attempt: number,
  phase: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.stepIndex,
    attempt,
    phase,
    payload,
  });
}
