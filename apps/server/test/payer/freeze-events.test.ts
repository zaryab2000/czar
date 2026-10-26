import { describe, expect, it, vi } from "vitest";
import { scanFrozenEvents, processPendingFrozenEvents } from "#src/payer/freeze-events";
import type { VaultHaltEvent } from "#src/payer/runtime";

const VAULT = "0x0000000000000000000000000000000000000001" as const;
const TX = `0x${"11".repeat(32)}` as const;

function fakeStore() {
  let cursor: string | undefined;
  const events = new Map<string, { block: string; index: number; tx: string; done: boolean }>();
  const query = vi.fn(async (statement: string, values: unknown[] = []) => {
    if (statement.includes("SELECT last_scanned_block"))
      return { rows: cursor === undefined ? [] : [{ last_scanned_block: cursor }] };
    if (statement.includes("INSERT INTO payer_freeze_autolimit_events")) {
      const [vault, block, index, tx] = values as [string, string, number, string];
      const key = `${vault}:${block}:${index}`;
      events.set(key, events.get(key) ?? { block, index, tx, done: false });
      return { rows: [] };
    }
    if (statement.includes("INSERT INTO payer_freeze_autolimit_cursors")) {
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
    pool: { query } as never,
    query,
    pending: () => [...events.values()].filter((row) => !row.done),
  };
}

describe("durable Frozen event work", () => {
  it("retries an unfinished lowering after Unfrozen without requiring frozen state", async () => {
    const store = fakeStore();
    const client = {
      getBlockNumber: vi.fn(async () => 20n),
      getContractEvents: vi.fn(async () => [{ blockNumber: 5n, logIndex: 3, transactionHash: TX }]),
    };
    await scanFrozenEvents(client as never, store.pool, VAULT);
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
    await scanFrozenEvents(client as never, store.pool, VAULT);
    await processPendingFrozenEvents(store.pool, VAULT, listener as never);
    expect(client.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 0n, toBlock: 20n }),
    );
    expect(listener).toHaveBeenCalledOnce();
  });
});
