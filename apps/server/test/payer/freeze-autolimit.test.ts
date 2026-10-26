import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { categoryHash } from "@czar/hashing";
import { loadConfig } from "@czar/config";
import { lowerAutoLimitsAfterFreeze } from "#src/payer/freeze-autolimit";

describe("freeze auto-limit lowering", () => {
  const categories = [...new Set(Object.values(loadConfig().get("planner.categoryByCapability")))];
  const categoryIds = categories.map(categoryHash);
  const vault = "0x0000000000000000000000000000000000000001" as Address;

  it("lowers only categories whose current auto limit is nonzero", async () => {
    const limits = new Map(categoryIds.map((id, index) => [id, index === 0 ? 0n : 5n]));
    const lower = vi.fn(async (_vault: Address, categoryId: Hex) => {
      limits.set(categoryId, 0n);
    });
    await lowerAutoLimitsAfterFreeze(vault, {
      categoryIds,
      getAutoLimit: async (_vault, categoryId) => limits.get(categoryId) ?? 0n,
      lowerAutoLimit: lower,
      logger: { error: vi.fn() },
    });
    expect(lower).toHaveBeenCalledTimes(categoryIds.length - 1);
  });

  it("replayed Frozen handling sends no additional lowering transactions", async () => {
    const limits = new Map(categoryIds.map((id) => [id, 5n]));
    const lower = vi.fn(async (_vault: Address, categoryId: Hex) => {
      limits.set(categoryId, 0n);
    });
    const dependencies = {
      categoryIds,
      getAutoLimit: async (_vault: Address, categoryId: Hex) => limits.get(categoryId) ?? 0n,
      lowerAutoLimit: lower,
      logger: { error: vi.fn() },
    };
    await lowerAutoLimitsAfterFreeze(vault, dependencies);
    await lowerAutoLimitsAfterFreeze(vault, dependencies);
    expect(lower).toHaveBeenCalledTimes(categoryIds.length);
  });

  it("logs and propagates signer refusal so the event source retries", async () => {
    const logger = { error: vi.fn() };
    const failure = new Error("signer refused");
    await expect(
      lowerAutoLimitsAfterFreeze(vault, {
        categoryIds,
        getAutoLimit: async () => 1n,
        lowerAutoLimit: async () => {
          throw failure;
        },
        logger,
      }),
    ).rejects.toThrow("could not lower auto limits for 4 categories");
    expect(logger.error).toHaveBeenCalledTimes(categoryIds.length);
    expect(logger.error).toHaveBeenCalledWith("auto_limit_lowering_failure", {
      rule: "freeze_lower_auto_limit_failed",
      state: "retry",
    });
  });

  it("keeps its category set equal to the onboarding limits screen", async () => {
    const screen = await readFile(
      new URL("../../../web/app/onboarding/limits/page.tsx", import.meta.url),
      "utf8",
    );
    const match = screen.match(/const CATEGORIES = \[([^\]]+)\] as const/);
    expect(match).not.toBeNull();
    const screenCategories = [...match![1]!.matchAll(/"([^"]+)"/g)].map((item) => item[1]!);
    expect([...categories].toSorted()).toEqual(screenCategories.toSorted());
  });
});
