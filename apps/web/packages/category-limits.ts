import { categoryHash } from "@czar/hashing";
import { encodeSetCategoryLimits } from "@czar/vault-client";
import { getStoredPasskey, sendOwnerUserOperation } from "#src/wallet";

export interface CategoryLimits {
  readonly category: string;
  readonly userMax: bigint;
  readonly autoLimit: bigint;
}

/**
 * Sends one `setCategoryLimits` UserOperation per category, each after the previous one is
 * included, since until then they share an EntryPoint nonce (SCR-159 §4).
 */
export async function submitCategoryLimits(
  vault: `0x${string}`,
  limits: readonly CategoryLimits[],
): Promise<void> {
  const passkey = getStoredPasskey();
  for (const { category, userMax, autoLimit } of limits) {
    const calldata = encodeSetCategoryLimits(categoryHash(category), userMax, autoLimit);
    await sendOwnerUserOperation(passkey, vault, calldata, { waitForInclusion: true });
  }
}
