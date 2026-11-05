// Signer policy (CZ-27 §5.2): rebuild every digest or call from structured fields, check it against the
// projections, and refuse anything else. A refusal names its rule; nothing is signed.
import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  toBytes,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { ARC_TESTNET_CHAIN_ID } from "@czar/config";
import {
  addressToBytes32,
  autonomyRaiseDigest,
  briefRequestDigest,
  burnIntentDigest,
  deliverableUploadDigest,
  derivedNonce,
  jobKey as jobKeyOf,
  KIND_TAGS,
  POCKET_STEP_INDEX,
  receiptAttestationDigest,
  receiptStructHash,
  toTypedDataHash,
  domainSeparator,
  paymentRefHash,
  transferWithAuthorizationStructHash,
  USDC_ADDRESS,
  usdcTransferWithAuthorizationDigest,
  type Address,
  type Domain,
  type Hash32,
  type SlReceipt,
} from "@czar/hashing";
import {
  FACTORY_SELECTORS,
  GATEWAY_MINTER_ABI,
  GATEWAY_WALLET_ABI,
  JOB_ESCROW_ABI,
  JOB_ESCROW_PROVIDER_ABI,
  K3_ALLOWED,
  K3_NEVER,
  K3_SPENDING,
  OEL_ABI,
  RELAYER_VAULT_ALLOWED,
  selectorOf,
  USDC_ABI,
  VAULT_ABI,
  type VaultFunctionName,
} from "./abi.ts";
import { PROVIDER_KEY_IDS, type KeyId, type Kind, type ProviderKeyId } from "./kinds.ts";
import type { SpendRecord } from "./pending.ts";
import type { OverdueManualReturnFacts, Projection } from "./projection.ts";
import type { PaymentRef } from "@czar/schemas";
import { coerceArgs, type ProviderAction, type ShapeError } from "./requests.ts";

/** The key a request is signed with, as the service resolved it (its id and its backend address). */
export interface SigningKey {
  readonly keyId: KeyId;
  readonly address: Address;
}

export class Denied extends Error {
  readonly rule: string;
  constructor(rule: string) {
    super(`kms_denied: ${rule}`);
    this.rule = rule;
    this.name = "Denied";
  }
}

const deny = (rule: string): never => {
  throw new Denied(rule);
};

/** Chain constants the signer pins (spec 00, 03 `czar-vault.md` §6.2). */
export interface SignerNetwork {
  readonly chainId: number;
  readonly usdc: Address;
  readonly gatewayWallet: Address;
  readonly gatewayMinter: Address;
  readonly gatewayDomain: number;
  readonly jobEscrow: Address;
  readonly openEvidenceLog: Address;
  /** EIP-712 domain of Gateway batched (nanopayment) authorizations (`GatewayWalletBatched` v1, G2). */
  readonly nanoDomain: Domain;
  /** Merchant services a K10 key may sign seller proofs for. */
  readonly merchantServices: readonly string[];
}

export interface PolicyContext {
  readonly projection: Projection;
  readonly network: SignerNetwork;
  /** Unix seconds. */
  readonly now: () => number;
  readonly freezeStateMaxAgeSec: number;
  readonly gatewayWriteOffMaxAtomic: bigint;
  /** Addresses of the server keys, for checks that name them (K7 evaluator, K8 publisher, gas targets). */
  readonly keyAddress: (key: "K3" | "K7" | "K8") => Address;
  readonly merchantKeyAddress: (service: string) => Address;
  /** `signer.gas.<key>.maxAtomic` for the gas-refill targets. */
  readonly gasMaxAtomic: Readonly<Record<"K3" | "K7" | "K8", bigint>>;
  /**
   * SCR-152 `gasReserve` of a `pocket-return` of `amount` USDC from `pocket` to `vault`, from the transaction the
   * signer would prepare for it.
   */
  readonly pocketReturnGasReserve: (
    pocket: Address,
    vault: Address,
    amount: bigint,
  ) => Promise<bigint>;
}

/** 18-decimal native units per 6-decimal USDC unit on Arc (A1-05). */
export const NATIVE_PER_USDC_ATOMIC = 10n ** 12n;

/** On Arc gas is paid in USDC: the native balance and USDC `balanceOf` are one ledger (A1-05, SCR-152). */
export const usdcPaysGas = (network: SignerNetwork): boolean => eq(network.usdc, USDC_ADDRESS);

/** SCR-152: `ceil(gas × maxFeePerGas / 10^12)` of a prepared transaction, in USDC atomic units. */
export function gasReserveAtomic(
  tx: Pick<TransactionSerializableEIP1559, "gas" | "maxFeePerGas">,
): bigint {
  if (tx.gas === undefined || tx.maxFeePerGas === undefined)
    throw new Error("prepared transaction has no gas or maxFeePerGas");
  return (tx.gas * tx.maxFeePerGas + NATIVE_PER_USDC_ATOMIC - 1n) / NATIVE_PER_USDC_ATOMIC;
}

/**
 * A one-unit transfer: its gas estimate never exceeds a nonzero balance, and its calldata has the fewest nonzero
 * bytes, so its `gasReserve` is the smallest any `pocket-return` from the pocket can have.
 */
const PROBE_RETURN_ATOMIC = 1n;

/**
 * SCR-152 §1 `returnable = balance − gasReserve`, where `gasReserve` is that of the transfer of the returnable value
 * itself: `reserveFor(amount)` prepares a `pocket-return` of `amount` and returns its `gasReserve`. The one-unit
 * probe bounds the value (`ceiling`); the transfer of the ceiling gives the reserve. A result `≤ 0` means empty (§2).
 */
