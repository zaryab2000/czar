import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import type { Address } from "viem";
import { createDatabaseVaultEventSource } from "#src/payer/database-vault-event-source";

const VAULT_ONE = "0x0000000000000000000000000000000000000001" as const;
const VAULT_TWO = "0x0000000000000000000000000000000000000002" as const;
const FACTORY = "0x0000000000000000000000000000000000000003" as const;

afterEach(() => vi.useRealTimers());

describe("database vault event source", () => {
  it("discovers vaults linked after startup and reconciles existing halt state", async () => {
    vi.useFakeTimers();
    let vaults: Address[] = [VAULT_ONE];
    const query = vi.fn(async () => ({ rows: vaults.map((vault) => ({ vault })) }));
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "factory") return FACTORY;
      if (functionName === "frozen") return true;
      if (functionName === "guardianPaused") return false;
      throw new Error(`unexpected ${functionName}`);
    });
    const watchContractEvent = vi.fn((_request: Record<string, unknown>) => vi.fn());
    const source = createDatabaseVaultEventSource({
      pool: { query } as never,
      publicClient: { readContract, watchContractEvent } as never,
      config: loadConfig({ envFile: { "payer.vaultEventPollMs": 1000 } }),
      logger: { error: vi.fn() } as never,
    });
    let attempts = 0;
    const listener = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary drain failure");
    });
    const stop = source.subscribe(listener);

    await vi.waitFor(() => expect(watchContractEvent).toHaveBeenCalledTimes(4));
    expect(listener).toHaveBeenCalledWith({ name: "Frozen", vault: VAULT_ONE });
    vaults = [VAULT_ONE, VAULT_TWO];
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(watchContractEvent).toHaveBeenCalledTimes(8));
    expect(listener).toHaveBeenCalledWith({ name: "Frozen", vault: VAULT_TWO });
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
  });

  it("allows a later halt event after an unfreeze transition", async () => {
    const query = vi.fn(async () => ({ rows: [{ vault: VAULT_ONE }] }));
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "factory") return FACTORY;
      if (functionName === "frozen") return true;
      if (functionName === "guardianPaused") return false;
      throw new Error(`unexpected ${functionName}`);
    });
    const watchContractEvent = vi.fn((_request: Record<string, unknown>) => vi.fn());
    const source = createDatabaseVaultEventSource({
      pool: { query } as never,
      publicClient: { readContract, watchContractEvent } as never,
      config: loadConfig(),
      logger: { error: vi.fn() } as never,
    });
    const listener = vi.fn(async () => undefined);
    const stop = source.subscribe(listener);
    await vi.waitFor(() => expect(watchContractEvent).toHaveBeenCalledTimes(4));

    const unfreeze = watchContractEvent.mock.calls.find(
      ([request]) => request["eventName"] === "Unfrozen",
    )?.[0];
    const freeze = watchContractEvent.mock.calls.find(
      ([request]) => request["eventName"] === "Frozen",
    )?.[0];
    if (!unfreeze || !freeze) throw new Error("Expected freeze and unfreeze subscriptions.");
    await (unfreeze["onLogs"] as (logs: readonly { eventName: string }[]) => Promise<void>)([
      { eventName: "Unfrozen" },
    ]);
    await (freeze["onLogs"] as (logs: readonly { eventName: string }[]) => Promise<void>)([
      { eventName: "Frozen" },
    ]);

    expect(listener).toHaveBeenNthCalledWith(1, { name: "Frozen", vault: VAULT_ONE });
    expect(listener).toHaveBeenNthCalledWith(2, { name: "Frozen", vault: VAULT_ONE });
    stop();
  });
});
