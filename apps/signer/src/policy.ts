// Signer policy (CZ-27 §5.2): rebuild every digest or call from structured fields, check it against the
// projections, and refuse anything else. A refusal names its rule; nothing is signed.
import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  toBytes,
  type Hex,
} from "viem";
import {
  addressToBytes32,
  autonomyRaiseDigest,
  burnIntentDigest,
  derivedNonce,
  KIND_TAGS,
  POCKET_STEP_INDEX,
  receiptAttestationDigest,
  receiptStructHash,
  toTypedDataHash,
  domainSeparator,
  transferWithAuthorizationStructHash,
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
import type { Kind } from "./kinds.ts";
import type { Projection } from "./projection.ts";
import { coerceArgs, type ShapeError } from "./requests.ts";

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
  /** Addresses of the server keys, for checks that name them (K7 evaluator, K8 publisher, gas targets). */
  readonly keyAddress: (key: "K3" | "K7" | "K8" | "K10") => Address;
  /** `signer.gas.<key>.maxAtomic` for the gas-refill targets. */
  readonly gasMaxAtomic: Readonly<Record<"K3" | "K7" | "K8", bigint>>;
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
    }
  | {
      readonly type: "transaction";
      readonly to: Address;
      readonly data: Hex;
      readonly value: bigint;
      readonly purpose: PurposeIds;
    };

/** Parsed request fields (requests.ts); each kind uses a subset. */
type Req = {
  readonly target?: unknown;
  readonly step?: unknown;
  readonly selector?: unknown;
  readonly report?: unknown;
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
  if (found.usedCalls >= found.expectedCalls) deny("expected-calls-used");
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
      break;
    }
    default:
      break;
  }
  return { type: "transaction", to: vault, data, value: 0n, purpose };
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
  return { type: "digest", digest, wrap, purpose: { reservationId: reservationId.toString() } };
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
  if (!(await ctx.projection.isVault(vault))) deny("unknown-vault");
  if (!(await ctx.projection.settledPayment(vault, receipt.paymentRefHash)))
    deny("payment-not-settled");
  const digest = receiptAttestationDigest(ctx.network.chainId, vault, receiptStructHash(receipt));
  const wrap = (agentSig: Hex): Hex =>
    encodeAbiParameters(
      [{ type: "bytes32" }, RECEIPT_TUPLE, { type: "bytes" }],
      [KIND_TAGS.SL_RECEIPT, receipt as never, agentSig],
    );
  return { type: "digest", digest, wrap, purpose: {} };
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
      payTo: ctx.keyAddress("K10"),
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
  const spent = await ctx.projection.nanoSpent(pocket, payTo);
  if (spent.step + amount > (leaf as NonNullable<typeof leaf>).stepCap) deny("step-cap");
  if (spent.pocket + amount > view.funded) deny("pocket-funded");
  const digest = toTypedDataHash(
    domainSeparator(ctx.network.nanoDomain),
    transferWithAuthorizationStructHash({
      from: pocket,
      to: payTo,
      value: amount,
      validAfter: 0n,
      validBefore: req.validBefore as bigint,
      nonce: req.nonce as Hash32,
    }),
  );
  return { type: "digest", digest, purpose: { envelopeRef: view.envelopeId.toString() } };
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
    if (amount > balances.usdc) deny("above-balance");
    const data = encodeFunctionData({
      abi: USDC_ABI,
      functionName: "transfer",
      args: [view.vault, amount],
    });
    return { type: "transaction", to: ctx.network.usdc, data, value: 0n, purpose: {} };
  }
  if (amount > balances.native) deny("above-balance");
  return { type: "transaction", to: view.vault, data: "0x", value: amount, purpose: {} };
}

async function pocketSlowWithdraw(ctx: PolicyContext, req: Req): Promise<Decision> {
  const pocket = req.pocket as Address;
  await activePocket(ctx, pocket);
  if (!(await ctx.projection.slowWithdrawAllowed(pocket))) deny("slow-withdraw-not-allowed");
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
  const balance = await ctx.projection.nativeBalance(target);
  const max = ctx.gasMaxAtomic[key as "K3" | "K7" | "K8"];
  if (balance + amount > max) deny("above-max");
  return { type: "transaction", to: target, data: "0x", value: amount, purpose: {} };
}

const HANDLERS: Readonly<Record<Kind, (ctx: PolicyContext, req: Req) => Promise<Decision>>> = {
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
};

export const decide = (ctx: PolicyContext, kind: Kind, req: Req): Promise<Decision> =>
  HANDLERS[kind](ctx, req);