export async function returnableAtomic(
  usdc: bigint,
  reserveFor: (amount: bigint) => Promise<bigint>,
): Promise<{ readonly ceiling: bigint; readonly returnable: bigint }> {
  if (usdc === 0n) return { ceiling: 0n, returnable: 0n };
  const ceiling = usdc - (await reserveFor(PROBE_RETURN_ATOMIC));
  if (ceiling <= 0n) return { ceiling, returnable: ceiling };
  return { ceiling, returnable: usdc - (await reserveFor(ceiling)) };
}

/**
 * SCR-152 §2: the pocket EOA is empty when nothing is returnable at the current fee. Where gas is not USDC, only a
 * zero USDC balance is empty.
 */
export async function pocketEmpty(
  ctx: PolicyContext,
  pocket: Address,
  vault: Address,
  usdc: bigint,
): Promise<boolean> {
  if (usdc === 0n) return true;
  if (!usdcPaysGas(ctx.network)) return false;
  const { returnable } = await returnableAtomic(usdc, (amount) =>
    ctx.pocketReturnGasReserve(pocket, vault, amount),
  );
  return returnable <= 0n;
}

/** Ids the audit row records; never payloads or text (CZ-27 §5.2, §8). */
export interface PurposeIds {
  envelopeRef?: string;
  reservationId?: string;
  pullbackId?: string;
  jobKey?: string;
  batchId?: string;
}

export type Decision =
  | {
      readonly type: "digest";
      readonly digest: Hash32;
      /** Wraps the 65-byte signature in the vault envelope (02 §6.3), when the kind has one. */
      readonly wrap?: (signature: Hex) => Hex;
      readonly purpose: PurposeIds;
      /** SCR-180 §2: what the signed audit row records so the signature counts as pending. */
      readonly spend?: SpendRecord;
    }
  | {
      readonly type: "transaction";
      readonly to: Address;
      readonly data: Hex;
      readonly value: bigint;
      readonly purpose: PurposeIds;
      readonly rule?: "writeoff-manual-return-overdue";
      readonly alert?: WriteOffAlert;
      /** Checks the prepared transaction before it is signed; throws `Denied` to refuse it. */
      readonly checkPrepared?: (tx: TransactionSerializableEIP1559) => void;
    };

/** Public, non-sensitive context for the stale-Gateway write-off alert. */
export interface WriteOffAlert {
  readonly name: "writeoff-overdue-stale-gateway";
  readonly vault: Address;
  readonly pocket: Address;
  readonly apiObservedAt: number | null;
}

/** Parsed request fields (requests.ts); each kind uses a subset. */
type Req = {
  readonly action?: unknown;
  readonly target?: unknown;
  readonly step?: unknown;
  readonly selector?: unknown;
  readonly report?: unknown;
  readonly paymentRef?: unknown;
  readonly receipt?: unknown;
  readonly pullbackId?: unknown;
  readonly args?: unknown;
  readonly amount?: unknown;
  readonly bodyHash?: unknown;
  readonly categoryId?: unknown;
  readonly deadline?: unknown;
  readonly decision?: unknown;
  readonly escrow?: unknown;
  readonly expiry?: unknown;
  readonly index?: unknown;
  readonly jobId?: unknown;
  readonly kind?: unknown;
  readonly method?: unknown;
  readonly network?: unknown;
  readonly newLimit?: unknown;
  readonly nonce?: unknown;
  readonly payTo?: unknown;
  readonly periodId?: unknown;
  readonly pocket?: unknown;
  readonly prev?: unknown;
  readonly purpose?: unknown;
  readonly reportHash?: unknown;
  readonly reservationId?: unknown;
  readonly root?: unknown;
  readonly service?: unknown;
  readonly to?: unknown;
  readonly uri?: unknown;
  readonly uriHash?: unknown;
  readonly validBefore?: unknown;
  readonly value?: unknown;
  readonly vault?: unknown;
};
const ZERO32: Hash32 = `0x${"0".repeat(64)}`;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function requireNotFrozen(
  ctx: PolicyContext,
  vault: Address,
  options: { includePause: boolean },
): Promise<void> {
  const state = await ctx.projection.freezeState(vault);
  if (state === undefined) deny("frozen");
  const { frozen, guardianPaused, observedAt } = state as NonNullable<typeof state>;
  if (ctx.now() - observedAt > ctx.freezeStateMaxAgeSec) deny("frozen");
  if (frozen || (options.includePause && guardianPaused)) deny("frozen");
}

function resolveVaultFunction(selector: string): VaultFunctionName {
  if (/^0x[0-9a-fA-F]{8}$/.test(selector)) {
    const lower = selector.toLowerCase() as Hex;
    if (FACTORY_SELECTORS.has(lower)) deny("never-signable");
    const fn = VAULT_ABI.find((item) => selectorOf(VAULT_ABI, item.name) === lower);
    if (fn === undefined) deny("selector-not-allowed");
    return (fn as (typeof VAULT_ABI)[number]).name;
  }
  const fn = VAULT_ABI.find((item) => item.name === selector);
  if (fn === undefined) deny("selector-not-allowed");
  return selector as VaultFunctionName;
}

