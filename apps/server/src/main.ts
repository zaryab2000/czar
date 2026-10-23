import { randomBytes, randomUUID } from "node:crypto";
import { keccak256, type Address, type PublicClient, type WalletClient } from "viem";
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
  readonly modelClient: ModelClient;
  readonly createSigner: () => Promise<Pick<Signer, "sign" | "retirePocketKey">>;
  readonly acceptancePorts: AcceptancePorts;
  readonly objects?: ObjectStore;
  readonly vaultEvents?: VaultHaltEventSource;
  readonly pocketHalt?: PocketHaltDependencies;
  readonly gatewayStatus?: PocketNanopaymentDependencies["gatewayStatus"];
  readonly pullbackFallbackChain?: PullbackFallbackSchedulerDependencies["chain"];
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly chain: VaultDirectChain;
  readonly safeFetch: SafeFetch;
  readonly settlement: PaymentReceiptDependencies["settlement"];
  readonly receiptInput: (
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
  readonly revisePlanSubjects: (
    userId: string,
    planId: string,
    revision: SubjectsRevision,
  ) => Promise<Plan | null>;
}

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
  close(): void;
}

export async function createServerMain(options: ServerMainOptions): Promise<ServerMain> {
  const objects =
    options.objects ??
    createFileObjectStore(String(options.config.get("payer.job.deliverableStorePath")));
  await migrate(options.pool);
  const acceptance = await createAcceptanceChecker({
    pool: options.pool,
    config: options.config,
    ports: options.acceptancePorts,
    logger: options.logger,
  });
  const promptHashes = {
    "P-01": await computePromptHash("P-01"),
    "P-02": await computePromptHash("P-02"),
  } as const;
  const boundary = createPayerBoundary(options, acceptance, promptHashes, objects);
  const signer = await options.createSigner();
  const vaultEvents =
    options.vaultEvents ??
    (options.pocketHalt ? createDatabaseVaultEventSource(options) : undefined);
  if (!options.vaultEvents && !options.pocketHalt)
    options.logger.error("payer_halt_monitor_disabled", {
      rule: "missing_pocket_halt_dependencies",
      state: "disabled",
    });
  const pullbackFallbackChain =
    options.pullbackFallbackChain ??
    createPullbackChainAdapter(
      options.publicClient,
      options.walletClient,
      options.config.get("chain.gatewayWalletAddress") as Address,
      {
        config: options.config,
        logger: options.logger,
      },
    );
  const payerRuntime = startPayerRuntime({
    ...(vaultEvents ? { events: vaultEvents } : {}),
    ...(options.pocketHalt ? { pocketHalt: options.pocketHalt } : {}),
    fallbackPollSeconds: Number(options.config.get("payer.pullbackFallbackPollSeconds")),
    runFallbacks: () =>
      runPendingPullbackFallbacks({
        pool: options.pool,
        config: options.config,
        signer,
        cancelPendingPullback: async (input) => {
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
        },
        chain: pullbackFallbackChain,
        now: options.clock.now,
      }),
    onError: (operation) =>
      options.logger.error("payer_runtime_failure", { rule: operation, state: "error" }),
  });
  const recordReceipt = createReceiptBuilder(options, signer);
  const payerDependencies = {
    pool: options.pool,
    config: options.config,
    signer,
    chain: options.chain,
    safeFetch: options.safeFetch,
    now: options.clock.now,
    objects,
    boundary,
    recordReceipt,
  };
  const app = createApp({
    pool: options.pool,
    config: options.config,
    logger: options.logger,
    clock: options.clock,
    random: options.random,
    modelClient: options.modelClient,
    jobDelivery: {
      pool: options.pool,
      config: options.config,
      now: options.clock.now,
      publicClient: options.publicClient,
      objectStore: objects,
    },
    ...(options.appReadOptions ? { appReadOptions: options.appReadOptions } : {}),
    ...(options.revisePlanSubjects ? { revisePlanSubjects: options.revisePlanSubjects } : {}),
  });
  return {
    app,
    acceptance,
    executePayerStep: (input) => executeVaultDirectStep(input, payerDependencies),
    executePocketPreparation: (input) =>
      executePocketPreparation(input, {
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
      }),
    executePocketNanopayments: async (input) => {
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
    closePocket: (input, chain) =>
      sweepAndRetirePocketKey(input, { pool: options.pool, signer, chain }),
    executePullback: (input) => {
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
    cancelExpiredPullback: (input) => {
      const dependencies = {
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
      };
      return cancelExpiredPullback(input, dependencies);
    },
    executeJobStep: (input) =>
      executeJobStep(input, {
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
      }),
    close: () => payerRuntime.stop(),
  };
}

function createPayerBoundary(
  options: ServerMainOptions,
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
    const outputSchema = await options.acceptancePorts.outputSchema.forService(serviceId);
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
        modelClient: options.modelClient,
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
  const dependencies: PaymentReceiptDependencies = {
    pool: options.pool,
    config: options.config,
    signer,
    settlement: options.settlement,
    now: options.clock.now,
  };
  return async (context: SettledReceiptContext): Promise<void> => {
    const reports = await options.pool.query<{ report_hash: string }>(
      `SELECT report_hash FROM acceptance_reports
       WHERE envelope_ref=$1 AND step_index=$2 AND body_ref=$3
       ORDER BY created_at DESC LIMIT 1`,
      [context.input.envelopeRef, context.input.step.stepIndex, context.bodyRef],
    );
    const stepResult = context.stepResult;
    const input = options.receiptInput(
      context,
      stepResult,
      reports.rows.map((row) => row.report_hash),
    );
    await createPaymentReceipt(input, dependencies);
  };
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
