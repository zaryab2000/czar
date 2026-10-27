// Derived ids (02 §7.1–§7.3).
import { encodeAbiParameters, keccak256 } from "viem";
import { KIND_TAGS, type Address, type Hash32 } from "./eip712.ts";

/** `czar-nonce-v1`: `keccak256(abi.encode(NONCE_TAG, vault, uint64 reservationId, uint32 index))` (02 §7.2). */
export function derivedNonce(vault: Address, reservationId: bigint, index: number): Hash32 {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint64" }, { type: "uint32" }],
      [KIND_TAGS.NONCE_TAG, vault, reservationId, index],
    ),
  );
}

/** Burn-intent salt: `keccak256(abi.encode(NONCE_TAG, vault, uint64 pullbackId))` (02 §7.3). */
export function burnSalt(vault: Address, pullbackId: bigint): Hash32 {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint64" }],
      [KIND_TAGS.NONCE_TAG, vault, pullbackId],
    ),
  );
}

/** `jobKey = keccak256(abi.encode(address jobEscrow, uint256 jobId))` (02 §7.1). */
export function jobKey(jobEscrow: Address, jobId: bigint): Hash32 {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [jobEscrow, jobId]),
  );
}

/** `demandSalt = keccak256(abi.encode(bytes32 userDemandSecret, address vault, uint64 envelopeId))` (02 §5.2, RV-026). */
export function demandSalt(userDemandSecret: Hash32, vault: Address, envelopeId: bigint): Hash32 {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint64" }],
      [userDemandSecret, vault, envelopeId],
    ),
  );
}

/** `soulVersionCommit = keccak256(abi.encode(bytes32 soulVersionHash, bytes32 demandSalt))` (02 §5.2, RV-026). */
export function soulVersionCommit(soulVersionHash: Hash32, salt: Hash32): Hash32 {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [soulVersionHash, salt]),
  );
}
