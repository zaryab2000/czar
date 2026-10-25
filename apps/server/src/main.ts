import { randomBytes, randomUUID } from "node:crypto";
import { getLimits } from "@czar/vault-client";
import { keccak256, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { Config } from "@czar/config";
import { paymentRefHash } from "@czar/hashing";
import type { Logger } from "@czar/logging";
import type { AcceptanceReport, StepResult } from "@czar/schemas";
import type { Signer } from "@czar/signer";
import type { SafeFetch } from "@czar/x402";
import type { Pool } from "pg";
import { createAcceptanceChecker } from "#src/acceptance/index";
import type { AcceptancePorts } from "#src/acceptance/types";
import { runBoundary } from "#src/boundary/index";
import { createApp } from "#src/app";
import { createFileObjectStore, type ObjectStore } from "#src/object-store";
import type { AppReadOptions } from "#src/app/reads";
import type { Plan, SubjectsRevision } from "@czar/schemas";
import type { PairDependencies } from "#src/devices/pair";
import { migrate } from "#src/db/migrate";
import {
  createRegisteredSelection,
  type RegisteredSelection,
} from "#src/selection/registered/index";
import { createPlanner } from "#src/planner/index";
import type { PlannerPorts } from "#src/planner/ports";
import { createSafeProber } from "#src/planner/probe";
import { createPlannerOperations } from "#src/planner/service";
import { startPlannerLoop } from "#src/planner/loop";
import {
  startOpeningWatcher,
  type OpeningWatcherDependencies,
} from "#src/objectives/opening-watcher";
import {
  createPaymentReceipt,
  type PaymentReceiptInput,
  type PaymentReceiptDependencies,
} from "#src/evidence/receipts";
import { computePromptHash, type ModelClient } from "#src/models/proxy";
import {
  executeVaultDirectStep,
  type BoundaryInput,
  type SettledReceiptContext,
  type VaultDirectChain,
  type VaultDirectInput,
} from "#src/payer/vault-direct";
import { startPayerRuntime, type VaultHaltEventSource } from "#src/payer/runtime";
import type { PocketHaltDependencies } from "#src/payer/pocket";
import {
  executePocketPreparation,
  payGatewaySteps,
  refreshGatewayStatuses,
  sweepAndRetirePocketKey,
  type PocketCloseInput,
  type PocketNanopaymentDependencies,
  type PocketNanopaymentInput,
  type PocketPreparationInput,
} from "#src/payer/pocket";
import { createPocketPreparationChain } from "#src/payer/pocket-chain";
import {
  cancelExpiredPullback,
  executePullback,
  type CancelPullbackInput,
  type PullbackInput,
} from "#src/payer/pullback";
import { createPullbackExecutionChain } from "#src/payer/pullback-execution-chain";
import { executeJobStep, type JobExecutionInput } from "#src/payer/job";
import { createJobChainAdapter } from "#src/payer/job-chain-adapter";
import { createDatabaseVaultEventSource } from "#src/payer/database-vault-event-source";
import { createPullbackChainAdapter } from "#src/payer/pullback-chain-adapter";
import {
  runPendingPullbackFallbacks,
  type PullbackFallbackSchedulerDependencies,
} from "#src/payer/pullback-scheduler";

export interface ServerMainOptions extends PairDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly logger: Logger;
  readonly modelClient?: ModelClient;
  readonly createSigner: () => Promise<ServerSigner>;
  readonly acceptancePorts?: AcceptancePorts;
  readonly objects?: ObjectStore;
  readonly vaultEvents?: VaultHaltEventSource;
  readonly pocketHalt?: PocketHaltDependencies;
  readonly gatewayStatus?: PocketNanopaymentDependencies["gatewayStatus"];
  readonly pullbackFallbackChain?: PullbackFallbackSchedulerDependencies["chain"];
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly chain?: VaultDirectChain;
  readonly chainForVault?: (vault: Address) => VaultDirectChain;
  readonly safeFetch: SafeFetch;
  readonly settlement?: PaymentReceiptDependencies["settlement"];
  readonly receiptInput?: (
    context: SettledReceiptContext,
    stepResult: unknown,
    reportHashes: readonly string[],
  ) => PaymentReceiptInput;
  readonly appReadOptions: AppReadOptions;
  readonly gatewayTransferUrl?: string;
  readonly jobEvaluator?: {
    reject(input: {
      readonly jobKey: `0x${string}`;
      readonly escrowState: "Submitted" | "Completed";
    }): Promise<void>;
  };
  readonly revisePlanSubjects?: (
    userId: string,
    planId: string,
    revision: SubjectsRevision,
  ) => Promise<Plan | null>;
  readonly planner?: {
    readonly openingLookup: OpeningWatcherDependencies["lookup"];
  };
}

