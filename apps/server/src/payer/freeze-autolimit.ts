import type { Address, Hex } from "viem";
import type { Logger } from "@czar/logging";

export interface FreezeAutoLimitDependencies {
  readonly categoryIds: readonly Hex[];
  readonly getAutoLimit: (vault: Address, categoryId: Hex) => Promise<bigint>;
  readonly lowerAutoLimit: (vault: Address, categoryId: Hex) => Promise<void>;
  readonly logger: Pick<Logger, "error">;
}

export async function lowerAutoLimitsAfterFreeze(
  vault: Address,
  dependencies: FreezeAutoLimitDependencies,
): Promise<void> {
  const failures: unknown[] = [];
  for (const categoryId of dependencies.categoryIds) {
    try {
      const currentLimit = await dependencies.getAutoLimit(vault, categoryId);
      if (currentLimit === 0n) continue;
      await dependencies.lowerAutoLimit(vault, categoryId);
    } catch (error) {
      dependencies.logger.error("auto_limit_lowering_failure", {
        rule: "freeze_lower_auto_limit_failed",
        state: "retry",
      });
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new Error(`could not lower auto limits for ${failures.length} categories`);
}
