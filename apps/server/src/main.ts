import { randomBytes, randomUUID } from "node:crypto";
import { czarVaultAbi, czarVaultFactoryAbi, getLimits } from "@czar/vault-client";
import {
  decodeEventLog,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { Config } from "@czar/config";
import {
  PAYEE_KIND,
  buildTree,
  payeeLeaf,
  paymentRefHash,
  verifyProof,
  type Hash32,
} from "@czar/hashing";
import type { Logger } from "@czar/logging";
import type { AcceptanceReport, StepError, StepResult } from "@czar/schemas";
import type { Signer } from "@czar/signer";
import type { SafeFetch } from "@czar/x402";
import type { Pool } from "pg";
import { createAcceptanceChecker } from "#src/acceptance/index";
import { localTemplateProfile } from "#src/acceptance/profile";
import type { AcceptancePorts } from "#src/acceptance/types";
import { runBoundary } from "#src/boundary/index";
import { createApp } from "#src/app";
import { createFileObjectStore, type ObjectStore } from "#src/object-store";
import type { AppReadOptions } from "#src/app/reads";
import type { Plan, SubjectsRevision, TaskSpec } from "@czar/schemas";
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
import { createReceiptInputFromTrace } from "#src/evidence/receipt-input";
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
import { createViemVaultDirectChain } from "#src/payer/viem-chain";
import {
  cancelExpiredPullback,
  executePullback,
  writeOffOverdueManualReturn,
  type CancelPullbackInput,
  type PullbackInput,
} from "#src/payer/pullback";
import { createPullbackExecutionChain } from "#src/payer/pullback-execution-chain";
import { executeJobStep, type JobExecutionInput } from "#src/payer/job";
import { createJobChainAdapter } from "#src/payer/job-chain-adapter";
import { createDatabaseVaultEventSource } from "#src/payer/database-vault-event-source";
import { createPullbackChainAdapter } from "#src/payer/pullback-chain-adapter";
import { createIndexerPocketReader } from "#src/payer/indexer-pocket";
import {
  createPocketRecoveryOperations,
  type PocketRecoveryOperations,
} from "#src/payer/pocket-recovery";
import {
  runManualReturnRecovery,
  runPendingPullbackFallbacks,
  type ManualReturnReceiptPosition,
  type ManualReturnRow,
  type ManualReturnWriteOffCandidate,
  type PullbackFallbackSchedulerDependencies,
} from "#src/payer/pullback-scheduler";
import { startPayerDispatcher, type DispatchStepRequest } from "#src/payer/dispatcher";
import { completeObjective } from "#src/objectives/completion";
import { appendExecutionPhase, getExecutionTrace, markStepFailed } from "#src/payer/executions";
import {
  createIndexerGatewayStatus,
  createIndexerSettlement,
  verifyX402Transfer,
} from "#src/evidence/indexer-settlement";

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
  readonly gatewayMinter?: Address;
  readonly gatewayDomain?: number;
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

// ICzarVault.PocketState: None, Registered, Funded, Draining, Closed.
const POCKET_STATE_CLOSED = 4n;
const usdcTransferAbi = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

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
  const pocketRecovery = createDefaultPocketRecovery(options, signerClient);
  const payerRuntime = startProductionPayerRuntime(options, signerClient, pocketRecovery);
  const payerDependencies = createPayerDependencies(
    options,
    signerClient,
    objects,
    boundary,
    recordReceipt,
  );
  const workers = startPlannerWorkers(options, plannerOperations);
  const dispatcher = startPayerDispatcher({
    pool: options.pool,
    config: options.config,
    now: options.clock.now,
    isFrozen: (vault) => readVaultPauseState(options, vault),
    isGuardianPaused: (vault) => readGuardianPauseState(options, vault),
    runStep: (input) =>
      runDispatchedStep(options, signerClient, payerDependencies, selection, input),
    complete: (input) =>
      completeObjective(
        { ...input, envelopeId: parseEnvelopeId(input.envelopeRef, input.vault) },
        {
          pool: options.pool,
          config: options.config,
          signer: signerClient,
          chain: completionChain(options),
          now: options.clock.now,
          random: options.random,
        },
      ).then(() => undefined),
    onError: () =>
      options.logger.error("payer_dispatch_failure", {
        rule: "payer-dispatcher",
        state: "error",
      }),
  });
  const app = createServerApp(options, objects, plannerOperations);
  return {
    app,
    acceptance,
    ...createVaultDirectOperations(options, payerDependencies),
    ...createPocketOperations(options, signerClient, pocketRecovery),
    ...createPullbackOperations(options, signerClient),
    executeJobStep: (input) => executeJobStepForMain(options, signerClient, input),
    async close() {
      await workers.stop();
      await dispatcher.stop();
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

function createDefaultPocketRecovery(
  options: ServerMainOptions,
  signer: ServerSigner,
): PocketRecoveryOperations | undefined {
  if (options.gatewayDomain === undefined || !options.gatewayMinter) return undefined;
  return createPocketRecoveryOperations({
    pool: options.pool,
    config: options.config,
    logger: options.logger,
    signer,
    publicClient: options.publicClient,
    walletClient: options.walletClient,
    safeFetch: options.safeFetch,
    indexerUrl: options.appReadOptions.indexerUrl,
    gatewayMinter: options.gatewayMinter,
    gatewayDomain: options.gatewayDomain,
    ...(options.gatewayTransferUrl === undefined
      ? {}
      : { gatewayTransferUrl: options.gatewayTransferUrl }),
    now: options.clock.now,
  });
}

function startProductionPayerRuntime(
  options: ServerMainOptions,
  signer: ServerSigner,
  pocketRecovery?: PocketRecoveryOperations,
) {
  const pocketHalt = options.pocketHalt ?? pocketRecovery?.halt;
  const vaultEvents = options.vaultEvents ?? createDatabaseVaultEventSource(options);
  if (!pocketHalt)
    options.logger.error("payer_halt_monitor_disabled", {
      rule: "missing_gateway_deployment_context",
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
  const pocketReader = createIndexerPocketReader(
    options.appReadOptions.indexerUrl,
    Number(options.config.get("fetch.timeoutMs")),
  );
  const runRecoveryPass = async () => {
    await pocketRecovery?.runClosedPocketRecovery();
    await runManualReturnRecovery({
      pool: options.pool,
      config: options.config,
      manualReturnsForVault: (vault) => pocketReader.manualReturnsForVault(vault),
      recoverReturnPosition: (row) => recoverManualReturnPosition(options, row),
      isPocketClosed: async (vault, pocket) => {
        const record = await options.publicClient.readContract({
          address: vault,
          abi: czarVaultAbi,
          functionName: "getPocket",
          args: [pocket],
        });
        return BigInt(record.state) === POCKET_STATE_CLOSED;
      },
      onRowError: () =>
        options.logger.error("manual_return_reconciliation_failure", {
          rule: "receipt-position-unavailable",
          state: "retry",
        }),
      now: options.clock.now,
      writeOffManualReturn: (row) => writeOffManualReturn(options, signer, row),
    });
  };
  return startPayerRuntime({
    ...(pocketHalt ? { events: vaultEvents, pocketHalt } : {}),
    fallbackPollSeconds: Number(options.config.get("payer.pullbackFallbackPollSeconds")),
    runFallbacks: () => runPullbackFallbacks(options, signer, fallbackChain, pocketReader),
    recoveryPollSeconds: Number(options.config.get("payer.gatewayRecoveryPollSeconds")),
    runClosedRecovery: runRecoveryPass,
    onError: (operation) =>
      options.logger.error("payer_runtime_failure", { rule: operation, state: "error" }),
  });
}

async function writeOffManualReturn(
  options: ServerMainOptions,
  signer: ServerSigner,
  row: ManualReturnWriteOffCandidate,
): Promise<unknown> {
  if (!row.vault_address) throw new Error("Manual-return write-off row has no vault address.");
  const gatewayMinter = row.gateway_minter ?? options.gatewayMinter;
  return writeOffOverdueManualReturn(
    {
      planId: row.plan_id,
      stepIndex: row.step_index,
      attempt: row.attempt ?? 0,
      envelopeRef: row.envelope_ref,
      vault: row.vault_address,
      pocket: row.pocket,
    },
    {
      pool: options.pool,
      config: options.config,
      signer,
      chain: createPullbackExecutionChain({
        client: options.publicClient,
        pool: options.pool,
        vault: row.vault_address,
        ...(gatewayMinter ? { gatewayMinter } : {}),
      }),
      now: options.clock.now,
    },
  );
}

async function recoverManualReturnPosition(
  options: ServerMainOptions,
  row: ManualReturnRow,
): Promise<ManualReturnReceiptPosition | null> {
  const vault = row.vault_address;
  if (vault === null) return null;
  const txHash = row.return_tx ?? (await slowReturnTransactionHash(options.pool, row));
  if (!txHash || !/^0x[\da-fA-F]{64}$/.test(txHash)) return null;
  const receipt = await options.publicClient.getTransactionReceipt({ hash: txHash as Hex });
  if (receipt.status !== "success") return null;
  const usdc = (options.config.get("chain.usdcAddress") as Address).toLowerCase();
  const matching = receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== usdc) return [];
    try {
      const decoded = decodeEventLog({
        abi: usdcTransferAbi,
        eventName: "Transfer",
        data: log.data,
        topics: log.topics,
      });
      if (
        decoded.args.from.toLowerCase() === row.pocket.toLowerCase() &&
        decoded.args.to.toLowerCase() === vault.toLowerCase() &&
        decoded.args.value > 0n
      )
        return [{ amount: decoded.args.value, logIndex: log.logIndex }];
      return [];
    } catch {
      return [];
    }
  });
  if (matching.length !== 1) return null;
  const transfer = matching[0];
  if (!transfer) return null;
  return {
    txHash: receipt.transactionHash,
    amount: transfer.amount.toString(),
    block: receipt.blockNumber.toString(),
    logIndex: transfer.logIndex,
  };
}

async function slowReturnTransactionHash(pool: Pool, row: ManualReturnRow): Promise<string | null> {
  const trace = await pool.query<{ readonly payload: Record<string, unknown> }>(
    `SELECT payload FROM step_executions
     WHERE plan_id=$1 AND step_index=$2 AND attempt=$3
       AND phase='pullback.slow.returned'
     ORDER BY execution_id DESC LIMIT 1`,
    [row.plan_id, row.step_index, row.attempt ?? 0],
  );
  const hash = trace.rows[0]?.payload["txHash"];
  return typeof hash === "string" ? hash : null;
}

async function runPullbackFallbacks(
  options: ServerMainOptions,
  signer: ServerSigner,
  fallbackChain: PullbackFallbackSchedulerDependencies["chain"],
  pocketReader: ReturnType<typeof createIndexerPocketReader>,
) {
  return runPendingPullbackFallbacks({
    pool: options.pool,
    config: options.config,
    signer,
    cancelPendingPullback: (input) => cancelFallbackPullback(options, signer, input),
    chain: fallbackChain,
    readGatewayBalance: (pocket) => pocketReader.pocketBalance(pocket),
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

function createPocketOperations(
  options: ServerMainOptions,
  signer: ServerSigner,
  pocketRecovery?: PocketRecoveryOperations,
) {
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
        config: options.config,
        now: options.clock.now,
        signer: {
          sign: signer.sign.bind(signer),
          retirePocketKey: signer.retirePocketKey.bind(signer),
        },
        chain,
        ...(pocketRecovery?.recoverLateGatewayBalance
          ? { recoverLateGatewayBalance: pocketRecovery.recoverLateGatewayBalance }
          : {}),
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

async function runDispatchedStep(
  options: ServerMainOptions,
  signer: ServerSigner,
  payerDependencies: ReturnType<typeof createPayerDependencies>,
  selection: RegisteredSelection,
  dispatch: DispatchStepRequest,
): Promise<"done" | "failed" | "handed_off" | "pending"> {
  const envelopeId = parseEnvelopeId(dispatch.envelopeRef, dispatch.vault);
  const acceptedDependencies = await readAcceptedDependencies(options.pool, dispatch);
  if (
    dispatch.step.kind === "local" ||
    dispatch.step.kind === "agent-assist" ||
    dispatch.step.kind === "x402-exact"
  ) {
    const result = await executeVaultDirectStep(
      {
        planId: dispatch.planId,
        envelopeRef: dispatch.envelopeRef,
        envelopeId,
        envelopeExpiresAt: new Date(dispatch.plan.expiresAt),
        vault: dispatch.vault,
        plan: dispatch.plan,
        step: dispatch.step,
        userId: dispatch.userId,
        deviceId: dispatch.deviceId,
        acceptedDependencies,
        workerId: dispatch.workerId,
        dispatchLease: dispatch.dispatchLease,
      },
      {
        ...payerDependencies,
        chain:
          options.chainForVault?.(dispatch.vault) ??
          options.chain ??
          createViemVaultDirectChain({
            client: options.publicClient,
            vault: dispatch.vault,
            usdc: options.config.get("chain.usdcAddress") as Address,
          }),
      },
    );
    return result.state;
  }
  if (dispatch.step.kind === "gateway-nano")
    return runGatewayStep(options, signer, dispatch, envelopeId, acceptedDependencies);
  if (dispatch.step.kind === "erc8183-job")
    return runJobStep(options, signer, selection, dispatch, envelopeId, acceptedDependencies);
  return "failed";
}

async function runGatewayStep(
  options: ServerMainOptions,
  signer: ServerSigner,
  dispatch: DispatchStepRequest,
  envelopeId: bigint,
  acceptedDependencies: Awaited<ReturnType<typeof readAcceptedDependencies>>,
): Promise<"done" | "failed" | "pending"> {
  if (!dispatch.plan.pocket) throw new Error("Gateway plan has no approved pocket key.");
  const gatewayStatus =
    options.gatewayStatus ??
    createIndexerGatewayStatus(
      options.appReadOptions.indexerUrl,
      dispatch.vault,
      Number(options.config.get("api.pageMaxLimit")),
      Number(options.config.get("fetch.timeoutMs")),
    );
  await executePocketPreparation(
    {
      planId: dispatch.planId,
      envelopeRef: dispatch.envelopeRef,
      envelopeId,
      vault: dispatch.vault,
      plan: dispatch.plan,
      workerId: dispatch.workerId,
      dispatchLease: dispatch.dispatchLease,
    },
    {
      pool: options.pool,
      config: options.config,
      signer,
      chain: createPocketPreparationChain({
        client: options.publicClient,
        vault: dispatch.vault,
        usdc: options.config.get("chain.usdcAddress") as Address,
        gatewayWallet: options.config.get("chain.gatewayWalletAddress") as Address,
      }),
      now: options.clock.now,
    },
  );
  await payGatewaySteps(
    {
      planId: dispatch.planId,
      envelopeRef: dispatch.envelopeRef,
      plan: dispatch.plan,
      pocket: dispatch.plan.pocket as Address,
      steps: [dispatch.step],
      acceptedDependencies,
      dispatchLease: dispatch.dispatchLease,
    },
    {
      pool: options.pool,
      config: options.config,
      signer,
      safeFetch: options.safeFetch,
      now: options.clock.now,
      gatewayStatus,
    },
  );
  const skipped = (
    await getExecutionTrace(options.pool, dispatch.planId, dispatch.step.stepIndex, 0)
  ).filter((row) => row.phase === "pocket.dependency-missing").length;
  const latestStatuses = await refreshGatewayStatuses(
    {
      planId: dispatch.planId,
      envelopeRef: dispatch.envelopeRef,
      plan: dispatch.plan,
      pocket: dispatch.plan.pocket as Address,
      steps: [dispatch.step],
      acceptedDependencies,
      dispatchLease: dispatch.dispatchLease,
    },
    {
      pool: options.pool,
      config: options.config,
      signer,
      safeFetch: options.safeFetch,
      now: options.clock.now,
      gatewayStatus,
    },
  );
  if (latestStatuses.includes("failed")) return "failed";
  if (latestStatuses.includes("pending")) return "pending";
  return latestStatuses.length + skipped >= (dispatch.step.callInputs?.length ?? 0)
    ? "done"
    : "pending";
}

async function runJobStep(
  options: ServerMainOptions,
  signer: ServerSigner,
  selection: RegisteredSelection,
  dispatch: DispatchStepRequest,
  envelopeId: bigint,
  acceptedDependencies: Awaited<ReturnType<typeof readAcceptedDependencies>>,
): Promise<"failed" | "pending"> {
  if (!options.config.get("routing.jobEnabled")) {
    const stepError: StepError = {
      schemaVersion: "1.0",
      code: "unsupported-offer",
      message: "ERC-8183 job payments are disabled.",
      retryable: false,
    };
    await markStepFailed(options.pool, {
      planId: dispatch.planId,
      stepIndex: dispatch.step.stepIndex,
      attempt: 0,
      errorCode: stepError.code,
      stepError,
    });
    return "failed";
  }
  const step = dispatch.step;
  if (!step.serviceId || !dispatch.plan.taskSpec)
    throw new Error("Job step is missing its registered service or TaskSpec.");
  const callInputs = resolveJobInputs(step, acceptedDependencies);
  if (!callInputs) return "failed";
  const jobEscrow = await options.publicClient.readContract({
    address: dispatch.vault,
    abi: czarVaultAbi,
    functionName: "jobEscrow",
  });
  const outputSchema = await selection.outputSchema.forService(step.serviceId);
  const expectedKeys = stringList(outputSchema?.["required"]);
  const result = await executeJobStep(
    {
      planId: dispatch.planId,
      envelopeRef: dispatch.envelopeRef,
      envelopeId,
      vault: dispatch.vault,
      stepIndex: step.stepIndex,
      provider: requireAddress(step.payee, "job provider"),
      alternates: (step.alternates ?? []).map((address) =>
        requireAddress(address, "job alternate"),
      ),
      stepCap: BigInt(step.stepCap),
      proof: payeeProof(
        dispatch.plan,
        requireAddress(step.payee, "job provider"),
        PAYEE_KIND.ERC8183_PROVIDER,
        step,
      ),
      alternateProofsByProvider: alternateJobProofs(dispatch.plan, step),
      planHash: dispatch.plan.planHash,
      network: dispatch.plan.network,
      jobEscrow,
      acceptanceProfileId: step.acceptanceProfileId,
      capability: step.capability,
      callInputs,
      taskSpec: dispatch.plan.taskSpec as TaskSpec,
      deliverable: {
        mimeType: "application/json",
        ...(expectedKeys.length ? { expectedKeys } : {}),
        ...(outputSchema ? { schema: outputSchema } : {}),
      },
      targetBudget: step.stepCap,
      evaluator: await signer.keyAddress("cz-16", "K7"),
      envelopeExpiresAt: new Date(dispatch.plan.expiresAt),
      workerId: dispatch.workerId,
      dispatchLease: dispatch.dispatchLease,
    },
    {
      pool: options.pool,
      config: options.config,
      signer,
      chain: createJobChainAdapter({
        client: options.publicClient,
        pool: options.pool,
        config: options.config,
        vault: dispatch.vault,
        jobEscrow,
        usdc: options.config.get("chain.usdcAddress") as Address,
        now: options.clock.now,
      }),
      vault: dispatch.vault,
      now: options.clock.now,
      randomSalt: () => `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
      ...(options.jobEvaluator ? { evaluator: options.jobEvaluator } : {}),
    },
  );
  return jobStepOutcome(result.state, options.logger);
}

export function jobStepOutcome(state: string, logger: Logger): "failed" | "pending" {
  if (state === "Completed") {
    logger.error("job-result-missing", { rule: "job-result-missing", state });
    return "pending";
  }
  if (["Rejected", "Expired", "Released"].includes(state)) return "failed";
  return "pending";
}

async function readAcceptedDependencies(
  pool: Pool,
  dispatch: DispatchStepRequest,
): Promise<NonNullable<VaultDirectInput["acceptedDependencies"]>> {
  const result = await pool.query<{
    step_index: number;
    payload: { subjectIndex?: number; stepResult?: StepResult };
  }>(
    `SELECT step_index,payload FROM step_executions
     WHERE plan_id=$1 AND phase='step.result' ORDER BY execution_id`,
    [dispatch.planId],
  );
  return result.rows
    .filter((row) => dispatch.step.dependsOn?.includes(row.step_index))
    .flatMap((row) => {
      const stepResult = row.payload.stepResult;
      if (!stepResult) return [];
      return [
        {
          stepIndex: row.step_index,
          ...(row.payload.subjectIndex === undefined
            ? {}
            : { subjectIndex: row.payload.subjectIndex }),
          accepted: stepResult.status === "delivered",
          fields: stepResult.fields,
        },
      ];
    });
}

function resolveJobInputs(
  step: DispatchStepRequest["step"],
  dependencies: NonNullable<VaultDirectInput["acceptedDependencies"]>,
): readonly Readonly<Record<string, string | number | boolean>>[] | null {
  const calls = step.callInputs ?? [];
  const resolved: Readonly<Record<string, string | number | boolean>>[] = [];
  for (const call of calls) {
    const input: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(call.input)) {
      if (typeof value !== "string") {
        if (typeof value !== "number" && typeof value !== "boolean") return null;
        input[key] = value;
        continue;
      }
      const match = /^\{\{dep\.(\d+)\.([\w-]+)\}\}$/.exec(value);
      if (!match) {
        input[key] = value;
        continue;
      }
      const fields = dependencies.find(
        (entry) =>
          entry.accepted &&
          entry.stepIndex === Number(match[1]) &&
          entry.subjectIndex === call.subjectIndex,
      )?.fields;
      const field = fields?.find((entry) => entry.name === match[2] && entry.value.trim());
      if (!field) return null;
      input[key] = field.value;
    }
    resolved.push(input);
  }
  return resolved;
}

function payeeProof(
  plan: Plan,
  payeeValue: string,
  kind: number,
  step: DispatchStepRequest["step"],
): readonly Hash32[] {
  const payee = requireAddress(payeeValue, "approved payee");
  const leaves = plan.payeeLeaves.map((item) =>
    payeeLeaf(item.payee as Address, item.kind, item.stepIndex, BigInt(item.stepCap)),
  );
  const tree = buildTree(leaves);
  const leaf = payeeLeaf(payee, kind, step.stepIndex, BigInt(step.stepCap));
  if (
    tree.root.toLowerCase() !== plan.payeeRoot.toLowerCase() ||
    !verifyProof(tree.proof(leaf), tree.root, leaf)
  )
    throw new Error("Approved plan payee proof does not match payeeRoot.");
  return tree.proof(leaf);
}

function alternateJobProofs(
  plan: Plan,
  step: DispatchStepRequest["step"],
): Readonly<Record<string, readonly Hash32[]>> {
  return Object.fromEntries(
    (step.alternates ?? []).map((address) => [
      address,
      payeeProof(plan, address, PAYEE_KIND.ERC8183_PROVIDER, step),
    ]),
  );
}

function requireAddress(value: string | undefined, label: string): Address {
  if (value === undefined || !/^0x[\da-fA-F]{40}$/.test(value))
    throw new TypeError(`Approved ${label} is not an EVM address.`);
  return value as Address;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function parseEnvelopeId(envelopeRef: string, vault: Address): bigint {
  const parts = envelopeRef.split(":");
  const envelopeVault = parts[2];
  const id = parts[3];
  if (
    parts.length !== 4 ||
    envelopeVault?.toLowerCase() !== vault.toLowerCase() ||
    !id ||
    !/^(0|[1-9]\d*)$/.test(id)
  )
    throw new TypeError("Executing objective has a malformed or mismatched envelopeRef.");
  return BigInt(id);
}

async function readVaultPauseState(options: ServerMainOptions, vault: Address): Promise<boolean> {
  return options.publicClient.readContract({
    address: vault,
    abi: czarVaultAbi,
    functionName: "frozen",
  });
}

async function readGuardianPauseState(
  options: ServerMainOptions,
  vault: Address,
): Promise<boolean> {
  const factory = await options.publicClient.readContract({
    address: vault,
    abi: czarVaultAbi,
    functionName: "factory",
  });
  return options.publicClient.readContract({
    address: factory,
    abi: czarVaultFactoryAbi,
    functionName: "guardianPaused",
  });
}

function completionChain(options: ServerMainOptions) {
  return {
    async readEnvelope(vault: Address, envelopeId: bigint) {
      const value = await options.publicClient.readContract({
        address: vault,
        abi: czarVaultAbi,
        functionName: "getEnvelope",
        args: [envelopeId],
      });
      return {
        state: Number(value.state) === 2 ? ("Closed" as const) : ("Open" as const),
        openReservations: BigInt(value.openReservations),
        openPockets: BigInt(value.openPockets),
        openJobs: BigInt(value.openJobs),
      };
    },
    async closeEnvelope(input: { vault: Address; envelopeId: bigint; transaction: Hex }) {
      const hash = await options.publicClient.sendRawTransaction({
        serializedTransaction: input.transaction,
      });
      const receipt = await options.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`closeEnvelope reverted: ${hash}`);
      return hash;
    },
  };
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
    await appendExecutionPhase(options.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt: context.attempt,
      phase: "acceptance.result",
      payload: {
        index: context.index,
        reportHash: result.acceptance.report.reportHash,
        obsId: result.acceptance.report.obs_id,
      },
    });
    return (
      result.result ?? quarantinedStepResult(context, source, bodyCommit, result.acceptance.report)
    );
  };
}

function createReceiptBuilder(options: ServerMainOptions, signer: Pick<Signer, "sign">) {
  return async (context: SettledReceiptContext): Promise<boolean> => {
    const acceptance = await options.pool.query<{ report_hash: string; obs_id: string }>(
      `SELECT payload->>'reportHash' AS report_hash,payload->>'obsId' AS obs_id
       FROM step_executions
       WHERE plan_id=$1 AND step_index=$2 AND attempt=$3 AND phase='acceptance.result'
         AND payload->>'index'=$4
       ORDER BY execution_id DESC LIMIT 1`,
      [context.input.planId, context.input.step.stepIndex, context.attempt, String(context.index)],
    );
    const acceptanceRef = acceptance.rows[0];
    if (!acceptanceRef)
      throw new Error("Acceptance report identity is missing for the settled call.");
    const reports = await options.pool.query<{
      report_hash: string;
      obs_id: string;
      checks: AcceptanceReport["checks"];
    }>(
      `SELECT report_hash,obs_id,checks FROM acceptance_reports
       WHERE report_hash=$1 AND obs_id=$2 AND envelope_ref=$3 AND step_index=$4 AND body_ref=$5`,
      [
        acceptanceRef.report_hash,
        acceptanceRef.obs_id,
        context.input.envelopeRef,
        context.input.step.stepIndex,
        context.bodyRef,
      ],
    );
    const reportHashes = reports.rows.map((row) => row.report_hash);
    const input = options.receiptInput
      ? options.receiptInput(context, context.stepResult, reportHashes)
      : createReceiptInputFromTrace(
          context,
          await getExecutionTrace(
            options.pool,
            context.input.planId,
            context.input.step.stepIndex,
            context.attempt,
          ),
          reports.rows,
        );
    const settlement =
      options.settlement ??
      createIndexerSettlement(
        options.appReadOptions.indexerUrl,
        Number(options.config.get("api.pageMaxLimit")),
        Number(options.config.get("fetch.timeoutMs")),
        (payment) => verifyX402Transfer(options.publicClient, payment),
      );
    const receipt = await createPaymentReceipt(input, {
      pool: options.pool,
      config: options.config,
      signer,
      settlement,
      now: options.clock.now,
    });
    return receipt !== null;
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
      if (taskClass === "local") return localTemplateProfile().profile_id;
      return acceptance.profileIdFor(taskClass);
    },
  };
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