function encodeVault(name: VaultFunctionName, args: unknown): { data: Hex; values: unknown[] } {
  const fn = VAULT_ABI.find((item) => item.name === name) as (typeof VAULT_ABI)[number];
  const values = coerceArgs(fn.inputs, args);
  const data = encodeFunctionData({
    abi: VAULT_ABI,
    functionName: name,
    args: values as never,
  });
  return { data, values };
}

async function planLeaf(
  ctx: PolicyContext,
  vault: Address,
  envelopeId: bigint,
  match: { stepIndex: number; payee: Address; kind: number; stepCap?: bigint },
) {
  // SCR-180 §2: calls this signer signed that the indexer has not seen used yet. Read before the indexed
  // count, so an authorization indexed in between is counted twice (refuses) rather than not at all.
  const pendingCalls = await ctx.projection.pendingCalls(
    vault,
    envelopeId,
    match.stepIndex,
    ctx.now(),
  );
  const envelope = await ctx.projection.envelope(vault, envelopeId);
  if (envelope === undefined || envelope.state !== "Open") deny("envelope-not-open");
  const leaf = (envelope as NonNullable<typeof envelope>).leaves.find(
    (candidate) =>
      candidate.stepIndex === match.stepIndex &&
      eq(candidate.payee, match.payee) &&
      candidate.kind === match.kind &&
      (match.stepCap === undefined || candidate.stepCap === match.stepCap),
  );
  if (leaf === undefined) deny("leaf-not-in-plan");
  const found = leaf as NonNullable<typeof leaf>;
  if (found.usedCalls + pendingCalls >= found.expectedCalls) deny("expected-calls-used");
  return found;
}

const AGENT_POCKET_CAP_BPS = 2500;

async function vaultCall(ctx: PolicyContext, req: Req): Promise<Decision> {
  const vault = req.vault as Address;
  const name = resolveVaultFunction(req.selector as string);
  if (K3_NEVER.includes(name)) deny("never-signable");
  if (!K3_ALLOWED.includes(name)) deny("selector-not-allowed");
  if (!(await ctx.projection.isVault(vault))) deny("unknown-vault");
  if (K3_SPENDING.has(name)) await requireNotFrozen(ctx, vault, { includePause: true });
  let encoded: ReturnType<typeof encodeVault>;
  try {
    encoded = encodeVault(name, req.args);
  } catch (error) {
    if ((error as ShapeError).name === "ShapeError") deny("shape");
    throw error;
  }
  const { data, values } = encoded;
  const purpose: PurposeIds = {};
  let rule: "writeoff-manual-return-overdue" | undefined;
  let alert: WriteOffAlert | undefined;

  switch (name) {
    case "openEnvelope": {
      const p = values[0] as readonly [
        bigint,
        bigint,
        number,
        bigint,
        Hash32,
        Hash32,
        Hash32,
        Hash32,
      ];
      const [
        cap,
        maxStepAmount,
        pocketCapBps,
        expiresAt,
        categoryId,
        objectiveHash,
        planHashValue,
        payeeRoot,
      ] = p;
      const plan = await ctx.projection.storedPlan(vault, planHashValue);
      if (plan === undefined) deny("plan-mismatch");
      const stored = plan as NonNullable<typeof plan>;
      const same =
        stored.cap === cap &&
        stored.maxStepAmount === maxStepAmount &&
        stored.pocketCapBps === pocketCapBps &&
        stored.expiresAt === expiresAt &&
        eq(stored.categoryId, categoryId) &&
        eq(stored.objectiveHash, objectiveHash) &&
        eq(stored.payeeRoot, payeeRoot);
      if (!same) deny("plan-mismatch");
      if (stored.approval !== "auto-approvable") deny("plan-not-auto-approvable");
      if (pocketCapBps !== (stored.hasNanoStep ? AGENT_POCKET_CAP_BPS : 0)) deny("pocket-cap-bps");
      purpose.envelopeRef = planHashValue;
      break;
    }
    case "reserve":
    case "reserveWithDigests": {
      const [envelopeId, stepIndex, payee, stepCap] = values as [bigint, number, Address, bigint];
      await planLeaf(ctx, vault, envelopeId, { stepIndex, payee, kind: 1, stepCap });
      purpose.envelopeRef = envelopeId.toString();
      break;
    }
    case "openJob": {
      const [envelopeId, stepIndex, provider, stepCap] = values as [
        bigint,
        number,
        Address,
        bigint,
      ];
      await planLeaf(ctx, vault, envelopeId, { stepIndex, payee: provider, kind: 2, stepCap });
      purpose.envelopeRef = envelopeId.toString();
      break;
    }
    case "registerPocket": {
      const [envelopeId, pocket] = values as [bigint, Address];
      await planLeaf(ctx, vault, envelopeId, {
        stepIndex: POCKET_STEP_INDEX,
        payee: pocket,
        kind: 4,
      });
      purpose.envelopeRef = envelopeId.toString();
      break;
    }
    case "writeOffPocket": {
      const [pocket] = values as [Address];
      const view = await ctx.projection.pocket(pocket);
      if (view === undefined || !eq(view.vault, vault)) deny("unknown-pocket");
      if ((view as NonNullable<typeof view>).slowWithdrawalOpen) deny("slow-withdrawal-open");
      if ((view as NonNullable<typeof view>).pendingPullback > 0n) deny("pending-pullback");
      const balances = await ctx.projection.pocketBalances(pocket);
      if (balances.gatewayApiFresh && balances.gatewayAvailable > ctx.gatewayWriteOffMaxAtomic)
        deny("gateway-balance-not-dust");
      if (!balances.gatewayApiFresh) {
        const readFacts = ctx.projection.overdueManualReturnFacts;
        if (readFacts === undefined) throw new Denied("gateway-balance-stale");
        const facts = await readFacts(pocket, vault, ctx.now());
        if (!allOverdueManualReturnFacts(facts)) deny("gateway-balance-stale");
        if (!(await pocketEmpty(ctx, pocket, vault, balances.usdc))) deny("gateway-balance-stale");
        rule = "writeoff-manual-return-overdue";
        alert = {
          name: "writeoff-overdue-stale-gateway",
          vault,
          pocket,
          apiObservedAt: balances.gatewayApiObservedAt,
        };
      }
      break;
    }
    default:
      break;
  }
  return {
    type: "transaction",
    to: vault,
    data,
    value: 0n,
    purpose,
    ...(rule === undefined ? {} : { rule }),
    ...(alert === undefined ? {} : { alert }),
  };
}

