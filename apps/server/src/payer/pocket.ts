import type { Config } from "@czar/config";
import {
  PAYEE_KIND,
  buildTree,
  payeeLeaf,
  pocketLeaf,
  verifyProof,
  type Hash32,
} from "@czar/hashing";
import type { PaymentRef, Plan, Step } from "@czar/schemas";
import type { Signer } from "@czar/signer";
import {
  buildExactPaymentPayload,
  encodePaymentSignature,
  readPaymentRequired,
  selectOffer,
  type SafeFetch,
} from "@czar/x402";
import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { toHex, type Address } from "viem";
import {
  acquireExecutorLease,
  appendExecutionPhase,
  getExecutionTrace,
  releaseExecutorLease,
  startExecutorLeaseRenewal,
} from "#src/payer/executions";

const BASIS_POINTS = 10_000n;
const HALT_PULLBACK_ATTEMPTS = 2;

export interface PocketFundingInput {
  readonly stepCaps: readonly bigint[];
  readonly pocketCapBps: number;
  readonly planCap: bigint;
}

export interface PocketHaltInput {
  readonly vault: Address;
  readonly event: "Frozen" | "GuardianPaused";
}

export interface PocketHaltDependencies {
  readonly listFundedPockets: (vault: Address) => Promise<readonly Address[]>;
  readonly pullback: (pocket: Address) => Promise<unknown>;
}

export interface PocketCloseInput {
  readonly planId: string;
  readonly stepIndex: number;
  readonly attempt: number;
  readonly vault: Address;
  readonly pocket: Address;
}

export interface PocketCloseDependencies {
  readonly pool: Pool;
  readonly signer: Pick<Signer, "sign" | "retirePocketKey">;
  readonly chain: {
    isClosed(pocket: Address): Promise<boolean>;
    hasPendingPullback(pocket: Address): Promise<boolean>;
    writeOffPocket(pocket: Address, transaction: `0x${string}`): Promise<string>;
    sweepableNativeBalance(pocket: Address): Promise<bigint>;
    pocketBalances(pocket: Address): Promise<{ native: bigint; usdc: bigint; gateway: bigint }>;
    sendPocketTransaction(transaction: `0x${string}`): Promise<string>;
  };
}

export function calculatePocketFunding(input: PocketFundingInput): bigint {
  if (
    !Number.isInteger(input.pocketCapBps) ||
    input.pocketCapBps < 0 ||
    input.pocketCapBps > 10_000
  )
    throw new RangeError("pocketCapBps must be an integer between 0 and 10000.");
  const totalStepCaps = input.stepCaps.reduce((total, cap) => total + cap, 0n);
  const pocketCap = (input.planCap * BigInt(input.pocketCapBps)) / BASIS_POINTS;
  return totalStepCaps < pocketCap ? totalStepCaps : pocketCap;
}

export async function drainPocketsAfterHalt(
  input: PocketHaltInput,
  dependencies: PocketHaltDependencies,
): Promise<readonly Address[]> {
  const pockets = await dependencies.listFundedPockets(input.vault);
  const failures: Address[] = [];
  for (const pocket of pockets) {
    try {
      await dependencies.pullback(pocket);
    } catch {
      failures.push(pocket);
    }
  }
  const remaining: Address[] = [];
  for (const pocket of failures) {
    if (!(await pullbackWithRetry(pocket, dependencies.pullback))) remaining.push(pocket);
  }
  if (remaining.length > 0)
    throw new Error(`Pocket halt drain failed for ${remaining.length} funded pocket(s).`);
  return pockets;
}

