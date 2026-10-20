// EIP-712 types, domains and digests (02 §6). Struct hashes are built with explicit `abi.encode`, the way
// the vault and USDC rebuild them on-chain; tests cross-check them against viem's EIP-712 encoder.
import {
  concat,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  keccak256,
  toHex,
  type Hex,
} from "viem";

export type Address = `0x${string}`;
export type Hash32 = `0x${string}`;

/** Exact type strings (02 §6.2; `vectors/eip712-vectors.json` → `typeHashes`). */
export const TYPE_STRINGS = {
  TransferWithAuthorization:
    "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  CancelAuthorization: "CancelAuthorization(address authorizer,bytes32 nonce)",
  TransferSpec:
    "TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain,bytes32 sourceContract,bytes32 destinationContract,bytes32 sourceToken,bytes32 destinationToken,bytes32 sourceDepositor,bytes32 destinationRecipient,bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,bytes32 salt,bytes hookData)",
  BurnIntent:
    "BurnIntent(uint256 maxBlockHeight,uint256 maxFee,TransferSpec spec)TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain,bytes32 sourceContract,bytes32 destinationContract,bytes32 sourceToken,bytes32 destinationToken,bytes32 sourceDepositor,bytes32 destinationRecipient,bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,bytes32 salt,bytes hookData)",
  EIP712Domain_nameVersion: "EIP712Domain(string name,string version)",
  EIP712Domain_full:
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  EIP712Domain_noContract: "EIP712Domain(string name,string version,uint256 chainId)",
  Receipt:
    "Receipt(bytes32 paymentRefHash,bytes32 requestCommit,bytes32 responseCommit,uint16 statusCode,string originAsserted,bytes32 requirementsHashSeen,uint64 tRequest,uint64 tPaymentSigned,uint64 tComplete,uint8 outcome,bytes32 localChecksCommit,uint8 disclosure,uint64 createdAt)",
  ProbeObservation:
    "ProbeObservation(bytes32 intentHash,uint32 itemIndex,bytes32 paymentRefHash,bytes32 requestCommit,bytes32 responseCommit,uint16 statusCode,string originAsserted,bytes32 requirementsHashSeen,uint64 tRequest,uint64 tPaymentSigned,uint64 tComplete,uint8 outcome,string skipReason,uint64 createdAt)",
  ValidationReport:
    "ValidationReport(bytes32 obsId,bytes32 profileId,bytes32 methodVersion,uint8 assignmentKind,bytes32 saltCommit,bytes32 checksCommit,uint64 createdAt)",
  DeliveryAttestation:
    "DeliveryAttestation(bytes32 paymentRefHash,bytes32 responseCommit,uint64 ts)",
  Correction: "Correction(bytes32 targetId,uint8 kind,bytes32 evidenceHash,uint64 createdAt)",
  ServiceClaim: "ServiceClaim(bytes32 serviceId,address payTo,string origin,uint64 deadline)",
  AutonomyRaise:
    "AutonomyRaise(bytes32 category,uint256 newLimit,uint64 periodId,uint256 nonce,uint256 deadline)",
  OwnerAction: "OwnerAction(uint8 action,bytes32 payloadHash,uint256 nonce,uint256 deadline)",
  ReceiptAttestation: "ReceiptAttestation(bytes32 receiptStructHash)",
  BriefRequest: "BriefRequest(bytes32 jobKey,uint64 issuedAt)",
  DeliverableUpload: "DeliverableUpload(bytes32 jobKey,bytes32 contentHash,uint64 issuedAt)",
} as const;

export const typeHash = (typeString: string): Hash32 => keccak256(toHex(typeString));
const TH = Object.fromEntries(
  Object.entries(TYPE_STRINGS).map(([k, s]) => [k, typeHash(s)]),
) as Record<keyof typeof TYPE_STRINGS, Hash32>;

/** Tags (02 §5.3, §6.3, §7.2). */
export const KIND_TAGS = {
  USDC_3009: typeHash("czar.vault.sig.USDC_3009.v1"),
  GATEWAY_BURN: typeHash("czar.vault.sig.GATEWAY_BURN.v1"),
  SL_RECEIPT: typeHash("czar.vault.sig.SL_RECEIPT.v2"),
  /** Refused by the vault (RV-013). */
  SL_RECEIPT_V1_RETIRED: typeHash("czar.vault.sig.SL_RECEIPT.v1"),
  PAYEE_LEAF: typeHash("czar.payee-leaf.v1"),
  EVIDENCE_LEAF: typeHash("czar.evidence-leaf.v1"),
  NONCE_TAG: typeHash("czar.vault.nonce.v1"),
} as const;

/** A1-01, A1-03. */
export const USDC_ADDRESS: Address = "0x3600000000000000000000000000000000000000";

export interface Domain {
  readonly name: string;
  readonly version: string;
  readonly chainId?: number;
  readonly verifyingContract?: Address;
}

