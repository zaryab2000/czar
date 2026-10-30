// SCR-159 §4: the limits page sends one setCategoryLimits UserOperation per category, each only
// after the previous one is included, so no two share an EntryPoint nonce.
import { categoryHash } from "@czar/hashing";
import { encodeSetCategoryLimits } from "@czar/vault-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  getStoredPasskey: vi.fn(),
  sendOwnerUserOperation: vi.fn(),
}));

vi.mock("#src/wallet", () => wallet);

import { submitCategoryLimits } from "#src/category-limits";

const VAULT = "0x00000000000000000000000000000000000000a1" as const;
const PASSKEY = { credentialId: "credential-id", publicKey: `0x04${"11".repeat(64)}` };

describe("submitCategoryLimits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wallet.getStoredPasskey.mockReturnValue(PASSKEY);
  });

  it("waits for each category's inclusion before sending the next", async () => {
    const included: (() => void)[] = [];
    wallet.sendOwnerUserOperation.mockImplementation(
      () =>
        new Promise((resolve) => {
          included.push(() => resolve({ userOpHash: "0x01", bundler: "circle" }));
        }),
    );

    const done = submitCategoryLimits(VAULT, [
      { category: "research", userMax: 5_000_000n, autoLimit: 1_000_000n },
      { category: "data", userMax: 2_000_000n, autoLimit: 0n },
    ]);
    await vi.waitFor(() => expect(included).toHaveLength(1));
    await Promise.resolve();
    expect(wallet.sendOwnerUserOperation).toHaveBeenCalledTimes(1);
    included[0]!();
    await vi.waitFor(() => expect(included).toHaveLength(2));
    included[1]!();
    await done;

    expect(wallet.sendOwnerUserOperation.mock.calls).toEqual([
      [
        PASSKEY,
        VAULT,
        encodeSetCategoryLimits(categoryHash("research"), 5_000_000n, 1_000_000n),
        { waitForInclusion: true },
      ],
      [
        PASSKEY,
        VAULT,
        encodeSetCategoryLimits(categoryHash("data"), 2_000_000n, 0n),
        { waitForInclusion: true },
      ],
    ]);
  });

  it("stops at the first category that fails", async () => {
    wallet.sendOwnerUserOperation.mockRejectedValueOnce(new Error("failed on-chain"));

    await expect(
      submitCategoryLimits(VAULT, [
        { category: "research", userMax: 1n, autoLimit: 0n },
        { category: "data", userMax: 1n, autoLimit: 0n },
      ]),
    ).rejects.toThrow("failed on-chain");
    expect(wallet.sendOwnerUserOperation).toHaveBeenCalledTimes(1);
  });
});
