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
import { keccak256, recoverAddress, type Address, type Hex } from "viem";
import {
  acquireExecutorLease,
  appendExecutionPhase,
  getExecutionTrace,
  releaseExecutorLease,
  startExecutorLeaseRenewal,
  type ExecutionPhaseRow,
} from "#src/payer/executions";

const MIN_JOB_EXPIRY_LEAD_SECONDS = 360;
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
    readonly maxBytes?: number;
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
  readonly deliverable: JobBriefInput["deliverable"];
  readonly targetBudget: string;
  readonly evaluator: Address;
  readonly envelopeExpiresAt: Date;
  readonly attempt?: number;
  readonly workerId?: string;
}

export interface JobChainView {
  readonly state:
    | "Opened"
    | "Funded"
    | "Submitted"
    | "Completed"
    | "Rejected"
    | "Expired"
    | "Released";
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
  waitForBudget(jobKey: Hash32, timeoutMs: number): Promise<bigint | undefined>;
  fundJob(input: {
    readonly jobKey: Hash32;
    readonly expectedBudget: bigint;
    readonly transaction: Hex;
  }): Promise<string>;
  syncJob(input: {
    readonly jobKey: Hash32;
    readonly transaction: Hex;
  }): Promise<{ readonly state: JobChainView["state"]; readonly txHash: string }>;
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
}

export interface JobExecutionResult {
  readonly state: JobChainView["state"];
  readonly jobKey?: Hash32;
  readonly budget?: string;
  readonly alternateProvider?: Address;
}

export interface BriefRequestInput {
  readonly jobKey: Hash32;
  readonly issuedAt: bigint;
  readonly signature: Hex;
}

export interface JobDeliverableInput extends BriefRequestInput {
  readonly body: Uint8Array;
}

export interface JobDeliveryDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly now: () => Date;
  readonly objectStore: { put(bytes: Uint8Array): Promise<string> };
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
      ...(input.deliverable.maxBytes === undefined ? {} : { maxBytes: input.deliverable.maxBytes }),
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
  const workerId = input.workerId ?? `job-${process.pid}`;
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
    if (funded !== undefined) return funded;
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
  const expiration = calculateJobExpiration(
    dependencies.now(),
    jobDurationHours(dependencies.config, input.capability),
    input.envelopeExpiresAt,
  );
  if (existing) {
    const view = await dependencies.chain.getJob(existing.jobKey);
    const recovered = { ...existing, provider, expiredAt: view.expiredAt, inputSalt };
    await persistBrief(input, dependencies, recovered);
    return recovered;
  }
  const description = buildJobDescription({
    planHash: input.planHash,
    stepIndex: input.stepIndex,
    acceptanceProfileId: input.acceptanceProfileId,
    inputs: jobInputs(input.callInputs),
    inputSalt,
  });
  const proof = proofForJobProvider(input, provider);
  const transaction = await signVaultCall(dependencies, "openJob", [
    input.envelopeId,
    input.stepIndex,
    provider,
    input.stepCap,
    proof,
    BigInt(expiration),
    description.descriptionHash,
  ]);
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
  if (view.state === "Opened" && budget === undefined) {
    const waitHours = Number(dependencies.config.get("payer.jobBudgetWaitHours"));
    await recordJobPhase(dependencies, input, attempt, "job.budget.wait", { jobKey: job.jobKey });
    budget = await dependencies.chain.waitForBudget(
      job.jobKey,
      waitHours * SECONDS_PER_HOUR * MILLISECONDS_PER_SECOND,
    );
    view = await dependencies.chain.getJob(job.jobKey);
    budget = view.budget ?? budget;
  }
  if (budget === undefined || budget <= 0n || budget > input.stepCap) {
    await cancelOrSyncJob(input, dependencies, job, attempt, assertLeaseHeld);
    return undefined;
  }
  if (view.state === "Funded" || view.state === "Submitted" || view.state === "Completed")
    return await syncAndReturn(input, dependencies, job, view, attempt, assertLeaseHeld);
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
  view = await dependencies.chain.getJob(job.jobKey);
  return await syncAndReturn(input, dependencies, job, view, attempt, assertLeaseHeld, budget);
}

