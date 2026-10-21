import { describe, expect, it } from "vitest";
import { normalizeTransferAmount } from "#src/amounts";

describe("Transfer amount normalization", () => {
  it("keeps ERC-20 USDC amounts in Amount6 units", () => {
    expect(normalizeTransferAmount("usdc", 1_234_567n)).toBe("1234567");
  });

  it("converts native EIP-7708 amounts from 18 to 6 decimals", () => {
    expect(normalizeTransferAmount("eip7708", 1_234_567_000_000_000_000n)).toBe("1234567");
  });

  it("floors native dust below Amount6 precision instead of halting indexing", () => {
    expect(normalizeTransferAmount("eip7708", 1_000_000_000_001n)).toBe("1");
    expect(normalizeTransferAmount("eip7708", 1n)).toBe("0");
  });
});
