import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import type { Address } from "viem";
import { createDatabaseVaultEventSource } from "#src/payer/database-vault-event-source";
import { hasPendingFrozenEventAtCurrentHead } from "#src/payer/freeze-events";

const VAULT_ONE = "0x0000000000000000000000000000000000000001" as const;
const VAULT_TWO = "0x0000000000000000000000000000000000000002" as const;
const FACTORY = "0x0000000000000000000000000000000000000003" as const;

afterEach(() => vi.useRealTimers());

describe("database vault event source", () => {
  it("replays queued Frozen work even when a later historical scan fails", async () => {
    vi.useFakeTimers();
    const { pool } = fakePool(() => [VAULT_ONE]);
    const client = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "factory") return FACTORY;
        if (functionName === "guardianPaused") return false;
        throw new Error(`unexpected ${functionName}`);
      }),
      watchContractEvent: vi.fn(() => vi.fn()),
      getBlockNumber: vi.fn().mockResolvedValueOnce(20n).mockResolvedValue(40n),
      getContractEvents: vi
        .fn()
        .mockResolvedValueOnce([freezeLog(5n)])
        .mockRejectedValue(new Error("historical RPC unavailable")),
    };
    const source = createDatabaseVaultEventSource({
      pool,
      publicClient: client as never,
      config: loadConfig({ envFile: { "payer.vaultEventPollMs": 1000 } }),
      logger: { error: vi.fn() } as never,
    });
    const listener = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary lowering failure"))
      .mockResolvedValue(undefined);
    const subscription = source.subscribe(listener);

    await subscription.ready;
    expect(listener).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    subscription();
  });

  it("discovers vaults linked after startup and reconciles existing halt state", async () => {
    vi.useFakeTimers();
    let vaults: Address[] = [VAULT_ONE];
    const { pool } = fakePool(() => vaults);
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "factory") return FACTORY;
      if (functionName === "guardianPaused") return false;
      throw new Error(`unexpected ${functionName}`);
    });
    const getBlockNumber = vi.fn(async () => 20n);
    const getContractEvents = vi.fn(async () => [freezeLog(5n)]);
    const watchContractEvent = vi.fn((_request: Record<string, unknown>) => vi.fn());
    const source = createDatabaseVaultEventSource({
      pool,
      publicClient: {
        readContract,
        watchContractEvent,
        getBlockNumber,
        getContractEvents,
      } as never,
      config: loadConfig({ envFile: { "payer.vaultEventPollMs": 1000 } }),
      logger: { error: vi.fn() } as never,
    });
    let attempts = 0;
    const listener = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary drain failure");
    });
    const stop = source.subscribe(listener);
    await stop.ready;

    await vi.waitFor(() => expect(watchContractEvent).toHaveBeenCalledTimes(4));
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Frozen", vault: VAULT_ONE, blockNumber: 5n }),
      expect.any(Function),
    );
    vaults = [VAULT_ONE, VAULT_TWO];
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(watchContractEvent).toHaveBeenCalledTimes(8));
    expect(getContractEvents).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Frozen", vault: VAULT_TWO, blockNumber: 5n }),
      expect.any(Function),
    );
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
  });

  it("allows a later halt event after an unfreeze transition", async () => {
    const { pool } = fakePool(() => [VAULT_ONE]);
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "factory") return FACTORY;
      if (functionName === "guardianPaused") return false;
      throw new Error(`unexpected ${functionName}`);
    });
    const getBlockNumber = vi.fn(async () => 20n);
    const getContractEvents = vi.fn(async () => []);
    const watchContractEvent = vi.fn((_request: Record<string, unknown>) => vi.fn());
    const source = createDatabaseVaultEventSource({
      pool,
      publicClient: {
        readContract,
        watchContractEvent,
        getBlockNumber,
        getContractEvents,
      } as never,
      config: loadConfig(),
      logger: { error: vi.fn() } as never,
    });
    const listener = vi.fn(async () => undefined);
    const stop = source.subscribe(listener);
    await stop.ready;
    await vi.waitFor(() => expect(watchContractEvent).toHaveBeenCalledTimes(4));

    const unfreeze = watchContractEvent.mock.calls.find(
      ([request]) => request["eventName"] === "Unfrozen",
    )?.[0];
    const freeze = watchContractEvent.mock.calls.find(
      ([request]) => request["eventName"] === "Frozen",
    )?.[0];
    if (!unfreeze || !freeze) throw new Error("Expected freeze and unfreeze subscriptions.");
    await (freeze["onLogs"] as (logs: readonly { eventName: string }[]) => Promise<void>)([
      { ...freezeLog(5n), eventName: "Frozen" },
    ]);
    await (unfreeze["onLogs"] as (logs: readonly { eventName: string }[]) => Promise<void>)([
      { eventName: "Unfrozen" },
    ]);
    await (freeze["onLogs"] as (logs: readonly { eventName: string }[]) => Promise<void>)([
      { ...freezeLog(6n), eventName: "Frozen" },
    ]);

    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "Frozen", vault: VAULT_ONE, blockNumber: 5n }),
      expect.any(Function),
    );
    expect(listener).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "Frozen", vault: VAULT_ONE, blockNumber: 6n }),
      expect.any(Function),
    );
    stop();
  });

  it("advances one history page per poll and waits for initial catch-up", async () => {
    vi.useFakeTimers();
    const store = fakePool(() => [VAULT_ONE]);
    const pageRequests: { fromBlock: bigint; toBlock: bigint }[] = [];
    const client = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "factory") return FACTORY;
        if (functionName === "guardianPaused") return false;
        throw new Error(`unexpected ${functionName}`);
      }),
      watchContractEvent: vi.fn(() => vi.fn()),
      getBlockNumber: vi.fn(async () => 25n),
      getContractEvents: vi.fn(async (request: { fromBlock: bigint; toBlock: bigint }) => {
        pageRequests.push(request);
        return request.fromBlock === 0n ? [freezeLog(5n)] : [];
      }),
    };
    const subscription = createDatabaseVaultEventSource({
      pool: store.pool,
      publicClient: client as never,
      config: loadConfig({
        envFile: {
          "payer.vaultEventPollMs": 1000,
          "indexer.getLogsBlockRange": 10,
        },
      }),
      logger: { error: vi.fn() } as never,
    }).subscribe(vi.fn(async () => undefined));

    let ready = false;
    void subscription.ready.then(() => (ready = true));
    await vi.waitFor(() => expect(pageRequests).toHaveLength(1));
    expect(pageRequests[0]).toMatchObject({ fromBlock: 0n, toBlock: 9n });
    expect(store.targets().get(VAULT_ONE)).toBe("25");
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pageRequests).toHaveLength(2);
    expect(pageRequests[1]).toMatchObject({ fromBlock: 10n, toBlock: 19n });
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await subscription.ready;
    expect(pageRequests).toHaveLength(3);
    expect(pageRequests[2]).toMatchObject({ fromBlock: 20n, toBlock: 25n });
    subscription();
  });

  it("rechecks earlier vault cursors when a newer chain watermark arrives", async () => {
    vi.useFakeTimers();
    const store = fakePool(() => [VAULT_ONE, VAULT_TWO]);
    const heads = [9n, 20n, 20n];
    const pageRequests: { address: Address; fromBlock: bigint; toBlock: bigint }[] = [];
    const client = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "factory") return FACTORY;
        if (functionName === "guardianPaused") return false;
        throw new Error(`unexpected ${functionName}`);
      }),
      watchContractEvent: vi.fn(() => vi.fn()),
      getBlockNumber: vi.fn(async () => heads.shift() ?? 20n),
      getContractEvents: vi.fn(
        async (request: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
          pageRequests.push(request);
          return [];
        },
      ),
    };
    const subscription = createDatabaseVaultEventSource({
      pool: store.pool,
      publicClient: client as never,
      config: loadConfig({
        envFile: {
          "payer.vaultEventPollMs": 1000,
          "indexer.getLogsBlockRange": 100,
        },
      }),
      logger: { error: vi.fn() } as never,
    }).subscribe(vi.fn(async () => undefined));

    let ready = false;
    void subscription.ready.then(() => (ready = true));
    await vi.waitFor(() => expect(pageRequests).toHaveLength(1));
    expect(pageRequests[0]?.address).toBe(VAULT_ONE);
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pageRequests[1]?.address).toBe(VAULT_TWO);
    expect(ready).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await subscription.ready;
    expect(pageRequests[2]).toMatchObject({ address: VAULT_ONE, fromBlock: 10n, toBlock: 20n });
    subscription();
  });

  it("completes startup catch-up against its pinned target while the chain advances", async () => {
    vi.useFakeTimers();
    const store = fakePool(() => [VAULT_ONE, VAULT_TWO]);
    let head = 20n;
    const pageRequests: { address: Address; fromBlock: bigint; toBlock: bigint }[] = [];
    const client = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "factory") return FACTORY;
        if (functionName === "guardianPaused") return false;
        throw new Error(`unexpected ${functionName}`);
      }),
      watchContractEvent: vi.fn(() => vi.fn()),
      getBlockNumber: vi.fn(async () => {
        const observed = head;
        head += 10n;
        return observed;
      }),
      getContractEvents: vi.fn(
        async (request: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
          pageRequests.push(request);
          return [];
        },
      ),
    };
    const subscription = createDatabaseVaultEventSource({
      pool: store.pool,
      publicClient: client as never,
      config: loadConfig({
        envFile: {
          "payer.vaultEventPollMs": 1000,
          "indexer.getLogsBlockRange": 10,
        },
      }),
      logger: { error: vi.fn() } as never,
    }).subscribe(vi.fn(async () => undefined));

    let ready = false;
    void subscription.ready.then(() => (ready = true));
    await vi.waitFor(() => expect(pageRequests).toHaveLength(1));
    for (let poll = 0; poll < 5; poll += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(pageRequests).toHaveLength(poll + 2));
    }
    await subscription.ready;
    expect(ready).toBe(true);
    expect(pageRequests).toHaveLength(6);
    expect(pageRequests.at(-1)?.toBlock).toBe(20n);
    subscription();
  });

  it("catches a requested vault up despite background rotation on a growing chain", async () => {
    vi.useFakeTimers();
    const store = fakePool(() => [VAULT_ONE, VAULT_TWO]);
    let head = 5n;
    const pageRequests: { address: Address; fromBlock: bigint; toBlock: bigint }[] = [];
    const client = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "factory") return FACTORY;
        if (functionName === "guardianPaused") return false;
        throw new Error(`unexpected ${functionName}`);
      }),
      watchContractEvent: vi.fn(() => vi.fn()),
      getBlockNumber: vi.fn(async () => head++),
      getContractEvents: vi.fn(
        async (request: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
          pageRequests.push(request);
          return [];
        },
      ),
    };
    const subscription = createDatabaseVaultEventSource({
      pool: store.pool,
      publicClient: client as never,
      config: loadConfig({
        envFile: {
          "payer.vaultEventPollMs": 1000,
          "indexer.getLogsBlockRange": 10,
        },
      }),
      logger: { error: vi.fn() } as never,
    }).subscribe(vi.fn(async () => undefined));

    await vi.waitFor(() => expect(pageRequests).toHaveLength(1));
    expect(pageRequests[0]?.address).toBe(VAULT_ONE);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(pageRequests).toHaveLength(2));
    await subscription.ready;
    expect(pageRequests[1]?.address).toBe(VAULT_TWO);

    await expect(
      hasPendingFrozenEventAtCurrentHead(client as never, store.pool, VAULT_ONE, 10n),
    ).resolves.toBe(false);
    expect(pageRequests.at(-1)).toMatchObject({ address: VAULT_ONE, fromBlock: 6n, toBlock: 7n });
    expect(store.targets().get(VAULT_ONE)).toBe("7");
    subscription();
  });
});