async function pullbackWithRetry(
  pocket: Address,
  pullback: PocketHaltDependencies["pullback"],
): Promise<boolean> {
  for (let attempt = 0; attempt < HALT_PULLBACK_ATTEMPTS; attempt += 1) {
    try {
      await pullback(pocket);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export async function sweepAndRetirePocketKey(
  input: PocketCloseInput,
  dependencies: PocketCloseDependencies,
): Promise<{ readonly state: "retiring"; readonly sweptNative: string }> {
  if (await dependencies.chain.hasPendingPullback(input.pocket))
    throw new Error("Cannot write off a pocket while a pullback is pending.");
  if (!(await dependencies.chain.isClosed(input.pocket))) {
    const close = await dependencies.signer.sign("cz-15", {
      keyId: "K3",
      kind: "vault-call",
      payload: { vault: input.vault, selector: "writeOffPocket", args: { pocket: input.pocket } },
    });
    if (!("signedTransaction" in close)) throw new Error("K3 did not sign writeOffPocket.");
    await recordPocketPhase(dependencies.pool, input, "pocket.writeoff.sent", {
      transaction: close.signedTransaction,
    });
    const txHash = await dependencies.chain.writeOffPocket(input.pocket, close.signedTransaction);
    await recordPocketPhase(dependencies.pool, input, "pocket.written-off", { txHash });
  }
  const sweptNative = await sweepPocketBalance(input, dependencies, "native");
  await sweepPocketBalance(input, dependencies, "usdc");
  const balances = await dependencies.chain.pocketBalances(input.pocket);
  if (balances.native !== 0n || balances.usdc !== 0n || balances.gateway !== 0n)
    throw new Error("Pocket key cannot retire while a balance remains.");
  await dependencies.signer.retirePocketKey("cz-15", input.pocket);
  await recordPocketPhase(dependencies.pool, input, "pocket.key-retiring", {
    pocket: input.pocket,
  });
  return { state: "retiring", sweptNative: sweptNative.toString() };
}

async function sweepPocketBalance(
  input: PocketCloseInput,
  dependencies: PocketCloseDependencies,
  kind: "native" | "usdc",
): Promise<bigint> {
  const amount =
    kind === "native"
      ? await dependencies.chain.sweepableNativeBalance(input.pocket)
      : (await dependencies.chain.pocketBalances(input.pocket)).usdc;
  if (amount <= 0n) return 0n;
  const trace = await getExecutionTrace(
    dependencies.pool,
    input.planId,
    input.stepIndex,
    input.attempt,
  );
  let transaction = phaseTransaction(trace, `pocket.return.${kind}.sent`);
  if (!transaction) {
    const signed = await dependencies.signer.sign("cz-15", {
      keyId: `K4:${input.pocket}`,
      kind: "pocket-return",
      payload: { pocket: input.pocket, kind, amount: amount.toString() },
    });
    if (!("signedTransaction" in signed)) throw new Error(`K4 did not sign ${kind} pocket return.`);
    transaction = signed.signedTransaction;
  }
  await recordPocketPhase(dependencies.pool, input, `pocket.return.${kind}.sent`, {
    amount: amount.toString(),
    transaction,
  });
  const txHash = await dependencies.chain.sendPocketTransaction(transaction);
  await recordPocketPhase(dependencies.pool, input, `pocket.return.${kind}`, {
    amount: amount.toString(),
    txHash,
  });
  return amount;
}

async function recordPocketPhase(
  pool: Pool,
  input: PocketCloseInput,
  phase: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  await appendExecutionPhase(pool, {
    planId: input.planId,
    stepIndex: input.stepIndex,
    attempt: input.attempt,
    phase,
    payload,
  });
}

export async function readPlanPocketKey(pool: Pool, planId: string): Promise<Address> {
  const result = await pool.query<{ pocket_address: Address }>(
    "SELECT pocket_address FROM plan_pocket_keys WHERE plan_id=$1",
    [planId],
  );
  const pocket = result.rows[0]?.pocket_address;
  if (!pocket) throw new Error(`Plan ${planId} has no linked pocket key.`);
  return pocket;
}

export interface PocketPreparationInput {
  readonly planId: string;
  readonly envelopeRef: string;
  readonly envelopeId: bigint;
  readonly vault: Address;
  readonly plan: Pick<Plan, "payeeRoot" | "payeeLeaves" | "pocketCapBps" | "cap"> & {
    readonly steps: readonly Pick<Step, "kind" | "stepIndex" | "stepCap">[];
  };
  readonly attempt?: number;
  readonly workerId?: string;
}

export interface PocketPreparationChain {
  isRegistered(pocket: Address): Promise<boolean>;
  registerPocket(args: {
    envelopeId: bigint;
    pocket: Address;
    proof: readonly Hash32[];
    transaction: `0x${string}`;
  }): Promise<string>;
  pocketGasGranted(pocket: Address): Promise<bigint>;
  grantPocketGas(args: {
    pocket: Address;
    units: bigint;
    transaction: `0x${string}`;
  }): Promise<string>;
  isDelegateReady(args: { pocket: Address; vault: Address }): Promise<boolean>;
  addDelegate(args: {
    pocket: Address;
    vault: Address;
    transaction: `0x${string}`;
  }): Promise<string>;
  isFunded(pocket: Address): Promise<boolean>;
  fundPocket(args: {
    pocket: Address;
    amount: bigint;
    transaction: `0x${string}`;
  }): Promise<string>;
}

export interface PocketPreparationDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly signer: Pick<Signer, "sign">;
  readonly chain: PocketPreparationChain;
  readonly now: () => Date;
}

export interface PocketNanopaymentInput {
  readonly planId: string;
  readonly envelopeRef: string;
  readonly plan: Pick<Plan, "network">;
  readonly pocket: Address;
  readonly steps: readonly Step[];
  readonly acceptedDependencies?: readonly PocketDependency[];
  readonly attempt?: number;
}

export interface PocketDependency {
  readonly stepIndex: number;
  readonly subjectIndex?: number;
  readonly accepted: boolean;
  readonly fields: readonly { readonly name: string; readonly value: string }[];
}

export interface PocketNanopaymentDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly signer: Pick<Signer, "sign">;
  readonly safeFetch: SafeFetch;
  readonly now: () => Date;
  readonly gatewayStatus: (input: {
    readonly pocket: Address;
    readonly nonce: Hash32;
    readonly transferId?: string;
  }) => Promise<"pending" | "completed">;
}

export async function executePocketPreparation(
  input: PocketPreparationInput,
  dependencies: PocketPreparationDependencies,
): Promise<{ readonly pocket: Address; readonly funded: string }> {
  const pocket = await readPlanPocketKey(dependencies.pool, input.planId);
  const attempt = input.attempt ?? 0;
  const workerId = input.workerId ?? `pocket-${process.pid}-${randomBytes(16).toString("hex")}`;
  const ttl = Number(dependencies.config.get("payer.leaseSeconds"));
  const leased = await acquireExecutorLease(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    ttl,
    dependencies.now,
  );
  if (!leased) throw new Error("Another payer executor holds the envelope lease.");
  const renewal = startExecutorLeaseRenewal(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    ttl,
    dependencies.now,
  );
  try {
    return await preparePocket(input, dependencies, pocket, attempt, renewal.assertHeld);
  } finally {
    await renewal.stop();
    await releaseExecutorLease(dependencies.pool, input.envelopeRef, workerId);
  }
}

async function preparePocket(
  input: PocketPreparationInput,
  dependencies: PocketPreparationDependencies,
  pocket: Address,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<{ readonly pocket: Address; readonly funded: string }> {
  const proof = pocketProof(input.plan, pocket);
  const chain = dependencies.chain;
  const trace = await getExecutionTrace(dependencies.pool, input.planId, 0, attempt);
  if (!(await chain.isRegistered(pocket))) {
    const transaction =
      phaseTransaction(trace, "pocket.register.sent") ??
      (await signVaultCall(dependencies, input.vault, "registerPocket", {
        envelopeId: input.envelopeId.toString(),
        pocket,
        proof,
      }));
    assertLeaseHeld();
    await recordPhase(dependencies, input, attempt, "pocket.register.sent", {
      pocket,
      transaction,
    });
    const txHash = await chain.registerPocket({
      envelopeId: input.envelopeId,
      pocket,
      proof,
      transaction,
    });
    await recordPhase(dependencies, input, attempt, "pocket.registered", { pocket, txHash });
  }
  const gasUnits = BigInt(Number(dependencies.config.get("payer.pocketGasUnits")));
  if ((await chain.pocketGasGranted(pocket)) < gasUnits) {
    const transaction =
      phaseTransaction(trace, "pocket.gas.sent") ??
      (await signVaultCall(dependencies, input.vault, "grantPocketGas", {
        pocket,
        units: gasUnits.toString(),
      }));
    assertLeaseHeld();
    await recordPhase(dependencies, input, attempt, "pocket.gas.sent", {
      pocket,
      gasUnits: String(gasUnits),
      transaction,
    });
    const txHash = await chain.grantPocketGas({ pocket, units: gasUnits, transaction });
    await recordPhase(dependencies, input, attempt, "pocket.gas", {
      pocket,
      gasUnits: String(gasUnits),
      txHash,
    });
  }
  await prepareDelegate(input, dependencies, pocket, attempt, assertLeaseHeld);
  const funded = calculatePocketFunding({
    stepCaps: input.plan.steps
      .filter((step) => step.kind === "gateway-nano")
      .map((step) => BigInt(step.stepCap)),
    pocketCapBps: input.plan.pocketCapBps,
    planCap: BigInt(input.plan.cap),
  });
  if (funded > 0n && !(await chain.isFunded(pocket))) {
    const transaction =
      phaseTransaction(trace, "pocket.fund.sent") ??
      (await signVaultCall(dependencies, input.vault, "fundPocket", {
        pocket,
        amount: funded.toString(),
      }));
    assertLeaseHeld();
    await recordPhase(dependencies, input, attempt, "pocket.fund.sent", {
      pocket,
      amount: String(funded),
      transaction,
    });
    const txHash = await chain.fundPocket({ pocket, amount: funded, transaction });
    await recordPhase(dependencies, input, attempt, "pocket.funded", {
      pocket,
      amount: String(funded),
      txHash,
    });
  }
  return { pocket, funded: funded.toString() };
}

async function prepareDelegate(
  input: PocketPreparationInput,
  dependencies: PocketPreparationDependencies,
  pocket: Address,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<void> {
  if (await dependencies.chain.isDelegateReady({ pocket, vault: input.vault })) return;
  const trace = await getExecutionTrace(dependencies.pool, input.planId, 0, attempt);
  let transaction = phaseTransaction(trace, "pocket.delegate.sent");
  if (!transaction) {
    const signed = await dependencies.signer.sign("cz-15", {
      keyId: `K4:${pocket}`,
      kind: "pocket-delegate",
      payload: { pocket, vault: input.vault },
    });
    if (!("signedTransaction" in signed))
      throw new Error("K4 did not return a delegate transaction.");
    transaction = signed.signedTransaction;
  }
  assertLeaseHeld();
  await recordPhase(dependencies, input, attempt, "pocket.delegate.sent", {
    pocket,
    transaction,
  });
  const txHash = await dependencies.chain.addDelegate({
    pocket,
    vault: input.vault,
    transaction,
  });
  await recordPhase(dependencies, input, attempt, "pocket.delegate", { pocket, txHash });
}

async function signVaultCall(
  dependencies: PocketPreparationDependencies,
  vault: Address,
  selector: string,
  args: Readonly<Record<string, unknown>>,
): Promise<`0x${string}`> {
  const result = await dependencies.signer.sign("cz-15", {
    keyId: "K3",
    kind: "vault-call",
    payload: { vault, selector, args },
  });
  if (!("signedTransaction" in result)) throw new Error(`K3 did not sign ${selector}.`);
  return result.signedTransaction;
}

function pocketProof(plan: PocketPreparationInput["plan"], pocket: Address): readonly Hash32[] {
  const leaves = plan.payeeLeaves.map((item) =>
    item.kind === PAYEE_KIND.POCKET
      ? pocketLeaf(item.payee as Address)
      : payeeLeaf(item.payee as Address, item.kind, item.stepIndex, BigInt(item.stepCap)),
  );
  const tree = buildTree(leaves);
  const leaf = pocketLeaf(pocket);
  if (
    tree.root.toLowerCase() !== plan.payeeRoot.toLowerCase() ||
    !verifyProof(tree.proof(leaf), tree.root, leaf)
  )
    throw new Error("Plan pocket leaf or payee root failed verification.");
  return tree.proof(leaf);
}

async function recordPhase(
  dependencies: PocketPreparationDependencies,
  input: PocketPreparationInput,
  attempt: number,
  phase: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: firstGatewayStepIndex(input.plan.steps),
    attempt,
    phase,
    payload,
  });
}

function firstGatewayStepIndex(steps: PocketPreparationInput["plan"]["steps"]): number {
  const index = steps.find((step) => step.kind === "gateway-nano")?.stepIndex;
  if (index === undefined) throw new Error("Pocket plan has no gateway-nano step.");
  return index;
}

export async function payGatewaySteps(
  input: PocketNanopaymentInput,
  dependencies: PocketNanopaymentDependencies,
): Promise<void> {
  const workerId = `pocket-pay-${process.pid}-${randomBytes(16).toString("hex")}`;
  const attempt = input.attempt ?? 0;
  const ttl = Number(dependencies.config.get("payer.leaseSeconds"));
  const leased = await acquireExecutorLease(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    ttl,
    dependencies.now,
  );
  if (!leased) throw new Error("Another payer executor holds the envelope lease.");
  const renewal = startExecutorLeaseRenewal(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    ttl,
    dependencies.now,
  );
  try {
    for (const step of input.steps.filter((candidate) => candidate.kind === "gateway-nano")) {
      await payGatewayStep(input, step, dependencies, attempt, renewal.assertHeld);
    }
  } finally {
    await renewal.stop();
    await releaseExecutorLease(dependencies.pool, input.envelopeRef, workerId);
  }
}

async function payGatewayStep(
  input: PocketNanopaymentInput,
  step: Step,
  dependencies: PocketNanopaymentDependencies,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<void> {
  const calls = step.callInputs ?? [];
  for (const call of calls) {
    const trace = await getExecutionTrace(dependencies.pool, input.planId, step.stepIndex, attempt);
    if (trace.some((row) => row.phase === `pocket.paid[${call.callIndex}]`)) continue;
    const request = renderGatewayRequest(step, call.input, call.subjectIndex, input);
    if (!request) {
      await recordGatewayPhase(
        dependencies,
        input,
        step.stepIndex,
        attempt,
        "pocket.dependency-missing",
        {
          index: call.callIndex,
        },
      );
      continue;
    }
    const probe = await dependencies.safeFetch(request.url, request.options);
    if (probe.status !== 402) throw new Error("Gateway seller did not return a payment challenge.");
    const read = readPaymentRequired({
      status: probe.status,
      headers: probe.headers,
      body: new TextDecoder().decode(probe.body),
    });
    if (!read.ok) throw new Error("Gateway seller returned a malformed payment challenge.");
    const choice = selectOffer(read.paymentRequired, {
      network: input.plan.network,
      rail: "gateway",
      stepCap: BigInt(step.stepCap),
      payees: [step.payee, ...(step.alternates ?? [])].filter(isAddress),
      trustedPayees: [],
    });
    if (
      !choice.ok ||
      BigInt(choice.offer.amount) > BigInt(step.stepCap) / BigInt(step.expectedCalls)
    )
      throw new Error("Gateway offer exceeds the approved step cap or payees.");
    await sendGatewayCall(
      input,
      step,
      call.callIndex,
      request,
      read.resource,
      choice.offer,
      dependencies,
      attempt,
      assertLeaseHeld,
      trace,
    );
  }
}

async function sendGatewayCall(
  input: PocketNanopaymentInput,
  step: Step,
  index: number,
  request: RenderedGatewayRequest,
  resource: { readonly url: string; readonly description?: string; readonly mimeType?: string },
  offer: import("@czar/x402").PaymentRequirements,
  dependencies: PocketNanopaymentDependencies,
  attempt: number,
  assertLeaseHeld: () => void,
  trace: Awaited<ReturnType<typeof getExecutionTrace>>,
): Promise<void> {
  const previous = trace.findLast((row) => row.phase === `pocket.auth.signed[${index}]`);
  let payload = previous?.payload["paymentPayload"] as
    | ReturnType<typeof buildExactPaymentPayload>
    | undefined;
  if (!payload) {
    const nonce = toHex(randomBytes(32)) as Hash32;
    const validBefore = BigInt(
      Math.floor(dependencies.now().getTime() / 1000) + offer.maxTimeoutSeconds,
    );
    const signed = await dependencies.signer.sign("cz-15", {
      keyId: `K4:${input.pocket}`,
      kind: "gateway-nano",
      payload: {
        pocket: input.pocket,
        payTo: offer.payTo,
        amount: offer.amount,
        validBefore: validBefore.toString(),
        nonce,
      },
    });
    if (!("signature" in signed))
      throw new Error("K4 did not return a Gateway authorization signature.");
    payload = buildExactPaymentPayload({
      resource,
      accepted: offer,
      authorization: {
        from: input.pocket,
        to: offer.payTo,
        value: offer.amount,
        validAfter: "0",
        validBefore: validBefore.toString(),
        nonce,
      },
      signature: signed.signature,
    });
    await recordGatewayPhase(
      dependencies,
      input,
      step.stepIndex,
      attempt,
      `pocket.auth.signed[${index}]`,
      {
        index,
        paymentPayload: payload,
        nonce,
      },
    );
  }
  assertLeaseHeld();
  const headers = {
    ...request.options.headers,
    "payment-signature": encodePaymentSignature(payload),
  };
  const response = await fetchWithPaymentRetry(
    input,
    step.stepIndex,
    index,
    request,
    headers,
    payload.payload.authorization.nonce,
    offer.maxTimeoutSeconds,
    dependencies,
    attempt,
    assertLeaseHeld,
  );
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Gateway nanopayment failed with HTTP ${response.status}.`);
  const transferId = readTransferId(response.headers);
  const paymentRef: PaymentRef = {
    schemaVersion: "1.0",
    rail: "gateway-batched",
    network: input.plan.network,
    payer: input.pocket,
    payTo: payload.payload.authorization.to as Address,
    amount: payload.payload.authorization.value,
    nonce: payload.payload.authorization.nonce as Hash32,
    ...(transferId ? { transferId } : {}),
  };
  await recordGatewayPhase(dependencies, input, step.stepIndex, attempt, `pocket.paid[${index}]`, {
    index,
    state: "pending",
    nonce: payload.payload.authorization.nonce,
    paymentRef,
    ...(transferId ? { transferId } : {}),
  });
}

async function fetchWithPaymentRetry(
  input: PocketNanopaymentInput,
  stepIndex: number,
  callIndex: number,
  request: RenderedGatewayRequest,
  headers: Readonly<Record<string, string>>,
  nonce: string,
  maxTimeoutSeconds: number,
  dependencies: PocketNanopaymentDependencies,
  attempt: number,
  assertLeaseHeld: () => void,
): ReturnType<SafeFetch> {
  const retryLimit = Number(dependencies.config.get("payer.callRetries"));
  const timeoutMs = Math.min(
    Number(dependencies.config.get("payer.callTimeoutMs")),
    maxTimeoutSeconds * 1000,
  );
  let lastError: unknown;
  for (let retry = 0; retry <= retryLimit; retry += 1) {
    await recordGatewayPhase(
      dependencies,
      input,
      stepIndex,
      attempt,
      `pocket.pay.sent[${callIndex}]`,
      {
        index: callIndex,
        nonce,
        retry,
      },
    );
    assertLeaseHeld();
    try {
      const response = await dependencies.safeFetch(request.url, {
        ...request.options,
        headers,
        timeoutMs,
      });
      if (response.status >= 200 && response.status < 300) return response;
      if (response.status === 409) {
        lastError = new Error(`Gateway rejected authorization index ${callIndex} with HTTP 409.`);
        break;
      }
      lastError = new Error(`Gateway nanopayment failed with HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("Gateway nanopayment failed after configured retries.");
}

interface RenderedGatewayRequest {
  readonly url: string;
  readonly options: NonNullable<Parameters<SafeFetch>[1]>;
}

function renderGatewayRequest(
  step: Step,
  values: Readonly<Record<string, string | number | boolean>>,
  subjectIndex: number | undefined,
  input: PocketNanopaymentInput,
): RenderedGatewayRequest | null {
  const resolved = { ...values };
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value !== "string") continue;
    const dependency = /^\{\{dep\.(\d+)\.([a-zA-Z0-9_-]+)\}\}$/.exec(value);
    if (!dependency) continue;
    const found = input.acceptedDependencies
      ?.find(
        (item) =>
          item.accepted &&
          item.stepIndex === Number(dependency[1]) &&
          item.subjectIndex === subjectIndex,
      )
      ?.fields.find((field) => field.name === dependency[2] && field.value.trim() !== "");
    if (!found) return null;
    resolved[key] = found.value;
  }
  if (!step.resource) return null;
  const url = new URL(step.resource.url);
  const method = step.resource.method;
  if (method === "GET") {
    for (const [key, value] of Object.entries(resolved)) url.searchParams.set(key, String(value));
  }
  return {
    url: url.href,
    options: {
      method,
      headers: method === "GET" ? {} : { "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: new TextEncoder().encode(JSON.stringify(resolved)) }),
    },
  };
}

function phaseTransaction(
  trace: readonly { readonly phase: string; readonly payload: Readonly<Record<string, unknown>> }[],
  phase: string,
): `0x${string}` | undefined {
  const transaction = trace.findLast((row) => row.phase === phase)?.payload["transaction"];
  return typeof transaction === "string" ? (transaction as `0x${string}`) : undefined;
}

export async function refreshGatewayStatuses(
  input: PocketNanopaymentInput,
  dependencies: PocketNanopaymentDependencies,
): Promise<("pending" | "completed")[]> {
  const attempt = input.attempt ?? 0;
  const statuses: ("pending" | "completed")[] = [];
  for (const step of input.steps.filter((candidate) => candidate.kind === "gateway-nano")) {
    const trace = await getExecutionTrace(dependencies.pool, input.planId, step.stepIndex, attempt);
    for (const paid of trace.filter((row) => row.phase.startsWith("pocket.paid["))) {
      const nonce = paid.payload["nonce"];
      if (typeof nonce !== "string") throw new Error("Gateway payment trace has no nonce.");
      const transferId = paid.payload["transferId"];
      const state = await dependencies.gatewayStatus({
        pocket: input.pocket,
        nonce: nonce as Hash32,
        ...(typeof transferId === "string" ? { transferId } : {}),
      });
      await recordGatewayPhase(dependencies, input, step.stepIndex, attempt, "pocket.status", {
        index: paid.payload["index"],
        state,
      });
      statuses.push(state);
    }
  }
  return statuses;
}

async function recordGatewayPhase(
  dependencies: PocketNanopaymentDependencies,
  input: PocketNanopaymentInput,
  stepIndex: number,
  attempt: number,
  phase: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex,
    attempt,
    phase,
    payload,
  });
}

function readTransferId(headers: Readonly<Record<string, string>>): string | undefined {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === "payment-response");
  if (!key) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(headers[key] as string, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    return typeof value["transferId"] === "string" ? value["transferId"] : undefined;
  } catch {
    return undefined;
  }
}

function isAddress(value: string | undefined): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}
