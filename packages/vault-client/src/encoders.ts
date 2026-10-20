// T-026: the signature envelopes the vault's isValidSignature reads (02 §6.3; 03 czar-vault.md §6 layout table).
import { KIND_TAGS, type SlReceipt } from "@czar/hashing";
import { encodeAbiParameters, hexToBigInt, size, slice, type Hex } from "viem";

export type Address = `0x${string}`;
export type Hash32 = `0x${string}`;

/** r ‖ s ‖ v (02 §6.3.1). */
export const AGENT_SIG_BYTES = 65;
/** 9 head words + the bytes tail (32 length + 65 padded to 96) (czar-vault.md §6). */
export const USDC_3009_BYTES = 416;
/** 3 head words + the bytes tail (czar-vault.md §6). */
export const GATEWAY_BURN_BYTES = 224;
/** The fixed part of an SL_RECEIPT envelope; the originAsserted string adds 32 × ⌈L / 32⌉ (czar-vault.md §6). */
export const SL_RECEIPT_FIXED_BYTES = 672;
const WORD_BYTES = 32;
/** secp256k1 n / 2: signatures with a larger s are refused by the vault and by USDC (A1-09). */
export const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const V_LOW = 27;
const V_HIGH = 28;

export class EncodingError extends Error {
  override readonly name = "EncodingError";
}

/** Checks the 65-byte agent signature the vault accepts: length, low s, v ∈ {27, 28} (czar-vault.md §6 `_agentSigned`). */
export function assertAgentSig(sig: Hex): void {
  if (size(sig) !== AGENT_SIG_BYTES)
    throw new EncodingError(`agentSig must be ${AGENT_SIG_BYTES} bytes`);
  const s = hexToBigInt(slice(sig, WORD_BYTES, 2 * WORD_BYTES));
  if (s > SECP256K1_HALF_N) throw new EncodingError("agentSig has a high s");
  const v = Number(hexToBigInt(slice(sig, 2 * WORD_BYTES, AGENT_SIG_BYTES)));
  if (v !== V_LOW && v !== V_HIGH) throw new EncodingError("agentSig v must be 27 or 28");
}

export interface Usdc3009Envelope {
  readonly reservationId: bigint;
  readonly index: number;
  readonly to: Address;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hash32;
  readonly agentSig: Hex;
}

/** 02 §6.3.1: the primary encoding Circle's relayer passes to USDC's bytes overload (A1-18). Always 416 bytes. */
export function encodeUsdc3009Signature(e: Usdc3009Envelope): Hex {
  assertAgentSig(e.agentSig);
  const out = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint64" },
      { type: "uint32" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes" },
    ],
    [
      KIND_TAGS.USDC_3009,
      e.reservationId,
      e.index,
      e.to,
      e.value,
      e.validAfter,
      e.validBefore,
      e.nonce,
      e.agentSig,
    ],
  );
  if (size(out) !== USDC_3009_BYTES) throw new EncodingError("USDC_3009 envelope length");
  return out;
}

/** 02 §6.3.2: the burn-intent envelope Circle's TEE checks through eth_call. Always 224 bytes. */
export function encodeGatewayBurnSignature(pullbackId: bigint, agentSig: Hex): Hex {
  assertAgentSig(agentSig);
  const out = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes" }],
    [KIND_TAGS.GATEWAY_BURN, pullbackId, agentSig],
  );
  if (size(out) !== GATEWAY_BURN_BYTES) throw new EncodingError("GATEWAY_BURN envelope length");
  return out;
}

/** The SL Receipt tuple in type-string order (02 §6.3.3). */
const SL_RECEIPT_TUPLE = {
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

/** Expected SL_RECEIPT length for an originAsserted of `utf8Bytes` bytes (czar-vault.md §6). */
export const slReceiptLength = (utf8Bytes: number): number =>
  SL_RECEIPT_FIXED_BYTES + WORD_BYTES * Math.ceil(utf8Bytes / WORD_BYTES);

/** 02 §6.3.3 (v2, RV-013): the receipt fields plus the agent's ReceiptAttestation signature. */
export function encodeSlReceiptSignature(receipt: SlReceipt, agentSig: Hex): Hex {
  assertAgentSig(agentSig);
  const out = encodeAbiParameters(
    [{ type: "bytes32" }, SL_RECEIPT_TUPLE, { type: "bytes" }],
    [KIND_TAGS.SL_RECEIPT, receipt, agentSig],
  );
  const expected = slReceiptLength(new TextEncoder().encode(receipt.originAsserted).length);
  if (size(out) !== expected) throw new EncodingError("SL_RECEIPT envelope length");
  return out;
}

/** 02 §6.3.4: the 65-byte fallback for digest-mode reservations is the agent signature itself. */
export function encodeFallbackSignature(agentSig: Hex): Hex {
  assertAgentSig(agentSig);
  return agentSig;
}
