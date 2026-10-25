import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { pollPlannerOnce } from "#src/planner/loop";

describe("planner loop", () => {
  it("reclaims stale claims, then asks the outbox worker to claim one event", async () => {
    const query = vi.fn(async (_query: string) => ({ rowCount: 0 }));
    const processNextReceived = vi.fn(async () => true);
    const now = new Date("2026-10-21T00:00:00Z");

    await expect(
      pollPlannerOnce({
        pool: { query } as never,
        config: loadConfig(),
        processNextReceived,
        now: () => now,
      }),
    ).resolves.toBe(true);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("NOT EXISTS (SELECT 1 FROM plans");
    expect(processNextReceived).toHaveBeenCalledOnce();
  });
});
