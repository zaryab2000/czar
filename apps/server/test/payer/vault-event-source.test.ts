import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";
import { loadConfig } from "@czar/config";
import { createVaultEventSource } from "#src/payer/vault-event-source";

const VAULT = "0x0000000000000000000000000000000000000001" as Address;
const FACTORY = "0x0000000000000000000000000000000000000002" as Address;

describe("createVaultEventSource", () => {
  let watchContractEvent: ReturnType<typeof vi.fn>;
  let unwatchFrozen: ReturnType<typeof vi.fn>;
  let unwatchPaused: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    unwatchFrozen = vi.fn();
    unwatchPaused = vi.fn();
    watchContractEvent = vi.fn((request: Record<string, unknown>) =>
      request["eventName"] === "Frozen" ? unwatchFrozen : unwatchPaused,
    );
  });

  it("watches vault Frozen and factory GuardianPaused using configured polling", async () => {
    const client = mockClient(watchContractEvent);
    const source = createVaultEventSource(
      client,
      VAULT,
      loadConfig({ envFile: { "payer.vaultEventPollMs": 2_500 } }),
    );

    source.subscribe(vi.fn(async () => undefined));
    await flushPromises();

    expect(watchContractEvent).toHaveBeenCalledTimes(2);
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
  });

  it("maps both event types to the configured vault and unsubscribes", async () => {
    const client = mockClient(watchContractEvent);
    const source = createVaultEventSource(client, VAULT);
    const listener = vi.fn(async () => undefined);
    const unsubscribe = source.subscribe(listener);
    await flushPromises();
    const frozen = watchContractEvent.mock.calls.find(
      ([request]) => request["eventName"] === "Frozen",
    )?.[0];
    const paused = watchContractEvent.mock.calls.find(
      ([request]) => request["eventName"] === "GuardianPaused",
    )?.[0];

    if (!frozen || !paused) throw new Error("Expected both vault event subscriptions.");
    await (frozen["onLogs"] as (logs: readonly { eventName: string }[]) => Promise<void>)([
      { eventName: "Frozen" },
    ]);
    await (paused["onLogs"] as (logs: readonly { eventName: string }[]) => Promise<void>)([
      { eventName: "GuardianPaused" },
    ]);

    expect(listener).toHaveBeenNthCalledWith(1, { name: "Frozen", vault: VAULT });
    expect(listener).toHaveBeenNthCalledWith(2, { name: "GuardianPaused", vault: VAULT });
    unsubscribe();
    expect(unwatchFrozen).toHaveBeenCalledOnce();
    expect(unwatchPaused).toHaveBeenCalledOnce();
  });
});

function mockClient(watchContractEvent: ReturnType<typeof vi.fn>): PublicClient {
  return {
    readContract: vi.fn(async () => FACTORY),
    watchContractEvent,
  } as unknown as PublicClient;
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
