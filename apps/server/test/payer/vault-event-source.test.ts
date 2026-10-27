import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";
import { loadConfig } from "@czar/config";
import { createVaultEventSource } from "#src/payer/vault-event-source";

const VAULT = "0x0000000000000000000000000000000000000001" as Address;
const FACTORY = "0x0000000000000000000000000000000000000002" as Address;

describe("createVaultEventSource", () => {
  let watchContractEvent: ReturnType<typeof vi.fn>;
  let unwatch: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    unwatch = Object.fromEntries(
      ["Frozen", "Unfrozen", "GuardianPaused", "GuardianUnpaused"].map((name) => [name, vi.fn()]),
    );
    watchContractEvent = vi.fn(
      (request: Record<string, unknown>) => unwatch[String(request["eventName"])],
    );
  });

  it("watches vault halt and recovery events using configured polling", async () => {
    const client = mockClient(watchContractEvent);
    const source = createVaultEventSource(
      client,
      VAULT,
      loadConfig({ envFile: { "payer.vaultEventPollMs": 2_500 } }),
    );

    const subscription = source.subscribe(vi.fn(async () => undefined));
    await subscription.ready;

    expect(watchContractEvent).toHaveBeenCalledTimes(4);
    expect(watchContractEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        address: VAULT,
        abi: czarVaultAbi,
        eventName: "Unfrozen",
        pollingInterval: 2_500,
      }),
    );
    expect(watchContractEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        address: VAULT,
        abi: czarVaultAbi,
        eventName: "Frozen",
        pollingInterval: 2_500,
      }),
    );
    expect(watchContractEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        address: FACTORY,
        abi: czarVaultFactoryAbi,
        eventName: "GuardianPaused",
        pollingInterval: 2_500,
      }),
    );
    expect(watchContractEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        address: FACTORY,
        abi: czarVaultFactoryAbi,
        eventName: "GuardianUnpaused",
        pollingInterval: 2_500,
      }),
    );
  });

  it("maps halt and recovery events to the configured vault and unsubscribes", async () => {
    const client = mockClient(watchContractEvent);
    const source = createVaultEventSource(client, VAULT);
    const listener = vi.fn(async () => undefined);
    const unsubscribe = source.subscribe(listener);
    await unsubscribe.ready;
    const frozen = watchContractEvent.mock.calls.find(
      ([request]) => request["eventName"] === "Frozen",
    )?.[0];
    const unfrozen = watchContractEvent.mock.calls.find(
      ([request]) => request["eventName"] === "Unfrozen",
    )?.[0];
    const paused = watchContractEvent.mock.calls.find(
      ([request]) => request["eventName"] === "GuardianPaused",
    )?.[0];
    const unpaused = watchContractEvent.mock.calls.find(
      ([request]) => request["eventName"] === "GuardianUnpaused",
    )?.[0];

    if (!frozen || !unfrozen || !paused || !unpaused)
      throw new Error("Expected all four vault event subscriptions.");
    await (frozen["onLogs"] as (logs: readonly { eventName: string }[]) => Promise<void>)([
      { eventName: "Frozen" },
    ]);
    await (paused["onLogs"] as (logs: readonly { eventName: string }[]) => Promise<void>)([
      { eventName: "GuardianPaused" },
    ]);
    await (unfrozen["onLogs"] as (logs: readonly { eventName: string }[]) => Promise<void>)([
      { eventName: "Unfrozen" },
    ]);
    await (unpaused["onLogs"] as (logs: readonly { eventName: string }[]) => Promise<void>)([
      { eventName: "GuardianUnpaused" },
    ]);

    expect(listener).toHaveBeenNthCalledWith(1, { name: "Frozen", vault: VAULT });
    expect(listener).toHaveBeenNthCalledWith(2, { name: "GuardianPaused", vault: VAULT });
    expect(listener).toHaveBeenNthCalledWith(3, { name: "Unfrozen", vault: VAULT });
    expect(listener).toHaveBeenNthCalledWith(4, { name: "GuardianUnpaused", vault: VAULT });
    unsubscribe();
    for (const cleanup of Object.values(unwatch)) expect(cleanup).toHaveBeenCalledOnce();
  });
});

function mockClient(watchContractEvent: ReturnType<typeof vi.fn>): PublicClient {
  return {
    readContract: vi.fn(async () => FACTORY),
    watchContractEvent,
  } as unknown as PublicClient;
}
