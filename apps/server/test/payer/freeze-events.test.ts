import { describe, expect, it, vi } from "vitest";
import {
  hasPendingFrozenEvent,
  scanFrozenEvents,
  processPendingFrozenEvents,
  queueFrozenEvent,
} from "#src/payer/freeze-events";
import type { VaultHaltEvent } from "#src/payer/runtime";

const VAULT = "0x0000000000000000000000000000000000000001" as const;
const TX = `0x${"11".repeat(32)}` as const;

function fakeStore() {
  let cursor: string | undefined;
  let transactionOpen = false;
  const committedCursors: string[] = [];
  const events = new Map<
    string,
    { block: string; index: number; tx: string; done: boolean; lowered: boolean }
  >();
  const query = vi.fn(async (statement: string, values: unknown[] = []) => {
    if (statement === "BEGIN") transactionOpen = true;
    if (statement === "COMMIT") {
      transactionOpen = false;
      if (cursor) committedCursors.push(cursor);
    }
    if (statement === "ROLLBACK") transactionOpen = false;
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return { rows: [] };
    if (statement.includes("SELECT last_scanned_block"))
      return { rows: cursor === undefined ? [] : [{ last_scanned_block: cursor }] };
    if (statement.includes("SELECT EXISTS"))
      return {
        rows: [{ pending: [...events.values()].some((event) => !event.done && !event.lowered) }],
      };
    if (statement.includes("INSERT INTO payer_freeze_autolimit_events")) {
      expect(transactionOpen).toBe(true);
      const [vault, block, index, tx] = values as [string, string, number, string];
      const key = `${vault}:${block}:${index}`;
      events.set(key, events.get(key) ?? { block, index, tx, done: false, lowered: false });
      return { rows: [] };
    }
    if (statement.includes("INSERT INTO payer_freeze_autolimit_cursors")) {
      expect(transactionOpen).toBe(true);
      cursor = String(values[1]);
      return { rows: [] };
    }
    if (
      statement.includes("FROM payer_freeze_autolimit_events") &&
      statement.includes("processed_at IS NULL")
    )
      return {
        rows: [...events.values()]
          .filter((event) => !event.done)
          .toSorted((left, right) =>
            BigInt(left.block) === BigInt(right.block)
              ? left.index - right.index
              : BigInt(left.block) < BigInt(right.block)
                ? -1
                : 1,
          )
          .map((event) => ({
            block_number: event.block,
            log_index: event.index,
            transaction_hash: event.tx,
            auto_limits_lowered: event.lowered,
          })),
      };
    if (statement.includes("UPDATE payer_freeze_autolimit_events")) {
      if (statement.includes("auto_limits_lowered_at")) {
        const [vault, block, index] = values as [string, string, number];
        const event = events.get(`${vault}:${block}:${index}`);
        if (event) event.lowered = true;
        return { rows: [] };
      }
      const [vault, block, index] = values as [string, string, number];
      const event = events.get(`${vault}:${block}:${index}`);
      if (event) event.done = true;
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${statement}`);
  });
  return {
    pool: { query, connect: async () => ({ query, release: vi.fn() }) } as never,
    query,
    pending: () => [...events.values()].filter((row) => !row.done),
    eventRows: () => [...events.values()],
    hasUnloweredPending: () => [...events.values()].some((row) => !row.done && !row.lowered),
    cursor: () => cursor,
    committedCursors,
  };
}

describe("durable Frozen event work", () => {
  it("reports queued lowering as pending only until limits were lowered", async () => {
    const store = fakeStore();
    await enqueueEvent(store, { blockNumber: 1n, logIndex: 0, transactionHash: TX });
    expect(await hasPendingFrozenEvent(store.pool, VAULT)).toBe(true);
    const listener = vi.fn(async (_event, markLowered) => markLowered());
    await processPendingFrozenEvents(store.pool, VAULT, listener);
    expect(await hasPendingFrozenEvent(store.pool, VAULT)).toBe(false);
    expect(store.eventRows()[0]?.done).toBe(true);
  });

  it("reports queued Frozen lowering as pending for its vault", async () => {
    const query = vi.fn(async (_statement: string, values: unknown[]) => {
      expect(values).toEqual([VAULT]);
      return { rows: [{ pending: true }] };
    });
    expect(await hasPendingFrozenEvent({ query } as never, VAULT)).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("auto_limits_lowered_at IS NULL"), [
      VAULT,
    ]);
  });

  it("retries an unfinished lowering after Unfrozen without requiring frozen state", async () => {
    const store = fakeStore();
    const client = {
      getBlockNumber: vi.fn(async () => 20n),
      getContractEvents: vi.fn(async () => [{ blockNumber: 5n, logIndex: 3, transactionHash: TX }]),
    };
    await scanFrozenEvents(client as never, store.pool, VAULT, 9_999n);
    const listener = vi
      .fn<(_: VaultHaltEvent, markLowered: () => Promise<void>) => Promise<void>>()
      .mockRejectedValueOnce(new Error("K3 refused"))
      .mockResolvedValue(undefined);
    await expect(processPendingFrozenEvents(store.pool, VAULT, listener)).rejects.toThrow(
      "K3 refused",
    );
    expect(store.pending()).toHaveLength(1);

    await processPendingFrozenEvents(store.pool, VAULT, listener);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(
      {
        name: "Frozen",
        vault: VAULT,
        blockNumber: 5n,
        logIndex: 3,
        transactionHash: TX,
        autoLimitsLowered: false,
      },
      expect.any(Function),
    );
    expect(store.pending()).toHaveLength(0);
  });

  it("does not re-lower limits when draining failed after lowering", async () => {
    const store = fakeStore();
    await enqueueEvent(store, { blockNumber: 5n, logIndex: 3, transactionHash: TX });
    const listener = vi.fn(async (_event, markLowered) => {
      await markLowered();
      throw new Error("drain failed");
    });
    await expect(processPendingFrozenEvents(store.pool, VAULT, listener)).rejects.toThrow(
      "drain failed",
    );
    expect(store.hasUnloweredPending()).toBe(false);
    expect(store.pending()).toHaveLength(1);

    const retry = vi.fn(async (event: VaultHaltEvent) => {
      expect(event.autoLimitsLowered).toBe(true);
    });
    await processPendingFrozenEvents(store.pool, VAULT, retry);
    expect(retry).toHaveBeenCalledOnce();
    expect(store.pending()).toHaveLength(0);
  });

  it("continues queued work and collects failures per Frozen event", async () => {
    const store = fakeStore();
    await enqueueEvent(store, { blockNumber: 5n, logIndex: 0, transactionHash: TX });
    await enqueueEvent(store, {
      blockNumber: 6n,
      logIndex: 0,
      transactionHash: `0x${"22".repeat(32)}`,
    });
    await enqueueEvent(store, {
      blockNumber: 7n,
      logIndex: 0,
      transactionHash: `0x${"33".repeat(32)}`,
    });
    const listener = vi.fn(async (event: VaultHaltEvent, markLowered: () => Promise<void>) => {
      await markLowered();
      if (event.blockNumber !== 6n) throw new Error(`drain failed for block ${event.blockNumber}`);
    });

    await expect(processPendingFrozenEvents(store.pool, VAULT, listener)).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "drain failed for block 5" }),
        expect.objectContaining({ message: "drain failed for block 7" }),
      ],
    });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.eventRows()).toEqual([
      expect.objectContaining({ block: "5", lowered: true, done: false }),
      expect.objectContaining({ block: "6", lowered: true, done: true }),
      expect.objectContaining({ block: "7", lowered: true, done: false }),
    ]);
  });

  it("scans historical Frozen logs even when the vault is no longer frozen", async () => {
    const store = fakeStore();
    const client = {
      getBlockNumber: vi.fn(async () => 20n),
      getContractEvents: vi.fn(async () => [{ blockNumber: 5n, logIndex: 3, transactionHash: TX }]),
    };
    const listener = vi.fn(async () => undefined);
    await scanFrozenEvents(client as never, store.pool, VAULT, 9_999n);
    await processPendingFrozenEvents(store.pool, VAULT, listener as never);
    expect(client.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 0n, toBlock: 20n }),
    );
    expect(listener).toHaveBeenCalledOnce();
  });

  it("scans at most one successful page and resumes from its durable cursor", async () => {
    const store = fakeStore();
    const requests: { fromBlock: bigint; toBlock: bigint }[] = [];
    const client = {
      getBlockNumber: vi.fn(async () => 25_000n),
      getContractEvents: vi.fn(async (request: { fromBlock: bigint; toBlock: bigint }) => {
        requests.push(request);
        if (request.toBlock - request.fromBlock > 5_000n)
          throw Object.assign(new Error("range too large"), { code: -32012 });
        return [];
      }),
    };

    await expect(scanFrozenEvents(client as never, store.pool, VAULT, 9_999n)).resolves.toBe(false);

    expect(requests[0]).toMatchObject({ fromBlock: 0n, toBlock: 9_998n });
    expect(requests[1]).toMatchObject({ fromBlock: 0n, toBlock: 4_998n });
    expect(requests.every(({ toBlock, fromBlock }) => toBlock - fromBlock <= 9_998n)).toBe(true);
    expect(store.cursor()).toBe("4998");
    expect(store.committedCursors).toEqual(["4998"]);

    for (let page = 0; page < 5; page += 1)
      await scanFrozenEvents(client as never, store.pool, VAULT, 9_999n);
    expect(store.cursor()).toBe("25000");
    expect(await scanFrozenEvents(client as never, store.pool, VAULT, 9_999n)).toBe(true);
    client.getBlockNumber.mockResolvedValue(25_010n);
    expect(await scanFrozenEvents(client as never, store.pool, VAULT, 9_999n)).toBe(true);
    expect(requests.at(-1)?.fromBlock).toBe(25_001n);
    expect(store.cursor()).toBe("25010");
  });
});

async function enqueueEvent(
  store: ReturnType<typeof fakeStore>,
  event: { blockNumber: bigint; logIndex: number; transactionHash: typeof TX },
): Promise<void> {
  await store.query("BEGIN");
  await queueFrozenEvent(store.pool, VAULT, event);
  await store.query("COMMIT");
}