export type ServerSigner = Pick<Signer, "sign" | "createPocketKey" | "keyAddress"> &
  Partial<Pick<Signer, "retirePocketKey">>;

export interface ServerMain {
  readonly app: ReturnType<typeof createApp>;
  readonly acceptance: Awaited<ReturnType<typeof createAcceptanceChecker>>;
  executePayerStep(input: VaultDirectInput): ReturnType<typeof executeVaultDirectStep>;
  executePocketPreparation(
    input: PocketPreparationInput,
  ): ReturnType<typeof executePocketPreparation>;
  executePocketNanopayments(
    input: PocketNanopaymentInput,
  ): ReturnType<typeof refreshGatewayStatuses>;
  closePocket(
    input: PocketCloseInput,
    chain: Parameters<typeof sweepAndRetirePocketKey>[1]["chain"],
  ): ReturnType<typeof sweepAndRetirePocketKey>;
  executePullback(input: PullbackInput): ReturnType<typeof executePullback>;
  cancelExpiredPullback(input: CancelPullbackInput): ReturnType<typeof cancelExpiredPullback>;
  executeJobStep(input: JobExecutionInput): ReturnType<typeof executeJobStep>;
  close(): Promise<void>;
}

export async function createServerMain(options: ServerMainOptions): Promise<ServerMain> {
  await migrate(options.pool);
  const objects =
    options.objects ??
    createFileObjectStore(String(options.config.get("payer.job.deliverableStorePath")));
  const state: CompositionState = {};
  const acceptancePorts = productionAcceptancePorts(options, state);
  const acceptance = await createAcceptanceChecker({
    pool: options.pool,
    config: options.config,
    ports: acceptancePorts,
    logger: options.logger,
  });
  const boundary = createPayerBoundary(
    options,
    acceptancePorts,
    acceptance,
    await computePromptHashes(),
    objects,
  );
  const signerClient = await options.createSigner();
  state.signer = signerClient;
  const recordReceipt = createReceiptBuilder(options, signerClient);
  const selection = createSelection(options);
  state.selection = selection;
  const plannerOperations = createPlannerOperationsIfConfigured(
    options,
    acceptance,
    selection,
    signerClient,
  );
  const payerRuntime = startProductionPayerRuntime(options, signerClient);
  const payerDependencies = createPayerDependencies(
    options,
    signerClient,
    objects,
    boundary,
    recordReceipt,
  );
  const workers = startPlannerWorkers(options, plannerOperations);
  const app = createServerApp(options, objects, plannerOperations);
  return {
    app,
    acceptance,
    ...createVaultDirectOperations(options, payerDependencies),
    ...createPocketOperations(options, signerClient),
    ...createPullbackOperations(options, signerClient),
    executeJobStep: (input) => executeJobStepForMain(options, signerClient, input),
    async close() {
      await workers.stop();
      payerRuntime.stop();
    },
  };
}

interface CompositionState {
  signer?: ServerSigner;
  selection?: RegisteredSelection;
}

type PlannerOperations = ReturnType<typeof createPlannerOperations>;

function productionAcceptancePorts(
  options: ServerMainOptions,
  state: CompositionState,
): AcceptancePorts {
  return (
    options.acceptancePorts ?? {
      outputSchema: {
        forService: async (serviceId) =>
          requireSelection(state.selection).outputSchema.forService(serviceId),
      },
      shapeHistory: { forService: async () => null },
      validatorIdentity: {
        address: async () => requireSigner(state.signer).keyAddress("cz-16", "K7"),
      },
      clock: { now: options.clock.now },
    }
  );
}