/** 02 §6.1. */
export const DOMAINS = {
  usdc: (chainId: number): Domain => ({
    name: "USDC",
    version: "2",
    chainId,
    verifyingContract: USDC_ADDRESS,
  }),
  /** No chainId and no contract (Gateway `EIP712Domain.sol` lines 29–42). */
  gatewayWallet: (): Domain => ({ name: "GatewayWallet", version: "1" }),
  czarVault: (chainId: number, vault: Address): Domain => ({
    name: "CzarVault",
    version: "1",
    chainId,
    verifyingContract: vault,
  }),
  selectionLayer: (chainId: number): Domain => ({ name: "SelectionLayer", version: "1", chainId }),
  czarJobBrief: (chainId: number): Domain => ({ name: "CzarJobBrief", version: "1", chainId }),
} as const;

const strHash = (s: string) => keccak256(toHex(s));

export function domainSeparator(domain: Domain): Hash32 {
  if (domain.chainId === undefined) {
    if (domain.verifyingContract !== undefined) throw new Error("unsupported domain shape");
    return keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [TH.EIP712Domain_nameVersion, strHash(domain.name), strHash(domain.version)],
      ),
    );
  }
  if (domain.verifyingContract === undefined) {
    return keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
        [
          TH.EIP712Domain_noContract,
          strHash(domain.name),
          strHash(domain.version),
          BigInt(domain.chainId),
        ],
      ),
    );
  }
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        TH.EIP712Domain_full,
        strHash(domain.name),
        strHash(domain.version),
        BigInt(domain.chainId),
        domain.verifyingContract,
      ],
    ),
  );
}

/** `keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)` (OpenZeppelin `MessageHashUtils.toTypedDataHash`). */
export const toTypedDataHash = (separator: Hash32, structHash: Hash32): Hash32 =>
  keccak256(concat(["0x1901", separator, structHash]));

// ───────────── USDC EIP-3009 ─────────────

export interface TransferWithAuthorization {
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hash32;
}

export function transferWithAuthorizationStructHash(m: TransferWithAuthorization): Hash32 {
  return keccak256(
    encodeAbiParameters(
      ["bytes32", "address", "address", "uint256", "uint256", "uint256", "bytes32"].map((type) => ({
        type,
      })),
      [TH.TransferWithAuthorization, m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce],
    ),
  );
}

export const usdcTransferWithAuthorizationDigest = (
  chainId: number,
  m: TransferWithAuthorization,
): Hash32 =>
  toTypedDataHash(domainSeparator(DOMAINS.usdc(chainId)), transferWithAuthorizationStructHash(m));

// ───────────── Gateway BurnIntent ─────────────

export interface TransferSpec {
  readonly version: number;
  readonly sourceDomain: number;
  readonly destinationDomain: number;
  readonly sourceContract: Hash32;
  readonly destinationContract: Hash32;
  readonly sourceToken: Hash32;
  readonly destinationToken: Hash32;
  readonly sourceDepositor: Hash32;
  readonly destinationRecipient: Hash32;
  readonly sourceSigner: Hash32;
  readonly destinationCaller: Hash32;
  readonly value: bigint;
  readonly salt: Hash32;
  readonly hookData: Hex;
}

export interface BurnIntent {
  readonly maxBlockHeight: bigint;
  readonly maxFee: bigint;
  readonly spec: TransferSpec;
}

/** An address as the left-padded `bytes32` Gateway uses. */
export const addressToBytes32 = (address: Address): Hash32 =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as Hash32;

export function transferSpecStructHash(s: TransferSpec): Hash32 {
  return keccak256(
    encodeAbiParameters(
      [
        "bytes32",
        "uint32",
        "uint32",
        "uint32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "uint256",
        "bytes32",
        "bytes32",
      ].map((type) => ({ type })),
      [
        TH.TransferSpec,
        s.version,
        s.sourceDomain,
        s.destinationDomain,
        s.sourceContract,
        s.destinationContract,
        s.sourceToken,
        s.destinationToken,
        s.sourceDepositor,
        s.destinationRecipient,
        s.sourceSigner,
        s.destinationCaller,
        s.value,
        s.salt,
        keccak256(s.hookData),
      ],
    ),
  );
}

export function burnIntentDigest(b: BurnIntent): Hash32 {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [TH.BurnIntent, b.maxBlockHeight, b.maxFee, transferSpecStructHash(b.spec)],
    ),
  );
  return toTypedDataHash(domainSeparator(DOMAINS.gatewayWallet()), structHash);
}

/** Gateway's packed TransferSpec encoding (`TransferSpec.sol`): magic, fields, 4-byte hookData length, hookData. */
export const TRANSFER_SPEC_MAGIC = "0xca85def7";

export function transferSpecBytes(s: TransferSpec): Hex {
  const hookLength = (s.hookData.length - 2) / 2;
  return encodePacked(
    [
      "bytes4",
      "uint32",
      "uint32",
      "uint32",
      "bytes32",
      "bytes32",
      "bytes32",
      "bytes32",
      "bytes32",
      "bytes32",
      "bytes32",
      "bytes32",
      "uint256",
      "bytes32",
      "uint32",
      "bytes",
    ],
    [
      TRANSFER_SPEC_MAGIC,
      s.version,
      s.sourceDomain,
      s.destinationDomain,
      s.sourceContract,
      s.destinationContract,
      s.sourceToken,
      s.destinationToken,
      s.sourceDepositor,
      s.destinationRecipient,
      s.sourceSigner,
      s.destinationCaller,
      s.value,
      s.salt,
      hookLength,
      s.hookData,
    ],
  );
}

