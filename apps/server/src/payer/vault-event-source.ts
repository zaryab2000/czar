import { loadConfig, type Config } from "@czar/config";
import { createLogger, type Logger } from "@czar/logging";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";
import type { Address, Hex, PublicClient } from "viem";
import type {
  VaultHaltEvent,
  VaultHaltEventSource,
  VaultHaltEventSubscription,
} from "#src/payer/runtime";

export function createVaultEventSource(
  client: PublicClient,
  vaultAddress: Address,
  config: Config = loadConfig(),
  logger: Logger = createLogger({ service: "server", component: "CZ-15" }),
): VaultHaltEventSource {
  const pollingInterval = Number(config.get("payer.vaultEventPollMs"));
  return {
    subscribe(listener) {
      let stopped = false;
      const unsubscribe: (() => void)[] = [];
      const ready = watchEvents(
        client,
        vaultAddress,
        pollingInterval,
        listener,
        unsubscribe,
        () => stopped,
      ).catch(() =>
        logger.error("vault_event_subscription_failed", {
          rule: "vault_event_source",
          state: "error",
        }),
      );
      const stop = () => {
        stopped = true;
        for (const unsubscribeListener of unsubscribe) unsubscribeListener();
      };
      return Object.assign(stop, { ready }) as VaultHaltEventSubscription;
    },
  };
}

async function watchEvents(
  client: PublicClient,
  vaultAddress: Address,
  pollingInterval: number,
  listener: (event: VaultHaltEvent) => Promise<void>,
  unsubscribe: (() => void)[],
  isStopped: () => boolean,
): Promise<void> {
  const factory = await client.readContract({
    address: vaultAddress,
    abi: czarVaultAbi,
    functionName: "factory",
  });
  if (isStopped()) return;
  unsubscribe.push(
    client.watchContractEvent({
      address: vaultAddress,
      abi: czarVaultAbi,
      eventName: "Frozen",
      pollingInterval,
      onLogs: (logs) => notifyListeners(logs, "Frozen", vaultAddress, listener),
    }),
    client.watchContractEvent({
      address: vaultAddress,
      abi: czarVaultAbi,
      eventName: "Unfrozen",
      pollingInterval,
      onLogs: (logs) => notifyListeners(logs, "Unfrozen", vaultAddress, listener),
    }),
    client.watchContractEvent({
      address: factory,
      abi: czarVaultFactoryAbi,
      eventName: "GuardianPaused",
      pollingInterval,
      onLogs: (logs) => notifyListeners(logs, "GuardianPaused", vaultAddress, listener),
    }),
    client.watchContractEvent({
      address: factory,
      abi: czarVaultFactoryAbi,
      eventName: "GuardianUnpaused",
      pollingInterval,
      onLogs: (logs) => notifyListeners(logs, "GuardianUnpaused", vaultAddress, listener),
    }),
  );
}

async function notifyListeners(
  logs: readonly {
    readonly eventName?: string;
    readonly blockNumber?: bigint | null;
    readonly logIndex?: number | null;
    readonly transactionHash?: Hex | null;
  }[],
  eventName: "Frozen" | "Unfrozen" | "GuardianPaused" | "GuardianUnpaused",
  vault: Address,
  listener: (event: VaultHaltEvent) => Promise<void>,
): Promise<void> {
  for (const log of logs) {
    if (log.eventName !== eventName) continue;
    await listener({
      name: eventName,
      vault,
      ...(log.blockNumber === null || log.blockNumber === undefined
        ? {}
        : { blockNumber: log.blockNumber }),
      ...(log.logIndex === null || log.logIndex === undefined ? {} : { logIndex: log.logIndex }),
      ...(log.transactionHash === null || log.transactionHash === undefined
        ? {}
        : { transactionHash: log.transactionHash }),
    });
  }
}
