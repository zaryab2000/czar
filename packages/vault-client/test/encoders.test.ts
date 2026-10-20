// T-026 (07 PRD 14 §7): every encoder output matches the czar-vault.md §6 layout table.
import { KIND_TAGS, type SlReceipt } from "@czar/hashing";
import { concat, decodeAbiParameters, hexToBigInt, numberToHex, size, slice, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  encodeFallbackSignature,
  encodeGatewayBurnSignature,
  encodeSlReceiptSignature,
  encodeUsdc3009Signature,
  EncodingError,
  GATEWAY_BURN_BYTES,
  SECP256K1_HALF_N,
  slReceiptLength,
  USDC_3009_BYTES,
} from "@czar/vault-client";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const word = (sig: Hex, i: number): bigint => hexToBigInt(slice(sig, 32 * i, 32 * (i + 1)));
const account = privateKeyToAccount(generatePrivateKey()); // ephemeral, never printed
const agentSig = async (): Promise<Hex> => account.sign({ hash: `0x${"11".repeat(32)}` });

const receipt = (originAsserted: string): SlReceipt => ({
  paymentRefHash: `0x${"01".repeat(32)}`,
  requestCommit: `0x${"02".repeat(32)}`,
  responseCommit: `0x${"03".repeat(32)}`,
  statusCode: 200,
  originAsserted,
  requirementsHashSeen: `0x${"04".repeat(32)}`,
  tRequest: 1n,
  tPaymentSigned: 2n,
  tComplete: 3n,
  outcome: 1,
  localChecksCommit: `0x${"05".repeat(32)}`,
  disclosure: 0,
  createdAt: 4n,
});

describe("USDC_3009 (02 §6.3.1)", () => {
  it("is 416 bytes with the §6 offsets and decodes back to its fields", async () => {
    const sig = await agentSig();
    const out = encodeUsdc3009Signature({
      reservationId: 7n,
      index: 3,
      to: "0x000000000000000000000000000000000000bEEF",
      value: 1_000n,
      validAfter: 0n,
      validBefore: 1_792_000_300n,
      nonce: `0x${"ab".repeat(32)}`,
      agentSig: sig,
    });
    expect(size(out)).toBe(USDC_3009_BYTES);
    expect(slice(out, 0, 32)).toBe(KIND_TAGS.USDC_3009);
    expect(word(out, 8)).toBe(0x120n); // offset of agentSig
    expect(word(out, 9)).toBe(65n); // its length
    const d = decodeAbiParameters(
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
      out,
    );
    expect(d[1]).toBe(7n);
    expect(d[2]).toBe(3);
    expect(d[8]).toBe(sig);
  });
});

describe("GATEWAY_BURN (02 §6.3.2)", () => {
  it("is 224 bytes with offset 0x60 and length 65", async () => {
    const out = encodeGatewayBurnSignature(5n, await agentSig());
    expect(size(out)).toBe(GATEWAY_BURN_BYTES);
    expect(slice(out, 0, 32)).toBe(KIND_TAGS.GATEWAY_BURN);
    expect(word(out, 1)).toBe(5n);
    expect(word(out, 2)).toBe(0x60n);
    expect(word(out, 3)).toBe(65n);
  });
});

describe("SL_RECEIPT v2 (02 §6.3.3)", () => {
  // The lengths czar-vault.md §6 checked with viem: L = 0, 1, 24, 31, 32, 33 and 256.
  for (const length of [0, 1, 24, 31, 32, 33, 256]) {
    it(`is 672 + 32 × ⌈${length} / 32⌉ bytes with the tuple offsets`, async () => {
      const out = encodeSlReceiptSignature(receipt("a".repeat(length)), await agentSig());
      expect(size(out)).toBe(slReceiptLength(length));
      expect(slice(out, 0, 32)).toBe(KIND_TAGS.SL_RECEIPT);
      expect(word(out, 1)).toBe(0x60n); // offset of the receipt tuple
      expect(hexToBigInt(slice(out, 0x60 + 32 * 4, 0x60 + 32 * 5))).toBe(0x1a0n); // originAsserted offset in the tuple
      expect(hexToBigInt(slice(out, 0x200, 0x220))).toBe(BigInt(length)); // the string's length word
    });
  }
});

describe("fallback (02 §6.3.4) and the agent-signature checks", () => {
  it("passes a valid 65-byte signature through unchanged", async () => {
    const sig = await agentSig();
    expect(encodeFallbackSignature(sig)).toBe(sig);
  });

  it("refuses a wrong length, a high s and a bad v", async () => {
    const sig = await agentSig();
    expect(() => encodeFallbackSignature(slice(sig, 0, 64))).toThrow(EncodingError);
    const s = hexToBigInt(slice(sig, 32, 64));
    const highS = numberToHex(SECP256K1_N - s, { size: 32 });
    expect(SECP256K1_N - s > SECP256K1_HALF_N).toBe(true);
    expect(() =>
      encodeFallbackSignature(concat([slice(sig, 0, 32), highS, slice(sig, 64, 65)])),
    ).toThrow("high s");
    expect(() => encodeFallbackSignature(concat([slice(sig, 0, 64), "0x01"]))).toThrow("27 or 28");
  });
});
