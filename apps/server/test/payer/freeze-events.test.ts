import { describe, expect, it, vi } from "vitest";
import {
  freezeHandlingPending,
  hasPendingFrozenEvent,
  scanFrozenEvents,
  processPendingFrozenEvents,
} from "#src/payer/freeze-events";
import type { VaultHaltEvent } from "#src/payer/runtime";

const VAULT = "0x0000000000000000000000000000000000000001" as const;
const TX = `0x${"11".repeat(32)}` as const;

function fakeStore() {
  let cursor: string | undefined;
  let transactionOpen = false;
  const committedCursors: string[] = [];
  const events = new Map<string, { block: string; index: number; tx: string; done: boolean }>();
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
    if (statement.includes("INSERT INTO payer_freeze_autolimit_events")) {
      expect(transactionOpen).toBe(true);
      const [vault, block, index, tx] = values as [string, string, number, string];
      const key = `${vault}:${block}:${index}`;
      events.set(key, events.get(key) ?? { block, index, tx, done: false });
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
          })),
      };
    if (statement.includes("UPDATE payer_freeze_autolimit_events")) {
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
    cursor: () => cursor,
    committedCursors,
  };
}

describe("durable Frozen event work", () => {
  it("catches up a normal scan gap without forcing approval", async () => {
    const store = fakeStore();
    const client = {
      getBlockNumber: vi.fn(async () => 40n),
      getContractEvents: vi.fn(async () => []),
    };
    await expect(freezeHandlingPending(client as never, store.pool, VAULT, 9_999n)).resolves.toBe(
      false,
    );
    expect(store.cursor()).toBe("40");
  });

  it("reports queued Frozen lowering as pending for its vault", async () => {
    const query = vi.fn(async (_statement: string, values: unknown[]) => {
      expect(values).toEqual([VAULT]);
      return { rows: [{ pending: true }] };
    });
    expect(await hasPendingFrozenEvent({ query } as never, VAULT)).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("processed_at IS NULL"), [VAULT]);
  });

  it("retries an unfinished lowering after Unfrozen without requiring frozen state", async () => {
    const store = fakeStore();
    const client = {
      getBlockNumber: vi.fn(async () => 20n),
      getContractEvents: vi.fn(async () => [{ blockNumber: 5n, logIndex: 3, transactionHash: TX }]),
    };
    await scanFrozenEvents(client as never, store.pool, VAULT, 9_999n);
    const listener = vi
      .fn<(_: VaultHaltEvent) => Promise<void>>()
      .mockRejectedValueOnce(new Error("K3 refused"))
      .mockResolvedValue(undefined);
    await expect(processPendingFrozenEvents(store.pool, VAULT, listener)).rejects.toThrow(
      "K3 refused",
    );
    expect(store.pending()).toHaveLength(1);

    await processPendingFrozenEvents(store.pool, VAULT, listener);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({
      name: "Frozen",
      vault: VAULT,
      blockNumber: 5n,
      logIndex: 3,
      transactionHash: TX,
    });
    expect(store.pending()).toHaveLength(0);
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

  it("pages and shrinks oversized log scans, persisting each page before resuming", async () => {
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

    await scanFrozenEvents(client as never, store.pool, VAULT, 9_999n);

    expect(requests[0]).toMatchObject({ fromBlock: 0n, toBlock: 9_998n });
    expect(requests[1]).toMatchObject({ fromBlock: 0n, toBlock: 4_998n });
    expect(requests.every(({ toBlock, fromBlock }) => toBlock - fromBlock <= 9_998n)).toBe(true);
    expect(store.cursor()).toBe("25000");
    expect(store.committedCursors).toEqual(["4998", "9997", "14996", "19995", "24994", "25000"]);

    client.getBlockNumber.mockResolvedValue(25_010n);
    requests.length = 0;
    await scanFrozenEvents(client as never, store.pool, VAULT, 9_999n);
    expect(requests[0]?.fromBlock).toBe(25_001n);
    expect(store.cursor()).toBe("25010");
    expect(store.committedCursors.at(-1)).toBe("25010");
  });
});
