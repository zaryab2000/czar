import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { createJobChainAdapter } from "#src/payer/job-chain-adapter";

describe("job chain adapter", () => {
  it("reads Circle's canonical jobs getter and maps its flat tuple", async () => {
    const readContract = vi.fn(async ({ address, functionName }) => {
      if (functionName === "jobEscrowKind") return 0;
      if (address === "0x0000000000000000000000000000000000000001")
        return { state: 2, jobId: 7n, expiredAt: 3_000 };
      if (functionName !== "jobs") throw new Error("Circle does not expose getJob.");
      return [
        7n,
        "0x0000000000000000000000000000000000000011",
        "0x0000000000000000000000000000000000000022",
        "0x0000000000000000000000000000000000000033",
        "czar:distinct-fields",
        907n,
        3_333n,
        2,
        "0x0000000000000000000000000000000000000044",
      ];
    });
    const adapter = createJobChainAdapter({
      client: { readContract } as never,
      pool: { query: vi.fn() } as never,
      config: loadConfig(),
      vault: "0x0000000000000000000000000000000000000001",
      jobEscrow: "0x0000000000000000000000000000000000000002",
      usdc: "0x0000000000000000000000000000000000000003",
      now: () => new Date(0),
    });
    await expect(adapter.getJob(`0x${"11".repeat(32)}`)).resolves.toMatchObject({
      vaultState: "Funded",
      escrowState: "Submitted",
      budget: 907n,
      expiredAt: 3_333,
    });
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "jobs",
        args: [7n],
      }),
    );
  });

  it("fails closed for an unknown escrow kind", async () => {
    const readContract = vi.fn(async ({ functionName }) => {
      if (functionName === "jobEscrowKind") return 2;
      if (functionName === "getJob") return { state: 1, jobId: 7n, expiredAt: 100, status: 0 };
      return undefined;
    });
    const adapter = createJobChainAdapter({
      client: { readContract } as never,
      pool: { query: vi.fn() } as never,
      config: loadConfig(),
      vault: "0x0000000000000000000000000000000000000001",
      jobEscrow: "0x0000000000000000000000000000000000000002",
      usdc: "0x0000000000000000000000000000000000000003",
      now: () => new Date(0),
    });
    await expect(adapter.getJob(`0x${"11".repeat(32)}`)).rejects.toThrow("escrow kind");
  });

  it("keeps CzarBase getJob decoding budget, status and expiry", async () => {
    const readContract = vi.fn(async ({ address, functionName }) => {
      if (functionName === "jobEscrowKind") return 1;
      if (address === "0x0000000000000000000000000000000000000001")
        return { state: 2, jobId: 7n, expiredAt: 2_222n };
      if (functionName !== "getJob") throw new Error("Unexpected escrow getter.");
      return { budget: 654n, status: 3, expiredAt: 4_444n };
    });
    const adapter = createJobChainAdapter({
      client: { readContract } as never,
      pool: { query: vi.fn() } as never,
      config: loadConfig(),
      vault: "0x0000000000000000000000000000000000000001",
      jobEscrow: "0x0000000000000000000000000000000000000002",
      usdc: "0x0000000000000000000000000000000000000003",
      now: () => new Date(0),
    });

    await expect(adapter.getJob(`0x${"33".repeat(32)}`)).resolves.toMatchObject({
      escrowState: "Completed",
      budget: 654n,
      expiredAt: 4_444,
    });
  });

  it("watches the Circle event ABI and rereads chain state after a log", async () => {
    let readCount = 0;
    const readContract = vi.fn(async ({ functionName }) => {
      if (functionName === "jobEscrowKind") return 0;
      if (functionName === "getJob") return { state: 1, jobId: 7n, expiredAt: 5_000n };
      if (functionName !== "jobs") throw new Error("Unexpected contract read.");
      readCount += 1;
      return [
        7n,
        "0x0000000000000000000000000000000000000011",
        "0x0000000000000000000000000000000000000022",
        "0x0000000000000000000000000000000000000033",
        "czar:event-reread",
        readCount <= 2 ? 0n : 800n,
        5_000n,
        0,
        "0x0000000000000000000000000000000000000044",
      ];
    });
    const watchContractEvent = vi.fn(({ onLogs }) => {
      queueMicrotask(() => onLogs([]));
      return vi.fn();
    });
    const adapter = createJobChainAdapter({
      client: { readContract, watchContractEvent } as never,
      pool: { query: vi.fn() } as never,
      config: loadConfig(),
      vault: "0x0000000000000000000000000000000000000001",
      jobEscrow: "0x0000000000000000000000000000000000000002",
      usdc: "0x0000000000000000000000000000000000000003",
      now: () => new Date(0),
    });

    await expect(adapter.waitForBudget(`0x${"44".repeat(32)}`, 1_000)).resolves.toBe(800n);
    const watched = watchContractEvent.mock.calls[0]?.[0] as {
      readonly abi: readonly {
        readonly type: string;
        readonly name?: string;
        readonly inputs?: readonly { readonly name: string; readonly indexed?: boolean }[];
      }[];
    };
    const budgetEvent = watched?.abi.find(
      (item) => item.type === "event" && item.name === "BudgetSet",
    );
    expect(budgetEvent?.inputs?.map((input) => [input.name, input.indexed ?? false])).toEqual([
      ["jobId", true],
      ["amount", false],
    ]);
    expect(readContract).toHaveBeenCalledTimes(10);
  });

  it("watches the CzarBase event ABI and rereads chain state after a log", async () => {
    let readCount = 0;
    const readContract = vi.fn(async ({ address, functionName }) => {
      if (functionName === "jobEscrowKind") return 1;
      if (address === "0x0000000000000000000000000000000000000001")
        return { state: 1, jobId: 7n, expiredAt: 5_000n };
      if (functionName !== "getJob") throw new Error("Unexpected contract read.");
      readCount += 1;
      return { budget: readCount <= 2 ? 0n : 808n, status: 0, expiredAt: 5_000n };
    });
    const watchContractEvent = vi.fn(({ onLogs }) => {
      queueMicrotask(() => onLogs([]));
      return vi.fn();
    });
    const adapter = createJobChainAdapter({
      client: { readContract, watchContractEvent } as never,
      pool: { query: vi.fn() } as never,
      config: loadConfig(),
      vault: "0x0000000000000000000000000000000000000001",
      jobEscrow: "0x0000000000000000000000000000000000000002",
      usdc: "0x0000000000000000000000000000000000000003",
      now: () => new Date(0),
    });

    await expect(adapter.waitForBudget(`0x${"66".repeat(32)}`, 1_000)).resolves.toBe(808n);
    const watched = watchContractEvent.mock.calls[0]?.[0] as {
      readonly abi: readonly {
        readonly type: string;
        readonly name?: string;
        readonly inputs?: readonly { readonly name: string; readonly indexed?: boolean }[];
      }[];
    };
    const budgetEvent = watched.abi.find(
      (item) => item.type === "event" && item.name === "BudgetSet",
    );
    expect(budgetEvent?.inputs?.map((input) => [input.name, input.indexed ?? false])).toEqual([
      ["jobId", true],
      ["token", true],
      ["amount", false],
    ]);
    expect(readContract).toHaveBeenCalledTimes(10);
  });

  it("treats Circle's zero budget as not set while the provider waits", async () => {
    const readContract = vi
      .fn()
      .mockResolvedValueOnce({ state: 1, jobId: 7n, expiredAt: 100 })
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce([7n, "0x0", "0x0", "0x0", "czar:test", 0n, 100n, 0, "0x0"]);
    const adapter = createJobChainAdapter({
      client: { readContract } as never,
      pool: { query: vi.fn() } as never,
      config: loadConfig(),
      vault: "0x0000000000000000000000000000000000000001",
      jobEscrow: "0x0000000000000000000000000000000000000002",
      usdc: "0x0000000000000000000000000000000000000003",
      now: () => new Date("2026-10-23T00:00:00Z"),
    });

    const job = await adapter.getJob(`0x${"11".repeat(32)}` as `0x${string}`);

    expect(job).toMatchObject({ vaultState: "Opened", escrowState: "Open" });
    expect(job.budget).toBeUndefined();
  });

  it("treats only submissions before their recorded decision cutoff as pending", async () => {
    const readContract = vi.fn(async ({ address, functionName }) =>
      functionName === "jobEscrowKind"
        ? 1
        : address === "0x0000000000000000000000000000000000000001"
          ? { state: 3, jobId: 7n, expiredAt: 3_000 }
          : { status: 2, budget: 900n, expiredAt: 3_000n },
    );
    const query = vi.fn(async () => ({ rows: [{ brief: { decisionCutoff: 2_000 } }] }));
    const adapter = createJobChainAdapter({
      client: { readContract } as never,
      pool: { query } as never,
      config: loadConfig(),
      vault: "0x0000000000000000000000000000000000000001",
      jobEscrow: "0x0000000000000000000000000000000000000002",
      usdc: "0x0000000000000000000000000000000000000003",
      now: () => new Date(1_999_000),
    });
    const jobKey = `0x${"11".repeat(32)}` as `0x${string}`;

    await expect(adapter.hasDecisionPending(jobKey)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      "SELECT brief FROM payer_job_briefs WHERE lower(job_key)=lower($1)",
      [jobKey],
    );
  });

  it("allows refund after the decision cutoff when no decision has completed", async () => {
    const readContract = vi.fn(async ({ address, functionName }) =>
      functionName === "jobEscrowKind"
        ? 1
        : address === "0x0000000000000000000000000000000000000001"
          ? { state: 3, jobId: 7n, expiredAt: 3_000 }
          : { status: 2, budget: 900n, expiredAt: 3_000n },
    );
    const adapter = createJobChainAdapter({
      client: { readContract } as never,
      pool: {
        query: vi.fn(async () => ({ rows: [{ brief: { decisionCutoff: 2_000 } }] })),
      } as never,
      config: loadConfig(),
      vault: "0x0000000000000000000000000000000000000001",
      jobEscrow: "0x0000000000000000000000000000000000000002",
      usdc: "0x0000000000000000000000000000000000000003",
      now: () => new Date(2_001_000),
    });

    await expect(adapter.hasDecisionPending(`0x${"22".repeat(32)}` as `0x${string}`)).resolves.toBe(
      false,
    );
  });

  it("treats a submission as pending while chain time, not the server clock, is before its cutoff", async () => {
    const readContract = vi.fn(async ({ address, functionName }) =>
      functionName === "jobEscrowKind"
        ? 1
        : address === "0x0000000000000000000000000000000000000001"
          ? { state: 3, jobId: 7n, expiredAt: 3_000 }
          : { status: 2, budget: 900n, expiredAt: 3_000n },
    );
    const getBlock = vi.fn(async () => ({ timestamp: 1_999n }));
    const adapter = createJobChainAdapter({
      client: { readContract, getBlock } as never,
      pool: {
        query: vi.fn(async () => ({ rows: [{ brief: { decisionCutoff: 2_000 } }] })),
      } as never,
      config: loadConfig(),
      vault: "0x0000000000000000000000000000000000000001",
      jobEscrow: "0x0000000000000000000000000000000000000002",
      usdc: "0x0000000000000000000000000000000000000003",
      now: () => new Date(2_400_000),
    });

    await expect(adapter.hasDecisionPending(`0x${"22".repeat(32)}` as `0x${string}`)).resolves.toBe(
      true,
    );
    expect(getBlock).toHaveBeenCalledWith({ blockTag: "latest" });
  });

  it("waits for a job result until chain time reaches expiredAt, re-reading it every payer.reconcileSeconds", async () => {
    vi.useFakeTimers();
    try {
      const config = loadConfig();
      const reconcileMs = Number(config.get("payer.reconcileSeconds")) * 1000;
      let chainNow = 2_000n;
      const readContract = vi.fn(async ({ address, functionName }) => {
        if (functionName === "jobEscrowKind") return 1;
        if (address === "0x0000000000000000000000000000000000000001")
          return { state: 2, jobId: 7n, expiredAt: 3_000n };
        return { budget: 900n, status: 1, expiredAt: 3_000n };
      });
      const getBlock = vi.fn(async () => ({ timestamp: chainNow }));
      const stop = vi.fn();
      const adapter = createJobChainAdapter({
        client: { readContract, getBlock, watchContractEvent: vi.fn(() => stop) } as never,
        pool: { query: vi.fn() } as never,
        config,
        vault: "0x0000000000000000000000000000000000000001",
        jobEscrow: "0x0000000000000000000000000000000000000002",
        usdc: "0x0000000000000000000000000000000000000003",
        // The server clock is far past expiredAt; only chain time may end the wait.
        now: () => new Date(10_000_000),
      });
      let settled = false;
      const result = adapter.waitForResult(`0x${"33".repeat(32)}`, 3_000).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(reconcileMs * 2);
      expect(settled).toBe(false);
      const readsBefore = getBlock.mock.calls.length;
      expect(readsBefore).toBeGreaterThanOrEqual(2);
      chainNow = 3_000n;
      await vi.advanceTimersByTimeAsync(reconcileMs);

      await expect(result).resolves.toMatchObject({ vaultState: "Funded", expiredAt: 3_000 });
      expect(getBlock.mock.calls.length).toBe(readsBefore + 1);
      expect(stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