function fakePool(vaults: () => readonly Address[]) {
  const cursors = new Map<string, string>();
  const targets = new Map<string, string>();
  const events = new Map<
    string,
    { block: string; index: number; tx: string; processed: boolean; lowered: boolean }
  >();
  const query = vi.fn(async (statement: string, values: unknown[] = []) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return { rows: [] };
    if (statement.includes("SELECT DISTINCT vault FROM users"))
      return { rows: vaults().map((vault) => ({ vault })) };
    if (statement.includes("SELECT last_scanned_block"))
      return {
        rows:
          cursors.get(String(values[0])) === undefined
            ? []
            : [{ last_scanned_block: cursors.get(String(values[0])) }],
      };
    if (statement.includes("AS pending")) {
      const vault = String(values[0]);
      const cursor = cursors.get(vault);
      return {
        rows: [
          {
            pending:
              cursor === undefined ||
              BigInt(cursor) < BigInt(targets.get(vault) ?? "0") ||
              [...events.entries()].some(
                ([key, event]) => key.startsWith(`${vault}:`) && !event.processed && !event.lowered,
              ),
          },
        ],
      };
    }
    if (statement.includes("INSERT INTO payer_freeze_autolimit_events")) {
      const [vault, block, index, tx] = values as [string, string, number, string];
      const key = `${vault}:${block}:${index}`;
      events.set(key, events.get(key) ?? { block, index, tx, processed: false, lowered: false });
      return { rows: [] };
    }
    if (statement.includes("INSERT INTO payer_freeze_autolimit_cursors")) {
      cursors.set(String(values[0]), String(values[1]));
      targets.set(String(values[0]), String(values[2]));
      return { rows: [] };
    }
    if (statement.includes("UPDATE payer_freeze_autolimit_cursors")) {
      const target = String(values[0]);
      const updatedVaults = values[1] as readonly string[];
      for (const vault of values[1] as readonly string[]) {
        if (BigInt(target) > BigInt(targets.get(vault) ?? "0")) targets.set(vault, target);
      }
      return {
        rows: updatedVaults.flatMap((vault) => {
          const lastScanned = cursors.get(vault);
          if (lastScanned === undefined) return [];
          return [{ vault, caught_up: BigInt(lastScanned) >= BigInt(targets.get(vault) ?? "0") }];
        }),
      };
    }
    if (statement.includes("SELECT block_number::text AS block_number"))
      return {
        rows: [...events.entries()]
          .filter(([key, event]) => key.startsWith(`${String(values[0])}:`) && !event.processed)
          .map(([, event]) => ({
            block_number: event.block,
            log_index: event.index,
            transaction_hash: event.tx,
            auto_limits_lowered: event.lowered,
          })),
      };
    if (statement.includes("UPDATE payer_freeze_autolimit_events")) {
      const [vault, block, index] = values as [string, string, number];
      const event = events.get(`${vault}:${block}:${index}`);
      if (event) {
        if (statement.includes("auto_limits_lowered_at")) event.lowered = true;
        else event.processed = true;
      }
      return { rows: [] };
    }
    throw new Error(`Unexpected database query: ${statement}`);
  });
  return {
    pool: { query, connect: async () => ({ query, release: vi.fn() }) } as never,
    query,
    targets: () => targets,
  };
}

function freezeLog(blockNumber: bigint) {
  return {
    blockNumber,
    logIndex: 0,
    transactionHash: `0x${"11".repeat(32)}` as const,
  };
}