async function computePromptHashes() {
  return {
    "P-01": await computePromptHash("P-01"),
    "P-02": await computePromptHash("P-02"),
  } as const;
}

function createSelection(options: ServerMainOptions): RegisteredSelection {
  return createRegisteredSelection({
    config: options.config,
    safeFetch: options.safeFetch,
    pool: options.pool,
    now: options.clock.now,
  });
}

function createPlannerOperationsIfConfigured(
  options: ServerMainOptions,
  acceptance: Awaited<ReturnType<typeof createAcceptanceChecker>>,
  selection: RegisteredSelection,
  signer: ServerSigner,
): PlannerOperations | undefined {
  if (!options.planner) return undefined;
  const planner = createPlanner({
    config: options.config,
    ports: createPlannerPorts(options, acceptance, selection, signer),
  });
  return createPlannerOperations({
    pool: options.pool,
    planner,
    ethGasPriceWei: () => options.publicClient.getGasPrice(),
    now: options.clock.now,
    random: options.random,
  });
}

function startPlannerWorkers(options: ServerMainOptions, operations?: PlannerOperations) {
  const plannerLoop = operations
    ? startPlannerLoop({
        pool: options.pool,
        config: options.config,
        processNextReceived: operations.processNextReceived,
        now: options.clock.now,
        onError: () =>
          options.logger.error("planner_loop_failure", { rule: "planner-loop", state: "error" }),
      })
    : undefined;
  const openingWatcher = options.planner
    ? startOpeningWatcher({
        pool: options.pool,
        config: options.config,
        lookup: options.planner.openingLookup,
        now: options.clock.now,
        onError: () =>
          options.logger.error("opening_watcher_failure", {
            rule: "opening-watcher",
            state: "error",
          }),
      })
    : undefined;
  return { stop: async () => Promise.all([plannerLoop?.stop(), openingWatcher?.stop()]) };
}

function createServerApp(
  options: ServerMainOptions,
  objects: ObjectStore,
  plannerOperations?: PlannerOperations,
) {
  return createApp({
    pool: options.pool,
    config: options.config,
    logger: options.logger,
    clock: options.clock,
    random: options.random,
    ...(options.modelClient ? { modelClient: options.modelClient } : {}),
    jobDelivery: {
      pool: options.pool,
      config: options.config,
      now: options.clock.now,
      publicClient: options.publicClient,
      objectStore: objects,
    },
    ...(options.appReadOptions ? { appReadOptions: options.appReadOptions } : {}),
    ...(options.revisePlanSubjects
      ? { revisePlanSubjects: options.revisePlanSubjects }
      : plannerOperations
        ? { revisePlanSubjects: plannerOperations.reviseSubjects }
        : {}),
  });
}

function createPayerDependencies(
  options: ServerMainOptions,
  signer: ServerSigner,
  objects: ObjectStore,
  boundary: ReturnType<typeof createPayerBoundary>,
  recordReceipt: ReturnType<typeof createReceiptBuilder>,
) {
  return {
    pool: options.pool,
    config: options.config,
    signer,
    safeFetch: options.safeFetch,
    now: options.clock.now,
    objects,
    boundary,
    recordReceipt,
  };
}

function startProductionPayerRuntime(options: ServerMainOptions, signer: ServerSigner) {
  const vaultEvents =
    options.vaultEvents ??
    (options.pocketHalt ? createDatabaseVaultEventSource(options) : undefined);
  if (!options.vaultEvents && !options.pocketHalt)
    options.logger.error("payer_halt_monitor_disabled", {
      rule: "missing_pocket_halt_dependencies",
      state: "disabled",
    });
  const fallbackChain =
    options.pullbackFallbackChain ??
    createPullbackChainAdapter(
      options.publicClient,
      options.walletClient,
      options.config.get("chain.gatewayWalletAddress") as Address,
      { config: options.config, logger: options.logger },
    );
  return startPayerRuntime({
    ...(vaultEvents ? { events: vaultEvents } : {}),
    ...(options.pocketHalt ? { pocketHalt: options.pocketHalt } : {}),
    fallbackPollSeconds: Number(options.config.get("payer.pullbackFallbackPollSeconds")),
    runFallbacks: () => runPullbackFallbacks(options, signer, fallbackChain),
    onError: (operation) =>
      options.logger.error("payer_runtime_failure", { rule: operation, state: "error" }),
  });
}

