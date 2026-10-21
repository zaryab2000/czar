import { randomUUID } from "node:crypto";
import { keccak256 } from "viem";
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

export interface ServerMainOptions extends PairDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly logger: Logger;
  readonly modelClient: ModelClient;
  readonly createSigner: () => Promise<Pick<Signer, "sign">>;
  readonly acceptancePorts: AcceptancePorts;
  readonly objects: {
    put(bytes: Uint8Array): Promise<string>;
    get(ref: string): Promise<Uint8Array>;
  };
  readonly chain: VaultDirectChain;
  readonly safeFetch: SafeFetch;
  readonly settlement: PaymentReceiptDependencies["settlement"];
  readonly receiptInput: (
    context: SettledReceiptContext,
    stepResult: unknown,
    reportHashes: readonly string[],
  ) => PaymentReceiptInput;
  readonly appReadOptions: AppReadOptions;
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
}

export async function createServerMain(options: ServerMainOptions): Promise<ServerMain> {
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
  const boundary = createPayerBoundary(options, acceptance, promptHashes);
  const signer = await options.createSigner();
  const recordReceipt = createReceiptBuilder(options, signer);
  const payerDependencies = {
    pool: options.pool,
    config: options.config,
    signer,
    chain: options.chain,
    safeFetch: options.safeFetch,
    now: options.clock.now,
    objects: options.objects,
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
    ...(options.appReadOptions ? { appReadOptions: options.appReadOptions } : {}),
    ...(options.revisePlanSubjects ? { revisePlanSubjects: options.revisePlanSubjects } : {}),
  });
  return {
    app,
    acceptance,
    executePayerStep: (input) => executeVaultDirectStep(input, payerDependencies),
  };
}

function createPayerBoundary(
  options: ServerMainOptions,
  acceptance: Awaited<ReturnType<typeof createAcceptanceChecker>>,
  promptHashes: Readonly<Record<"P-01" | "P-02", string>>,
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
        objectStore: options.objects,
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
