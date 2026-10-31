// SCR-146 run 5: the CZ-15 vault-direct (x402-exact) executor wired as `apps/server/src/main.ts` wires it
// (`executeVaultDirectStep` over `createViemVaultDirectChain`), on the local pocket harness. The reader
// boundary and the receipt builder are outside the crash matrix (reserve, payment, settle, mint): the
// boundary returns a delivered StepResult for the paid body and receipts are reported stored. Waits for
// `validBefore` and reconciliation advance the harness clock and chain time instead of sleeping.
import { randomBytes } from "node:crypto";
import { buildTree, PAYEE_KIND, payeeLeaf, paymentRefHash, type Hash32 } from "@czar/hashing";
import type { Plan, Step, StepResult } from "@czar/schemas";
import { czarVaultAbi } from "@czar/vault-client";
import { keccak256, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { acquireExecutorLease } from "#src/payer/executions";
import { createViemVaultDirectChain } from "#src/payer/viem-chain";
import {
  executeVaultDirectStep,
  type BoundaryInput,
  type VaultDirectDependencies,
  type VaultDirectInput,
  type VaultDirectResult,
} from "#src/payer/vault-direct";
import { ARC_CHAIN_ID, ARC_USDC } from "#test/local-pocket/arc-chain";
import {
  openEnvelope,
  seedPlanRows,
  type LocalPocketHarness,
  type PlanJson,
  type VaultFixture,
} from "#test/local-pocket/harness";
import {
  createX402Merchant,
  MERCHANT_ORIGIN,
  type X402Merchant,
} from "#test/local-pocket/x402-merchant";

const STEP_INDEX = 0;
const PROFILE_ID = "prof_11111111111111111111111111111111";
const SERVICE_ID = "svc_11111111111111111111111111111111";
const STEP_ID = "stp_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";

export interface X402Plan {
  readonly vault: VaultFixture;
  readonly planId: string;
  readonly envelopeId: bigint;
  readonly envelopeRef: string;
  readonly merchant: X402Merchant;
  readonly unitAmount: bigint;
  readonly calls: number;
  readonly input: VaultDirectInput;
  /** The durable object store paid bodies go to; it outlives every executor instance. */
  readonly objects: VaultDirectDependencies["objects"];
}

/** A one-step x402-exact plan with `calls` paid calls of `unitAmount`, its envelope opened by the owner. */
export async function openX402Plan(
  harness: LocalPocketHarness,
  vault: VaultFixture,
  sizes: {
    readonly unitAmount: bigint;
    readonly calls: number;
    readonly maxTimeoutSeconds: number;
    readonly envelopeLifetimeSeconds?: bigint;
  },
): Promise<X402Plan> {
  const payTo = privateKeyToAccount(generatePrivateKey()).address;
  const merchant = createX402Merchant({ chain: harness.chain, payTo, ...sizes });
  const stepCap = sizes.unitAmount * BigInt(sizes.calls);
  const payeeRoot = buildTree([payeeLeaf(payTo, PAYEE_KIND.X402_PAY_TO, STEP_INDEX, stepCap)]).root;
  const planHash = keccak256(randomBytes(32)) as Hash32;
  const objectiveHash = keccak256(randomBytes(32)) as Hash32;
  const envelopeId = await openEnvelope(harness, vault, {
    stepCap,
    cap: stepCap,
    pocketCapBps: 0,
    planHash,
    objectiveHash,
    payeeRoot,
    ...(sizes.envelopeLifetimeSeconds === undefined
      ? {}
      : { lifetimeSeconds: sizes.envelopeLifetimeSeconds }),
  });
  const envelopeRef = `eip155:${ARC_CHAIN_ID}:${vault.vault.toLowerCase()}:${envelopeId}`;
  const envelope = await harness.chain.reader.readContract({
    address: vault.vault,
    abi: czarVaultAbi,
    functionName: "getEnvelope",
    args: [envelopeId],
  });
  const expiresAt = new Date(Number(envelope.expiresAt) * 1000);
  const step = x402Step(merchant, sizes, stepCap);
  const plan = x402PlanJson({
    step,
    payTo,
    stepCap,
    payeeRoot,
    planHash,
    objectiveHash,
    expiresAt,
  });
  const planId = await seedPlanRows(harness, vault, { plan, envelopeRef, objectiveHash, planHash });
  harness.signer.leaves.set(`${vault.vault.toLowerCase()}:${envelopeId}`, [
    {
      stepIndex: STEP_INDEX,
      payee: payTo,
      kind: PAYEE_KIND.X402_PAY_TO,
      stepCap,
      stepKind: "x402-exact",
      expectedCalls: sizes.calls,
      usedCalls: 0,
    },
  ]);
  return {
    vault,
    planId,
    envelopeId,
    envelopeRef,
    merchant,
    unitAmount: sizes.unitAmount,
    calls: sizes.calls,
    objects: memoryObjectStore(),
    input: {
      planId,
      envelopeRef,
      envelopeId,
      envelopeExpiresAt: expiresAt,
      vault: vault.vault,
      plan: { ...plan, planId } as unknown as Plan,
      step,
      userId: vault.userId,
      deviceId: vault.deviceId,
    },
  };
}

/**
 * One fresh vault-direct executor run (a fresh process after a kill) over the shared DB and chain. With
 * `serverLagMs`, this run's server clock trails the harness clock (and chain time) by that much (SCR-155 §2); a
 * negative value puts it ahead (SCR-157 §1).
 */
export function executeX402(
  harness: LocalPocketHarness,
  plan: X402Plan,
  workerId?: string,
  serverLagMs = 0,
): Promise<VaultDirectResult> {
  return executeVaultDirectStep(
    { ...plan.input, ...(workerId === undefined ? {} : { workerId }) },
    {
      pool: harness.pool,
      config: harness.config,
      signer: harness.signer.signer,
      chain: createViemVaultDirectChain({
        client: harness.chain.payerClient,
        vault: plan.vault.vault,
        usdc: ARC_USDC,
      }),
      safeFetch: plan.merchant.fetch,
      now: () => new Date(harness.clock.now().getTime() - serverLagMs),
      sleep: (milliseconds) => harness.clock.advance(milliseconds),
      boundary: async (context) => deliveredResult(context),
      recordReceipt: async () => true,
      objects: plan.objects,
    },
  );
}

/**
 * A SIGKILLed payer never runs its `finally`, so its envelope lease stays until it expires. An in-process
 * kill does run it; this puts back the lease the killed worker held, as of now.
 */
export async function holdLeaseAsKilledWorker(
  harness: LocalPocketHarness,
  plan: X402Plan,
  workerId: string,
): Promise<void> {
  const held = await acquireExecutorLease(
    harness.pool,
    plan.envelopeRef,
    workerId,
    Number(harness.config.get("payer.leaseSeconds")),
    harness.clock.now,
  );
  if (!held) throw new Error("Another worker holds the envelope lease.");
}

function memoryObjectStore(): VaultDirectDependencies["objects"] {
  const bodies = new Map<string, Uint8Array>();
  return {
    async put(bytes) {
      const ref = `body-${bodies.size + 1}`;
      bodies.set(ref, bytes.slice());
      return ref;
    },
    async get(ref) {
      const bytes = bodies.get(ref);
      if (!bytes) throw new Error("Object store body is missing.");
      return bytes.slice();
    },
  };
}

function deliveredResult(context: BoundaryInput): StepResult {
  return {
    schemaVersion: "1.1",
    stepIndex: context.input.step.stepIndex,
    callIndex: context.index,
    obsId: context.obsId,
    status: "delivered",
    source: {
      origin: MERCHANT_ORIGIN,
      payTo: context.paymentPayload.payload.authorization.to,
      paymentRefHash: paymentRefHash(context.paymentRef as unknown as Record<string, unknown>),
    },
    fields: [],
    flags: [],
    bodyCommit: keccak256(context.response.body),
  };
}

function x402Step(
  merchant: X402Merchant,
  sizes: { readonly unitAmount: bigint; readonly calls: number },
  stepCap: bigint,
): Step {
  return {
    stepIndex: STEP_INDEX,
    stepId: STEP_ID,
    kind: "x402-exact",
    capability: "web-search",
    serviceId: SERVICE_ID,
    resource: { url: merchant.resourceUrl, method: "GET" },
    payee: merchant.payTo,
    unitAmount: sizes.unitAmount.toString(),
    expectedCalls: sizes.calls,
    stepCap: stepCap.toString(),
    routingReason: "vault-direct",
    acceptanceProfileId: PROFILE_ID,
    callInputs: Array.from({ length: sizes.calls }, (_, callIndex) => ({
      callIndex,
      input: { q: `local crash-restart call ${callIndex}` },
    })),
  } as Step;
}

function x402PlanJson(input: {
  readonly step: Step;
  readonly payTo: Address;
  readonly stepCap: bigint;
  readonly payeeRoot: Hash32;
  readonly planHash: Hash32;
  readonly objectiveHash: Hash32;
  readonly expiresAt: Date;
}): PlanJson {
  return {
    schemaVersion: "1.3",
    planHash: input.planHash,
    objectiveHash: input.objectiveHash,
    network: `eip155:${ARC_CHAIN_ID}`,
    category: "research",
    cap: input.stepCap.toString(),
    slackBps: 0,
    maxStepAmount: input.stepCap.toString(),
    pocketCapBps: 0,
    expiresAt: input.expiresAt.toISOString(),
    steps: [input.step as unknown as PlanJson["steps"][number]],
    payeeLeaves: [
      {
        payee: input.payTo,
        kind: PAYEE_KIND.X402_PAY_TO,
        stepIndex: STEP_INDEX,
        stepCap: input.stepCap.toString(),
      },
    ],
    payeeRoot: input.payeeRoot,
    shadow: false,
  };
}