async function runPullbackFallbacks(
  options: ServerMainOptions,
  signer: ServerSigner,
  fallbackChain: PullbackFallbackSchedulerDependencies["chain"],
) {
  return runPendingPullbackFallbacks({
    pool: options.pool,
    config: options.config,
    signer,
    cancelPendingPullback: (input) => cancelFallbackPullback(options, signer, input),
    chain: fallbackChain,
    now: options.clock.now,
  });
}

async function cancelFallbackPullback(
  options: ServerMainOptions,
  signer: ServerSigner,
  input: CancelPullbackInput,
) {
  const chain = createPullbackExecutionChain({
    client: options.publicClient,
    pool: options.pool,
    vault: input.vault,
    gatewayMinter: input.gatewayMinter,
  });
  const record = await chain.readPullback(input.pullbackId);
  if (!record || record.state === "Confirmed")
    throw new Error("Gateway pullback is not cancellable before slow withdrawal.");
  if (record.state === "Cancelled") return;
  return cancelExpiredPullback(input, {
    pool: options.pool,
    config: options.config,
    signer,
    chain,
    safeFetch: options.safeFetch,
    gatewayTransferUrl: options.gatewayTransferUrl ?? "",
    now: options.clock.now,
  });
}

function createVaultDirectOperations(
  options: ServerMainOptions,
  payerDependencies: ReturnType<typeof createPayerDependencies>,
) {
  return {
    executePayerStep(input: VaultDirectInput) {
      const chain = options.chainForVault?.(input.vault) ?? options.chain;
      if (!chain) throw new Error("Vault-direct chain adapter is not configured.");
      return executeVaultDirectStep(input, { ...payerDependencies, chain });
    },
  };
}

function createPocketOperations(options: ServerMainOptions, signer: ServerSigner) {
  return {
    executePocketPreparation(input: PocketPreparationInput) {
      return executePocketPreparation(input, {
        pool: options.pool,
        config: options.config,
        signer,
        chain: createPocketPreparationChain({
          client: options.publicClient,
          vault: input.vault,
          usdc: options.config.get("chain.usdcAddress") as Address,
          gatewayWallet: options.config.get("chain.gatewayWalletAddress") as Address,
        }),
        now: options.clock.now,
      });
    },
    async executePocketNanopayments(input: PocketNanopaymentInput) {
      if (!options.gatewayStatus)
        throw new Error("Gateway status lookup is required to execute pocket payments.");
      const dependencies: PocketNanopaymentDependencies = {
        pool: options.pool,
        config: options.config,
        signer,
        safeFetch: options.safeFetch,
        now: options.clock.now,
        gatewayStatus: options.gatewayStatus,
      };
      await payGatewaySteps(input, dependencies);
      return refreshGatewayStatuses(input, dependencies);
    },
    closePocket(
      input: PocketCloseInput,
      chain: Parameters<typeof sweepAndRetirePocketKey>[1]["chain"],
    ) {
      if (!signer.retirePocketKey)
        throw new Error("The configured signer client does not expose pocket-key retirement.");
      return sweepAndRetirePocketKey(input, {
        pool: options.pool,
        signer: {
          sign: signer.sign.bind(signer),
          retirePocketKey: signer.retirePocketKey.bind(signer),
        },
        chain,
      });
    },
  };
}