function allOverdueManualReturnFacts(facts: OverdueManualReturnFacts): boolean {
  return (
    facts.pocketStateValid &&
    facts.envelopeOpen &&
    facts.pendingPullbackZero &&
    facts.gatewayWithdrawingZero &&
    facts.slowWithdrawAudited &&
    facts.pocketReturnAudited &&
    facts.manualReturnRowValid &&
    facts.returnReceiptValid &&
    facts.returnOverdue &&
    !facts.manualReturnRecordedAfter
  );
}

async function usdc3009(ctx: PolicyContext, req: Req): Promise<Decision> {
  const vault = req.vault as Address;
  const reservationId = req.reservationId as bigint;
  const index = req.index as number;
  const to = req.to as Address;
  const value = req.value as bigint;
  const validBefore = req.validBefore as bigint;
  await requireNotFrozen(ctx, vault, { includePause: true });
  const reservation = await ctx.projection.reservation(vault, reservationId);
  if (reservation === undefined) deny("unknown-reservation");
  const r = reservation as NonNullable<typeof reservation>;
  if (r.state !== "Active") deny("reservation-not-active");
  if (!eq(r.payee, to)) deny("payee-mismatch");
  if (r.unitAmount !== value) deny("amount-mismatch");
  if (index >= r.count) deny("index-out-of-range");
  if (r.validBefore !== validBefore) deny("valid-before-mismatch");
  const nonce = derivedNonce(vault, reservationId, index);
  const digest = usdcTransferWithAuthorizationDigest(ctx.network.chainId, {
    from: vault,
    to,
    value,
    validAfter: 0n,
    validBefore,
    nonce,
  });
  const wrap = (agentSig: Hex): Hex =>
    encodeAbiParameters(
      [
        "bytes32",
        "uint64",
        "uint32",
        "address",
        "uint256",
        "uint256",
        "uint256",
        "bytes32",
        "bytes",
      ].map((type) => ({ type })),
      [KIND_TAGS.USDC_3009, reservationId, index, to, value, 0n, validBefore, nonce, agentSig],
    );
  // SCR-180 §2: one call of the reservation's step, pending until the indexer sees the nonce used.
  const spend: SpendRecord = {
    kind: "usdc-3009",
    vault,
    nonce,
    validBefore,
    envelopeId: r.envelopeId,
    stepIndex: r.stepIndex,
    amount: value,
  };
  return {
    type: "digest",
    digest,
    wrap,
    purpose: { reservationId: reservationId.toString() },
    spend,
  };
}

async function gatewayBurn(ctx: PolicyContext, req: Req): Promise<Decision> {
  const vault = req.vault as Address;
  const pullbackId = req.pullbackId as bigint;
  const pullback = await ctx.projection.pullback(vault, pullbackId);
  if (pullback === undefined) deny("unknown-pullback");
  const p = pullback as NonNullable<typeof pullback>;
  if (p.state !== "Pending") deny("pullback-not-pending");
  if ((await ctx.projection.blockNumber()) > p.maxBlockHeight) deny("pullback-expired");
  const { network } = ctx;
  const digest = burnIntentDigest({
    maxBlockHeight: p.maxBlockHeight,
    maxFee: p.maxFee,
    spec: {
      version: 1,
      sourceDomain: network.gatewayDomain,
      destinationDomain: network.gatewayDomain,
      sourceContract: addressToBytes32(network.gatewayWallet),
      destinationContract: addressToBytes32(network.gatewayMinter),
      sourceToken: addressToBytes32(network.usdc),
      destinationToken: addressToBytes32(network.usdc),
      sourceDepositor: addressToBytes32(p.pocket),
      destinationRecipient: addressToBytes32(vault),
      sourceSigner: addressToBytes32(vault),
      destinationCaller: ZERO32,
      value: p.value,
      salt: p.salt,
      hookData: "0x",
    },
  });
  const wrap = (agentSig: Hex): Hex =>
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes" }],
      [KIND_TAGS.GATEWAY_BURN, pullbackId, agentSig],
    );
  return { type: "digest", digest, wrap, purpose: { pullbackId: pullbackId.toString() } };
}