async function fundAtBudget(
  input: JobExecutionInput,
  dependencies: JobExecutionDependencies,
  jobKeyValue: Hash32,
  expectedBudget: bigint,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<string> {
  const transaction = await signVaultCall(dependencies, "fundJob", [jobKeyValue, expectedBudget]);
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
  const transaction = await signVaultCall(dependencies, "cancelJob", [job.jobKey]);
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
  const transaction = await signVaultCall(dependencies, "syncJob", [job.jobKey]);
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
  const workerId = input.workerId ?? `job-refund-${process.pid}`;
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
  if (
    (view.state !== "Funded" && view.state !== "Submitted") ||
    Math.floor(dependencies.now().getTime() / 1000) < view.expiredAt
  )
    return undefined;
  const transaction = await signVaultCall(dependencies, "claimJobRefund", [input.jobKey]);
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.stepIndex,
    attempt,
    phase: "job.refund.sent",
    payload: { jobKey: input.jobKey, transaction },
  });
  assertLeaseHeld();
  const txHash = await dependencies.chain.claimJobRefund({ jobKey: input.jobKey, transaction });
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.stepIndex,
    attempt,
    phase: "job.refund.claimed",
    payload: { jobKey: input.jobKey, txHash },
  });
  const syncTransaction = await signVaultCall(dependencies, "syncJob", [input.jobKey]);
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
  return txHash;
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
    deliverable: input.deliverable,
    budgetCap: input.stepCap.toString(),
    targetBudget: input.targetBudget,
    evaluator: input.evaluator,
    expiredAt: job.expiredAt,
    submitBy: job.expiredAt - Number(dependencies.config.get("acceptance.evaluationWindowSeconds")),
    decisionCutoff:
      job.expiredAt - Number(dependencies.config.get("acceptance.decisionMarginSeconds")),
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
  assertIssuedAt(request.issuedAt, dependencies.now());
  const result = await dependencies.pool.query<{
    readonly provider: Address;
    readonly brief: JobBrief;
  }>("SELECT provider,brief FROM payer_job_briefs WHERE job_key=$1", [request.jobKey]);
  const row = result.rows[0];
  if (!row) throw new Error("ERC-8183 job brief not found.");
  const network = row.brief.network;
  const chainId = parseChainId(network);
  const digest = briefRequestDigest(chainId, {
    jobKey: request.jobKey,
    issuedAt: request.issuedAt,
  });
  const signer = await recoverAddress({ hash: digest, signature: request.signature });
  if (signer.toLowerCase() !== row.provider.toLowerCase())
    throw new Error("Job brief request signature does not match the provider.");
  if (!validateSchema("job-brief", row.brief) || row.brief.jobKey !== request.jobKey)
    throw new Error("Stored ERC-8183 brief is invalid.");
  return row.brief;
}

export async function uploadJobDeliverable(
  request: JobDeliverableInput,
  dependencies: JobDeliveryDependencies,
): Promise<{ readonly contentHash: Hash32; readonly bodyRef: string }> {
  assertIssuedAt(request.issuedAt, dependencies.now());
  const row = await dependencies.pool.query<{ readonly provider: Address }>(
    "SELECT provider FROM payer_job_briefs WHERE job_key=$1",
    [request.jobKey],
  );
  const provider = row.rows[0]?.provider;
  if (!provider) throw new Error("ERC-8183 job brief not found.");
  const contentHash = keccak256(request.body);
  const brief = await dependencies.pool.query<{ readonly brief: JobBrief }>(
    "SELECT brief FROM payer_job_briefs WHERE job_key=$1",
    [request.jobKey],
  );
  const network = brief.rows[0]?.brief.network;
  if (!network) throw new Error("ERC-8183 job brief not found.");
  const digest = deliverableUploadDigest(parseChainId(network), {
    jobKey: request.jobKey,
    contentHash,
    issuedAt: request.issuedAt,
  });
  const signer = await recoverAddress({ hash: digest, signature: request.signature });
  if (signer.toLowerCase() !== provider.toLowerCase())
    throw new Error("Deliverable upload signature does not match the provider.");
  const limit = Number(dependencies.config.get("acceptance.deliverableMaxBytes"));
  if (request.body.byteLength > limit)
    throw new RangeError("Job deliverable exceeds acceptance.deliverableMaxBytes.");
  const bodyRef = await dependencies.objectStore.put(request.body);
  await dependencies.pool.query(
    `INSERT INTO payer_job_deliverables (job_key,content_hash,body_ref,bytes)
     VALUES ($1,$2,$3,$4) ON CONFLICT (job_key,content_hash) DO NOTHING`,
    [request.jobKey, contentHash, bodyRef, request.body.byteLength],
  );
  return { contentHash, bodyRef };
}

function assertIssuedAt(issuedAt: bigint, now: Date): void {
  const nowSeconds = BigInt(Math.floor(now.getTime() / MILLISECONDS_PER_SECOND));
  if (issuedAt <= 0n || issuedAt > nowSeconds)
    throw new Error("Signed job request timestamp is invalid.");
}

function parseChainId(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error("Unsupported job network for BriefRequest authentication.");
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId))
    throw new Error("Job chain id is outside the safe integer range.");
  return chainId;
}

function calculateJobExpiration(now: Date, durationHours: number, envelopeExpiresAt: Date): number {
  const nowSeconds = Math.floor(now.getTime() / MILLISECONDS_PER_SECOND);
  const requested = nowSeconds + durationHours * SECONDS_PER_HOUR;
  const envelope = Math.floor(envelopeExpiresAt.getTime() / MILLISECONDS_PER_SECOND);
  const expiration = Math.min(requested, envelope);
  if (expiration - nowSeconds < MIN_JOB_EXPIRY_LEAD_SECONDS)
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
  const transaction = await signVaultCall(dependencies, "syncJob", [jobKeyValue]);
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
  return (
    error instanceof Error &&
    (error.message.includes("JobNotCancellable") ||
      ("code" in error && error.code === "JobNotCancellable"))
  );
}

function isBudgetChanged(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("BudgetChanged") || ("code" in error && error.code === "BudgetChanged"))
  );
}

async function signVaultCall(
  dependencies: JobExecutionDependencies,
  selector: string,
  args: readonly unknown[],
): Promise<Hex> {
  const result = await dependencies.signer.sign("cz-15", {
    keyId: "K3",
    kind: "vault-call",
    payload: { vault: dependencies.vault, selector, args },
  });
  if (!("signedTransaction" in result)) throw new Error(`K3 did not sign ${selector}.`);
  return result.signedTransaction;
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