/** The minter's replay id (`isTransferSpecHashUsed`, AR-15). */
export const transferSpecHash = (s: TransferSpec): Hash32 => keccak256(transferSpecBytes(s));

// ───────────── Selection Layer Receipt and the vault-bound attestation ─────────────

export interface SlReceipt {
  readonly paymentRefHash: Hash32;
  readonly requestCommit: Hash32;
  readonly responseCommit: Hash32;
  readonly statusCode: number;
  readonly originAsserted: string;
  readonly requirementsHashSeen: Hash32;
  readonly tRequest: bigint;
  readonly tPaymentSigned: bigint;
  readonly tComplete: bigint;
  readonly outcome: number;
  readonly localChecksCommit: Hash32;
  readonly disclosure: number;
  readonly createdAt: bigint;
}

export function receiptStructHash(r: SlReceipt): Hash32 {
  return keccak256(
    encodeAbiParameters(
      [
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "uint16",
        "bytes32",
        "bytes32",
        "uint64",
        "uint64",
        "uint64",
        "uint8",
        "bytes32",
        "uint8",
        "uint64",
      ].map((type) => ({ type })),
      [
        TH.Receipt,
        r.paymentRefHash,
        r.requestCommit,
        r.responseCommit,
        r.statusCode,
        strHash(r.originAsserted),
        r.requirementsHashSeen,
        r.tRequest,
        r.tPaymentSigned,
        r.tComplete,
        r.outcome,
        r.localChecksCommit,
        r.disclosure,
        r.createdAt,
      ],
    ),
  );
}

export const slReceiptDigest = (chainId: number, r: SlReceipt): Hash32 =>
  toTypedDataHash(domainSeparator(DOMAINS.selectionLayer(chainId)), receiptStructHash(r));

/** What the agent key signs for `SL_RECEIPT` v2: valid for exactly one vault (RV-013). */
export function receiptAttestationDigest(
  chainId: number,
  vault: Address,
  receiptHash: Hash32,
): Hash32 {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [TH.ReceiptAttestation, receiptHash],
    ),
  );
  return toTypedDataHash(
    domainSeparator(DOMAINS.czarVault(chainId, getAddress(vault))),
    structHash,
  );
}

// ───────────── Czar vault types ─────────────

export interface AutonomyRaise {
  readonly category: Hash32;
  readonly newLimit: bigint;
  readonly periodId: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

/** `category` as the vault expects it: `keccak256(utf8(category))`. */
export const categoryHash = (category: string): Hash32 => strHash(category);

export function autonomyRaiseDigest(chainId: number, vault: Address, m: AutonomyRaise): Hash32 {
  const structHash = keccak256(
    encodeAbiParameters(
      ["bytes32", "bytes32", "uint256", "uint64", "uint256", "uint256"].map((type) => ({ type })),
      [TH.AutonomyRaise, m.category, m.newLimit, m.periodId, m.nonce, m.deadline],
    ),
  );
  return toTypedDataHash(domainSeparator(DOMAINS.czarVault(chainId, vault)), structHash);
}

export interface OwnerAction {
  readonly action: number;
  readonly payloadHash: Hash32;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

export function ownerActionDigest(chainId: number, vault: Address, m: OwnerAction): Hash32 {
  const structHash = keccak256(
    encodeAbiParameters(
      ["bytes32", "uint8", "bytes32", "uint256", "uint256"].map((type) => ({ type })),
      [TH.OwnerAction, m.action, m.payloadHash, m.nonce, m.deadline],
    ),
  );
  return toTypedDataHash(domainSeparator(DOMAINS.czarVault(chainId, vault)), structHash);
}

export interface BriefRequest {
  readonly jobKey: Hash32;
  readonly issuedAt: bigint;
}

export function briefRequestDigest(chainId: number, m: BriefRequest): Hash32 {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }],
      [TH.BriefRequest, m.jobKey, m.issuedAt],
    ),
  );
  return toTypedDataHash(domainSeparator(DOMAINS.czarJobBrief(chainId)), structHash);
}

// ───────────── DeliverableUpload (D87) ─────────────

export interface DeliverableUpload {
  readonly jobKey: Hash32;
  readonly contentHash: Hash32;
  readonly issuedAt: bigint;
}

/** `DeliverableUpload(bytes32 jobKey,bytes32 contentHash,uint64 issuedAt)` under the `CzarJobBrief` domain (02 §6.2, D87). */
export function deliverableUploadDigest(chainId: number, m: DeliverableUpload): Hash32 {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }],
      [TH.DeliverableUpload, m.jobKey, m.contentHash, m.issuedAt],
    ),
  );
  return toTypedDataHash(domainSeparator(DOMAINS.czarJobBrief(chainId)), structHash);
}
