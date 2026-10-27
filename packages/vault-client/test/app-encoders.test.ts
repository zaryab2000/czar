import {
  czarVaultAbi,
  czarVaultFactoryAbi,
  encodeCreateVault,
  encodeRecordManualReturn,
  encodeSetCategoryLimits,
  encodeSetPasskey,
} from "@czar/vault-client";
import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

describe("app owner action encoders", () => {
  it("uses the deployed one-argument createVault ABI", () => {
    const owner = "0x0000000000000000000000000000000000000001";
    const decoded = decodeFunctionData({
      abi: czarVaultFactoryAbi,
      data: encodeCreateVault(owner),
    });
    expect(decoded.functionName).toBe("createVault");
    expect(decoded.args).toEqual([owner]);
  });

  it("encodes category limits as uint256 values", () => {
    const category = `0x${"11".repeat(32)}` as `0x${string}`;
    const decoded = decodeFunctionData({
      abi: czarVaultAbi,
      data: encodeSetCategoryLimits(category, 2_000_000n, 1_000_000n),
    });
    expect(decoded.functionName).toBe("setCategoryLimits");
    expect(decoded.args).toEqual([category, 2_000_000n, 1_000_000n]);
  });

  it("encodes recordManualReturn with the pocket and returned amount", () => {
    const pocket = "0x0000000000000000000000000000000000000001";
    const decoded = decodeFunctionData({
      abi: czarVaultAbi,
      data: encodeRecordManualReturn(pocket, 700n),
    });
    expect(decoded.functionName).toBe("recordManualReturn");
    expect(decoded.args).toEqual([pocket, 700n]);
  });

  it("encodes the P-256 coordinates and RP ID hash for setPasskey", () => {
    const qx = `0x${"11".repeat(32)}` as `0x${string}`;
    const qy = `0x${"22".repeat(32)}` as `0x${string}`;
    const rpIdHash = `0x${"33".repeat(32)}` as `0x${string}`;
    const decoded = decodeFunctionData({
      abi: czarVaultAbi,
      data: encodeSetPasskey(qx, qy, rpIdHash),
    });
    expect(decoded.functionName).toBe("setPasskey");
    expect(decoded.args).toEqual([qx, qy, rpIdHash]);
    expect(() => encodeSetPasskey("0x11", qy, rpIdHash)).toThrow(
      "Passkey coordinates and RP ID hash must be bytes32 values.",
    );
  });
});
