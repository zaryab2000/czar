// T-026: WebAuthn assertion helpers for executeOwnerAction (D30; RV-034 low-s normalisation).
import { hexToBigInt, numberToHex, type Hex } from "viem";

/** The order of the P-256 group (NIST SP 800-186). */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_N = P256_N / 2n;
const WORD_BYTES = 32;

/** The struct `executeOwnerAction` takes (ICzarVault.WebAuthnAuth; OpenZeppelin v5.7.0 WebAuthn.WebAuthnAuth). */
export interface WebAuthnAuth {
  readonly r: Hex;
  readonly s: Hex;
  readonly challengeIndex: bigint;
  readonly typeIndex: bigint;
  readonly authenticatorData: Hex;
  readonly clientDataJSON: string;
}

/**
 * Browsers return either s; OpenZeppelin's P256 verifier refuses s > n/2 (RV-034). Returns `n − s` for a high s and
 * the same s otherwise. Both values verify the same message, so normalising never changes what was signed.
 */
export function normaliseP256S(s: Hex): Hex {
  const value = hexToBigInt(s);
  if (value === 0n || value >= P256_N) throw new Error("P-256 s out of range");
  return numberToHex(value > HALF_N ? P256_N - value : value, { size: WORD_BYTES });
}

/** Returns the assertion with a low s, ready for executeOwnerAction. */
export const withLowS = (a: WebAuthnAuth): WebAuthnAuth => ({ ...a, s: normaliseP256S(a.s) });