function createPullbackOperations(options: ServerMainOptions, signer: ServerSigner) {
  return {
    executePullback(input: PullbackInput) {
      if (!options.gatewayTransferUrl)
        throw new Error("Gateway transfer URL is required for pullback execution.");
      return executePullback(input, {
        pool: options.pool,
        config: options.config,
        signer,
        chain: createPullbackExecutionChain({
          client: options.publicClient,
          pool: options.pool,
          vault: input.vault,
          gatewayMinter: input.gatewayMinter,
        }),
        safeFetch: options.safeFetch,
        gatewayTransferUrl: options.gatewayTransferUrl,
        now: options.clock.now,
      });
    },
    cancelExpiredPullback(input: CancelPullbackInput) {
      return cancelExpiredPullback(input, {
        pool: options.pool,
        config: options.config,
        signer,
        chain: createPullbackExecutionChain({
          client: options.publicClient,
          pool: options.pool,
          vault: input.vault,
          gatewayMinter: input.gatewayMinter,
        }),
        safeFetch: options.safeFetch,
        gatewayTransferUrl: options.gatewayTransferUrl ?? "",
        now: options.clock.now,
      });
    },
  };
}

function executeJobStepForMain(
  options: ServerMainOptions,
  signer: ServerSigner,
  input: JobExecutionInput,
) {
  return executeJobStep(input, {
    pool: options.pool,
    config: options.config,
    signer,
    chain: createJobChainAdapter({
      client: options.publicClient,
      pool: options.pool,
      config: options.config,
      vault: input.vault,
      jobEscrow: input.jobEscrow,
      usdc: options.config.get("chain.usdcAddress") as Address,
      now: options.clock.now,
    }),
    vault: input.vault,
    now: options.clock.now,
    randomSalt: () => `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
    ...(options.jobEvaluator ? { evaluator: options.jobEvaluator } : {}),
  });
}

function createPayerBoundary(
  options: ServerMainOptions,
  acceptancePorts: AcceptancePorts,
  acceptance: Awaited<ReturnType<typeof createAcceptanceChecker>>,
  promptHashes: Readonly<Record<"P-01" | "P-02", string>>,
  objects: ObjectStore,
) {
  return async (context: BoundaryInput): Promise<unknown> => {
    const { input, response, paymentRef } = context;
    const serviceId = "serviceId" in input.step ? input.step.serviceId : undefined;
    if (!serviceId) throw new Error("Paid step has no serviceId for acceptance checks.");
    const payTo = paymentRef["payTo"];
    if (typeof payTo !== "string") throw new TypeError("x402 PaymentRef is missing payTo.");
    const bodyText = new TextDecoder().decode(response.body);
    const origin = new URL(response.url).origin;
    const mimeType = header(response.headers, "content-type") ?? "application/octet-stream";
    const bodyCommit = keccak256(response.body);
    const source = {
      origin,
      payTo,
      paymentRefHash: paymentRefHash(paymentRef),
    };
    const profileId = input.step.acceptanceProfileId;
    const outputSchema = await acceptancePorts.outputSchema.forService(serviceId);
    const result = await runBoundary(
      {
        body: bodyText,
        statusCode: response.status,
        mimeType,
        stepIndex: input.step.stepIndex,
        source,
        bodyRef: context.bodyRef,
        bodyCommit,
        expectedKeys: input.step.inputTemplate?.expectedKeys ?? [],
        ...(outputSchema ? { outputSchema } : {}),
        elapsedMs: Math.max(0, options.clock.now().getTime() - context.requestedAt.getTime()),
        origin,
        payTo,
        userId: input.userId,
        deviceId: input.deviceId,
        idempotencyKey: randomUUID(),
        now: options.clock.now(),
        acceptance: {
          obsId: `obs_${options.random.bytes(16).toString("hex")}`,
          profileId,
          envelopeRef: input.envelopeRef,
          stepIndex: input.step.stepIndex,
          serviceId,
          step: input.step,
          maxTimeoutSeconds: context.maxTimeoutSeconds,
        },
      },
      {
        pool: options.pool,
        config: options.config,
        logger: options.logger,
        ...(options.modelClient ? { modelClient: options.modelClient } : {}),
        promptHashes,
        objectStore: objects,
        acceptance,
      },
    );
    return (
      result.result ?? quarantinedStepResult(context, source, bodyCommit, result.acceptance.report)
    );
  };
}

function createReceiptBuilder(options: ServerMainOptions, signer: Pick<Signer, "sign">) {
  return async (context: SettledReceiptContext): Promise<void> => {
    if (!options.settlement || !options.receiptInput)
      throw new Error("Receipt settlement and trace adapters are not configured (TA-09).");
    const reports = await options.pool.query<{ report_hash: string }>(
      `SELECT report_hash FROM acceptance_reports
       WHERE envelope_ref=$1 AND step_index=$2 AND body_ref=$3
       ORDER BY created_at DESC LIMIT 1`,
      [context.input.envelopeRef, context.input.step.stepIndex, context.bodyRef],
    );
    const input = options.receiptInput(
      context,
      context.stepResult,
      reports.rows.map((row) => row.report_hash),
    );
    await createPaymentReceipt(input, {
      pool: options.pool,
      config: options.config,
      signer,
      settlement: options.settlement,
      now: options.clock.now,
    });
  };
}

function createPlannerPorts(
  options: ServerMainOptions,
  acceptance: Awaited<ReturnType<typeof createAcceptanceChecker>>,
  selection: RegisteredSelection,
  signer: ServerSigner,
): PlannerPorts {
  const periodLengthSeconds = BigInt(
    Number(options.config.get("signer.projection.periodLengthSeconds")),
  );
  return {
    ranking: selection.rank,
    directory: selection.directory,
    profiles: createPlannerProfileSource(acceptance),
    pocketKeys: createPlannerPocketKeySource(signer),
    agentHosts: { hasAgentHost: async () => false },
    allowance: {
      async remaining(userId, categoryId) {
        try {
          const result = await options.pool.query<{ vault: string | null }>(
            "SELECT vault FROM users WHERE user_id=$1",
            [userId],
          );
          const vault = result.rows[0]?.vault;
          if (!vault) return "0";
          const limits = await getLimits({
            client: options.publicClient,
            vault: vault as Address,
            categoryId: categoryId as Hex,
          });
          const periodId = BigInt(options.clock.now().getTime()) / 1000n / periodLengthSeconds;
          const used = limits.periodId === periodId ? limits.usedInPeriod : 0n;
          return (limits.autoLimit > used ? limits.autoLimit - used : 0n).toString();
        } catch {
          return "0";
        }
      },
    },
    prober: createSafeProber(options.config),
  };
}

export function createPlannerProfileSource(
  acceptance: Pick<Awaited<ReturnType<typeof createAcceptanceChecker>>, "profileIdFor">,
): PlannerPorts["profiles"] {
  return {
    profileIdFor(taskClass) {
      if (taskClass === "data-json.search" || taskClass === "data-json.extract")
        return acceptance.profileIdFor("data-json");
      if (taskClass === "local") throw new LocalTemplateProfileUnavailableError();
      return acceptance.profileIdFor(taskClass);
    },
  };
}

export class LocalTemplateProfileUnavailableError extends Error {
  constructor() {
    super("The local-template-v1 profile ID must be supplied by the CZ-11 assembler.");
    this.name = "LocalTemplateProfileUnavailableError";
  }
}

export function createPlannerPocketKeySource(
  signer: Pick<ServerSigner, "createPocketKey">,
): PlannerPorts["pocketKeys"] {
  return { createPocketKey: (_planId) => signer.createPocketKey("cz-15") };
}

function requireSelection(selection: RegisteredSelection | undefined): RegisteredSelection {
  if (!selection) throw new Error("Registered selection is not initialized.");
  return selection;
}

function requireSigner(signer: ServerSigner | undefined): ServerSigner {
  if (!signer) throw new Error("Signer client is not initialized.");
  return signer;
}

function quarantinedStepResult(
  context: BoundaryInput,
  source: StepResult["source"],
  bodyCommit: string,
  report: AcceptanceReport,
): StepResult {
  return {
    schemaVersion: "1.0",
    stepIndex: context.input.step.stepIndex,
    status: "unknown",
    source,
    fields: [],
    flags: report.flags?.includes("injection-quarantined") ? ["injection-suspect"] : [],
    bodyRef: context.bodyRef,
    bodyCommit,
  };
}

function header(headers: Readonly<Record<string, string>>, key: string): string | undefined {
  const normalized = key.toLowerCase();
  const match = Object.keys(headers).find((candidate) => candidate.toLowerCase() === normalized);
  return match === undefined ? undefined : headers[match];
}