const RECEIPT_TUPLE = {
  type: "tuple",
  components: [
    { name: "paymentRefHash", type: "bytes32" },
    { name: "requestCommit", type: "bytes32" },
    { name: "responseCommit", type: "bytes32" },
    { name: "statusCode", type: "uint16" },
    { name: "originAsserted", type: "string" },
    { name: "requirementsHashSeen", type: "bytes32" },
    { name: "tRequest", type: "uint64" },
    { name: "tPaymentSigned", type: "uint64" },
    { name: "tComplete", type: "uint64" },
    { name: "outcome", type: "uint8" },
    { name: "localChecksCommit", type: "bytes32" },
    { name: "disclosure", type: "uint8" },
    { name: "createdAt", type: "uint64" },
  ],
} as const;

async function slReceipt(ctx: PolicyContext, req: Req): Promise<Decision> {
  const vault = req.vault as Address;
  const receipt = req.receipt as unknown as SlReceipt;
  const paymentRef = req.paymentRef as PaymentRef;
  if (!eq(paymentRefHash(paymentRef), receipt.paymentRefHash)) deny("payment-ref-mismatch");
  if (paymentRef.network !== `eip155:${ctx.network.chainId}`) deny("payment-not-settled");
  if (paymentRef.rail === "x402-exact" && !eq(paymentRef.asset, ctx.network.usdc))
    deny("payment-not-settled");
  if (!(await ctx.projection.isVault(vault))) deny("unknown-vault");
  if (!(await paymentRefBelongsToVault(ctx, vault, paymentRef))) deny("payment-not-this-vault");
  if (!(await ctx.projection.settledPayment(vault, paymentRef))) deny("payment-not-settled");
  const digest = receiptAttestationDigest(ctx.network.chainId, vault, receiptStructHash(receipt));
  const wrap = (agentSig: Hex): Hex =>
    encodeAbiParameters(
      [{ type: "bytes32" }, RECEIPT_TUPLE, { type: "bytes" }],
      [KIND_TAGS.SL_RECEIPT, receipt as never, agentSig],
    );
  return { type: "digest", digest, wrap, purpose: {} };
}

async function paymentRefBelongsToVault(
  ctx: PolicyContext,
  vault: Address,
  paymentRef: PaymentRef,
): Promise<boolean> {
  switch (paymentRef.rail) {
    case "x402-exact":
      return eq(paymentRef.payer, vault);
    case "gateway-batched": {
      const pocket = await ctx.projection.pocket(paymentRef.payer as Address);
      return pocket !== undefined && eq(pocket.vault, vault);
    }
    case "erc8183-job":
      return eq(paymentRef.client, vault);
    case "mpp":
      return false;
  }
}

async function autonomyRaise(ctx: PolicyContext, req: Req): Promise<Decision> {
  const vault = req.vault as Address;
  const categoryId = req.categoryId as Hash32;
  const newLimit = req.newLimit as bigint;
  await requireNotFrozen(ctx, vault, { includePause: false });
  const view = await ctx.projection.autonomy(vault, categoryId);
  if (view === undefined) deny("unknown-category");
  const a = view as NonNullable<typeof view>;
  if (newLimit <= a.autoLimit) deny("not-a-raise");
  if (newLimit > a.userMax) deny("above-user-max");
  if (newLimit > a.maxStepTo) deny("above-step");
  if (ctx.now() - a.lastRaiseAt < a.periodLength) deny("too-soon");
  const digest = autonomyRaiseDigest(ctx.network.chainId, vault, {
    category: categoryId,
    newLimit,
    periodId: req.periodId as bigint,
    nonce: a.nonce,
    deadline: req.deadline as bigint,
  });
  return { type: "digest", digest, purpose: {} };
}

async function evaluatorCall(ctx: PolicyContext, req: Req): Promise<Decision> {
  const escrow = req.escrow as Address;
  const jobId = req.jobId as bigint;
  const decision = req.decision as "complete" | "reject";
  const reportHash = req.reportHash as Hash32;
  if (!eq(escrow, ctx.network.jobEscrow)) deny("unknown-escrow");
  const job = await ctx.projection.job(escrow, jobId);
  if (job === undefined) deny("unknown-job");
  const j = job as NonNullable<typeof job>;
  if (!eq(j.evaluator, ctx.keyAddress("K7"))) deny("not-evaluator");
  if (!(await ctx.projection.reportExists(reportHash))) deny("unknown-report");
  // A reject refunds the vault, so it is always allowed; complete pays out (D72).
  if (decision === "complete") await requireNotFrozen(ctx, j.clientVault, { includePause: true });
  const data = encodeFunctionData({
    abi: JOB_ESCROW_ABI,
    functionName: decision,
    args: [jobId, reportHash, "0x"],
  });
  return { type: "transaction", to: escrow, data, value: 0n, purpose: {} };
}

const VALIDATION_REPORT_TYPES = {
  ValidationReport: [
    { name: "obsId", type: "bytes32" },
    { name: "profileId", type: "bytes32" },
    { name: "methodVersion", type: "bytes32" },
    { name: "assignmentKind", type: "uint8" },
    { name: "saltCommit", type: "bytes32" },
    { name: "checksCommit", type: "bytes32" },
    { name: "createdAt", type: "uint64" },
  ],
} as const;

async function slValidationReport(ctx: PolicyContext, req: Req): Promise<Decision> {
  const report = req.report as Record<string, unknown>;
  if (!(await ctx.projection.checksCommitExists(report["checksCommit"] as Hash32)))
    deny("unknown-checks-commit");
  const digest = hashTypedData({
    domain: { name: "SelectionLayer", version: "1", chainId: ctx.network.chainId },
    types: VALIDATION_REPORT_TYPES,
    primaryType: "ValidationReport",
    message: report as never,
  });
  return { type: "digest", digest, purpose: {} };
}

