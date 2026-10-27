import { czarVaultAbi, encodeFreezeAction } from "@czar/vault-client";
import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

describe("freeze action encoder", () => {
  it.each(["freeze", "unfreeze"] as const)("encodes %s", (action) => {
    const calldata = encodeFreezeAction(action);
    expect(decodeFunctionData({ abi: czarVaultAbi, data: calldata }).functionName).toBe(action);
  });
});
