// T-026 (07 PRD 14 §7): low-s normalisation (RV-034) and the 20 Gwei fee floor (p1-A6).
import { numberToHex, parseGwei } from "viem";
import { describe, expect, it } from "vitest";
import { MIN_MAX_FEE_PER_GAS, normaliseP256S, P256_N, withFeeFloor } from "@czar/vault-client";

describe("normaliseP256S", () => {
  it("maps a high s to n − s and leaves a low s alone", () => {
    const low = 5n;
    expect(normaliseP256S(numberToHex(low, { size: 32 }))).toBe(numberToHex(low, { size: 32 }));
    expect(normaliseP256S(numberToHex(P256_N - low, { size: 32 }))).toBe(
      numberToHex(low, { size: 32 }),
    );
    const half = P256_N / 2n;
    expect(normaliseP256S(numberToHex(half, { size: 32 }))).toBe(numberToHex(half, { size: 32 }));
    expect(normaliseP256S(numberToHex(half + 1n, { size: 32 }))).toBe(
      numberToHex(P256_N - half - 1n, { size: 32 }),
    );
  });

  it("refuses 0 and values ≥ n", () => {
    expect(() => normaliseP256S(numberToHex(0n, { size: 32 }))).toThrow();
    expect(() => normaliseP256S(numberToHex(P256_N, { size: 32 }))).toThrow();
  });
});

describe("withFeeFloor", () => {
  it("raises a low or missing maxFeePerGas to 20 Gwei and keeps a higher one", () => {
    expect(MIN_MAX_FEE_PER_GAS).toBe(parseGwei("20"));
    expect(withFeeFloor<{ maxFeePerGas?: bigint }>({}).maxFeePerGas).toBe(parseGwei("20"));
    expect(withFeeFloor({ maxFeePerGas: parseGwei("1") }).maxFeePerGas).toBe(parseGwei("20"));
    expect(withFeeFloor({ maxFeePerGas: parseGwei("50") }).maxFeePerGas).toBe(parseGwei("50"));
    expect(
      withFeeFloor({ maxFeePerGas: parseGwei("1"), maxPriorityFeePerGas: parseGwei("30") })
        .maxPriorityFeePerGas,
    ).toBe(parseGwei("20"));
  });
});