async function oelCommit(ctx: PolicyContext, req: Req): Promise<Decision> {
  const kind = req.kind as number;
  const root = req.root as Hash32;
  const uri = req.uri as string;
  const latest = await ctx.projection.latestEvidenceRoot(ctx.keyAddress("K8"), kind);
  if (!eq(latest, req.prev as string)) deny("prev-mismatch");
  if (!(await ctx.projection.evidenceBatchExists(root))) deny("unknown-batch");
  if (uri !== `czar-archive:${root}`) deny("uri-mismatch");
  if (!eq(keccak256(toBytes(uri)), req.uriHash as string)) deny("uri-hash-mismatch");
  const data = encodeFunctionData({
    abi: OEL_ABI,
    functionName: "commit",
    args: [kind, root, req.prev as Hash32, req.uriHash as Hash32, uri],
  });
  return {
    type: "transaction",
    to: ctx.network.openEvidenceLog,
    data,
    value: 0n,
    purpose: { batchId: root },
  };
}

/** Facilitator keyless-trial proof lifetime (p1-F4, spec 00 F4). */
export const SELLER_PROOF_LIFETIME_SEC = 300;

const SELLER_REQUEST_TYPES = {
  SellerRequest: [
    { name: "purpose", type: "string" },
    { name: "method", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "network", type: "string" },
    { name: "payTo", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

async function merchantSellerProof(ctx: PolicyContext, req: Req): Promise<Decision> {
  const network = `eip155:${ctx.network.chainId}`;
  if (req.network !== network) deny("wrong-network");
  if (!ctx.network.merchantServices.includes(req.service as string)) deny("unknown-service");
  const expiresAt = req.expiry as bigint;
  const now = BigInt(ctx.now());
  if (expiresAt <= now || expiresAt - now > BigInt(SELLER_PROOF_LIFETIME_SEC))
    deny("expiry-out-of-range");
  const digest = hashTypedData({
    domain: {
      name: "Circle Facilitator Seller Request",
      version: "1",
      chainId: ctx.network.chainId,
    },
    types: SELLER_REQUEST_TYPES,
    primaryType: "SellerRequest",
    message: {
      purpose: req.purpose as string,
      method: req.method as string,
      bodyHash: req.bodyHash as Hash32,
      network,
      payTo: ctx.merchantKeyAddress(req.service as string),
      nonce: req.nonce as Hash32,
      issuedAt: expiresAt - BigInt(SELLER_PROOF_LIFETIME_SEC),
      expiresAt,
    },
  });
  return { type: "digest", digest, purpose: {} };
}

async function activePocket(ctx: PolicyContext, pocket: Address) {
  const view = await ctx.projection.pocket(pocket);
  if (view === undefined) deny("unknown-pocket");
  return view as NonNullable<typeof view>;
}

async function gatewayNano(ctx: PolicyContext, req: Req): Promise<Decision> {
  const pocket = req.pocket as Address;
  const payTo = req.payTo as Address;
  const amount = req.amount as bigint;
  const view = await activePocket(ctx, pocket);
  if (view.state !== "Funded" && view.state !== "Draining") deny("pocket-not-active");
  await requireNotFrozen(ctx, view.vault, { includePause: true });
  const envelope = await ctx.projection.envelope(view.vault, view.envelopeId);
  if (envelope === undefined || envelope.state !== "Open") deny("envelope-not-open");
  const leaf = (envelope as NonNullable<typeof envelope>).leaves.find(
    (candidate) =>
      candidate.kind === 1 && candidate.stepKind === "gateway-nano" && eq(candidate.payee, payTo),
  );
  if (leaf === undefined) deny("payee-not-in-plan");
  const found = leaf as NonNullable<typeof leaf>;
  const validBefore = req.validBefore as bigint;
  const nonce = req.nonce as Hash32;
  // SCR-180 §2: spent = indexed + pending. Pending is read first, so a transfer indexed between the two reads
  // is counted twice (refuses) rather than not at all.
  const pending = await ctx.projection.pendingNanoSpent(pocket, payTo, ctx.now());
  const spent = await ctx.projection.nanoSpent(pocket, payTo);
  if (spent.step + pending.step + amount > found.stepCap) deny("step-cap");
  if (spent.pocket + pending.pocket + amount > view.funded) deny("pocket-funded");
  const digest = toTypedDataHash(
    domainSeparator(ctx.network.nanoDomain),
    transferWithAuthorizationStructHash({
      from: pocket,
      to: payTo,
      value: amount,
      validAfter: 0n,
      validBefore,
      nonce,
    }),
  );
  const spend: SpendRecord = {
    kind: "gateway-nano",
    pocket,
    payTo,
    nonce,
    validBefore,
    envelopeId: view.envelopeId,
    stepIndex: found.stepIndex,
    amount,
  };
  return { type: "digest", digest, purpose: { envelopeRef: view.envelopeId.toString() }, spend };
}

async function pocketDelegate(ctx: PolicyContext, req: Req): Promise<Decision> {
  const view = await activePocket(ctx, req.pocket as Address);
  if (!eq(view.vault, req.vault as string)) deny("wrong-vault");
  const data = encodeFunctionData({
    abi: GATEWAY_WALLET_ABI,
    functionName: "addDelegate",
    args: [ctx.network.usdc, view.vault],
  });
  return { type: "transaction", to: ctx.network.gatewayWallet, data, value: 0n, purpose: {} };
}

async function pocketReturn(ctx: PolicyContext, req: Req): Promise<Decision> {
  const pocket = req.pocket as Address;
  const amount = req.amount as bigint;
  const view = await activePocket(ctx, pocket);
  const balances = await ctx.projection.pocketBalances(pocket);
  // The destination is always the pocket's own vault, never caller-supplied (RV-004, RV-055).
  if (req.kind === "usdc") {
    const data = encodeFunctionData({
      abi: USDC_ABI,
      functionName: "transfer",
      args: [view.vault, amount],
    });
    const decision = {
      type: "transaction",
      to: ctx.network.usdc,
      data,
      value: 0n,
      purpose: {},
    } as const;
    if (!usdcPaysGas(ctx.network)) {
      if (amount > balances.usdc) deny("above-balance");
      return decision;
    }
    // SCR-152 §1: the value must be exactly balance − gasReserve of the transaction about to be signed.
    if (balances.usdc === 0n) deny("pocket-empty");
    const reserveFor = (value: bigint) => ctx.pocketReturnGasReserve(pocket, view.vault, value);
    const ceiling = balances.usdc - (await reserveFor(PROBE_RETURN_ATOMIC));
    if (ceiling <= 0n) deny("pocket-empty");
    if (amount > ceiling) {
      // Above the ceiling no prepared transfer can match, and its estimate may revert: decide without it.
      const { returnable } = await returnableAtomic(balances.usdc, reserveFor);
      deny(returnable <= 0n ? "pocket-empty" : "pocket-return-value-mismatch");
    }
    const checkPrepared = (tx: TransactionSerializableEIP1559) => {
      const returnable = balances.usdc - gasReserveAtomic(tx);
      if (returnable <= 0n) deny("pocket-empty");
      if (amount !== returnable) deny("pocket-return-value-mismatch");
    };
    return { ...decision, checkPrepared };
  }
  if (amount > balances.native) deny("above-balance");
  return { type: "transaction", to: view.vault, data: "0x", value: amount, purpose: {} };
}

async function pocketSlowWithdraw(ctx: PolicyContext, req: Req): Promise<Decision> {
  const pocket = req.pocket as Address;
  const view = await activePocket(ctx, pocket);
  if (req.step === "withdraw") {
    const balances = await ctx.projection.pocketBalances(pocket);
    if (balances.gatewayWithdrawing === 0n) deny("slow-withdrawal-not-open");
    if (balances.currentBlock < balances.withdrawalBlock) deny("slow-withdraw-not-allowed");
  } else {
    const trigger = await ctx.projection.slowWithdrawTrigger(pocket);
    if (trigger === null) deny("slow-withdraw-not-allowed");
    const balances = await ctx.projection.pocketBalances(pocket);
    if (view.slowWithdrawalOpen) deny("slow-withdrawal-open");
    const value = req.value as bigint | undefined;
    if (value === undefined) deny("shape");
    if (balances.gatewayApiObservedAt === null) deny("gateway-figure-missing");
    if (trigger === "api-down" && balances.gatewayAvailable <= 0n)
      deny("slow-withdraw-not-allowed");
    if (!balances.gatewayApiFresh) {
      if (value !== balances.gatewayAvailable) deny("slow-withdraw-value-mismatch");
    } else if (value !== balances.gatewayAvailable) {
      deny("slow-withdraw-value-mismatch");
    }
    if (
      trigger === "api-down" &&
      (await ctx.projection.pocketSpendAfterObservation(
        pocket,
        balances.gatewayApiObservedAt as number,
      ))
    )
      deny("pocket-spend-after-observation");
  }
  const data =
    req.step === "initiate"
      ? encodeFunctionData({
          abi: GATEWAY_WALLET_ABI,
          functionName: "initiateWithdrawal",
          args: [ctx.network.usdc, (req.value as bigint | undefined) ?? deny("shape")],
        })
      : encodeFunctionData({
          abi: GATEWAY_WALLET_ABI,
          functionName: "withdraw",
          args: [ctx.network.usdc],
        });
  return { type: "transaction", to: ctx.network.gatewayWallet, data, value: 0n, purpose: {} };
}

async function relayerTx(ctx: PolicyContext, req: Req): Promise<Decision> {
  const to = req.to as Address;
  const selector = req.selector as string;
  if (eq(to, ctx.network.gatewayMinter)) {
    if (selector !== "gatewayMint") deny("selector-not-allowed");
    const fn = GATEWAY_MINTER_ABI[0];
    let values: unknown[];
    try {
      values = coerceArgs(fn.inputs, req.args);
    } catch {
      return deny("shape");
    }
    const data = encodeFunctionData({
      abi: GATEWAY_MINTER_ABI,
      functionName: "gatewayMint",
      args: values as never,
    });
    return { type: "transaction", to, data, value: 0n, purpose: {} };
  }
  if (!(await ctx.projection.isVault(to))) deny("target-not-allowed");
  const name = resolveVaultFunction(selector);
  if (!RELAYER_VAULT_ALLOWED.includes(name)) deny("selector-not-allowed");
  let data: Hex;
  try {
    data = encodeVault(name, req.args).data;
  } catch {
    return deny("shape");
  }
  return { type: "transaction", to, data, value: 0n, purpose: {} };
}

async function gasRefill(ctx: PolicyContext, req: Req): Promise<Decision> {
  const target = req.target as Address;
  const amount = req.amount as bigint;
  const key = (["K3", "K7", "K8"] as const).find((id) => eq(ctx.keyAddress(id), target));
  if (key === undefined) deny("target-not-allowed");
  // `amount` and `maxAtomic` are USDC atomic; the balance and the transaction value are native wei.
  const balance = await ctx.projection.nativeBalance(target);
  const value = amount * NATIVE_PER_USDC_ATOMIC;
  const max = ctx.gasMaxAtomic[key as "K3" | "K7" | "K8"] * NATIVE_PER_USDC_ATOMIC;
  if (balance + value > max) deny("above-max");
  return { type: "transaction", to: target, data: "0x", value, purpose: {} };
}

/** The local arc-anvil chain the run-2 and job tests use; `@czar/config` also counts it as a test chain. */
const LOCAL_ARC_ANVIL_CHAIN_ID = 31337;

/**
 * Chains `provider-call` signs on (CZ-27 §5.1 K21 row: "testnet only"; CZ-20 §5.11: "never mainnet"). The same
 * test chains `@czar/config`'s cloud guard names; every other chain id counts as mainnet and is refused.
 */
const PROVIDER_TEST_CHAIN_IDS: readonly number[] = [ARC_TESTNET_CHAIN_ID, LOCAL_ARC_ANVIL_CHAIN_ID];

/**
 * `provider-call` (K21a/K21b, CZ-27 §5.2): `setBudget`/`submit` on the configured escrow and the `BriefRequest`/
 * `DeliverableUpload` digests, only for the key's own job, only when that job's evaluator is K7, and `submit`
 * only with a `contentHash` the server's `uploadJobDeliverable` already accepted for that job.
 */
async function providerCall(ctx: PolicyContext, req: Req, key?: SigningKey): Promise<Decision> {
  if (key === undefined || !PROVIDER_KEY_IDS.includes(key.keyId as ProviderKeyId))
    deny("kind-not-allowed");
  const signing = key as SigningKey;
  if (!PROVIDER_TEST_CHAIN_IDS.includes(ctx.network.chainId)) deny("testnet-only");
  const escrow = req.escrow as Address;
  const jobId = req.jobId as bigint;
  const action = req.action as ProviderAction;
  const args = req.args as Readonly<Record<string, unknown>>;
  if (!eq(escrow, ctx.network.jobEscrow)) deny("unknown-escrow");
  const job = await ctx.projection.job(escrow, jobId);
  if (job === undefined) deny("unknown-job");
  const j = job as NonNullable<typeof job>;
  if (!eq(j.evaluator, ctx.keyAddress("K7"))) deny("evaluator-not-k7");
  if (!eq(j.provider, signing.address)) deny("not-job-provider");
  const key32 = jobKeyOf(ctx.network.jobEscrow, jobId);
  const purpose: PurposeIds = { jobKey: key32 };
  switch (action) {
    case "setBudget": {
      const data = encodeFunctionData({
        abi: JOB_ESCROW_PROVIDER_ABI,
        functionName: "setBudget",
        args: [jobId, ctx.network.usdc, args["amount"] as bigint, "0x"],
      });
      return { type: "transaction", to: ctx.network.jobEscrow, data, value: 0n, purpose };
    }
    case "submit": {
      const contentHash = args["contentHash"] as Hash32;
      const accepted = ctx.projection.deliverableAccepted;
      if (accepted === undefined || !(await accepted(key32, contentHash)))
        deny("deliverable-not-accepted");
      const data = encodeFunctionData({
        abi: JOB_ESCROW_PROVIDER_ABI,
        functionName: "submit",
        args: [jobId, contentHash, "0x"],
      });
      return { type: "transaction", to: ctx.network.jobEscrow, data, value: 0n, purpose };
    }
    case "brief-request": {
      const digest = briefRequestDigest(ctx.network.chainId, {
        jobKey: key32,
        issuedAt: args["issuedAt"] as bigint,
      });
      return { type: "digest", digest, purpose };
    }
    case "deliverable-upload": {
      const digest = deliverableUploadDigest(ctx.network.chainId, {
        jobKey: key32,
        contentHash: args["contentHash"] as Hash32,
        issuedAt: args["issuedAt"] as bigint,
      });
      return { type: "digest", digest, purpose };
    }
    default:
      return deny("shape");
  }
}

const HANDLERS: Readonly<
  Record<Kind, (ctx: PolicyContext, req: Req, key?: SigningKey) => Promise<Decision>>
> = {
  "vault-call": vaultCall,
  "usdc-3009": usdc3009,
  "gateway-burn": gatewayBurn,
  "sl-receipt": slReceipt,
  "autonomy-raise": autonomyRaise,
  "evaluator-call": evaluatorCall,
  "sl-validation-report": slValidationReport,
  "oel-commit": oelCommit,
  "merchant-seller-proof": merchantSellerProof,
  "relayer-tx": relayerTx,
  "gas-refill": gasRefill,
  "gateway-nano": gatewayNano,
  "pocket-delegate": pocketDelegate,
  "pocket-return": pocketReturn,
  "pocket-slow-withdraw": pocketSlowWithdraw,
  "provider-call": providerCall,
};

/** `key` is the signing key; only kinds whose checks name it (`provider-call`) read it, and refuse without it. */
export const decide = (
  ctx: PolicyContext,
  kind: Kind,
  req: Req,
  key?: SigningKey,
): Promise<Decision> => HANDLERS[kind](ctx, req, key);
