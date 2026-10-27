import type { Address, PocketRecord } from "@czar/schemas";

export const EXTERNAL_ADDRESSES = {
  usdc: "0x3600000000000000000000000000000000000000",
  eip7708: "0xfffffffffffffffffffffffffffffffffffffffe",
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
  erc8183: "0x0747EEf0706327138c69792bF28Cd525089e4583",
} as const;

export function isKnownTransfer(
  from: Address,
  to: Address,
  knownAddresses: ReadonlySet<string>,
): boolean {
  const lowerFrom = from.toLowerCase();
  const lowerTo = to.toLowerCase();
  for (const known of knownAddresses) {
    const lowerKnown = known.toLowerCase();
    if (lowerFrom === lowerKnown || lowerTo === lowerKnown) return true;
  }
  return false;
}

export type ExternalLog = {
  log: { address: Address; logIndex: number };
  block: { number: bigint };
  transaction: { hash: `0x${string}` };
};

export function externalEventId(event: ExternalLog): string {
  return `${event.transaction.hash}:${event.log.logIndex}`;
}

export function pocketDelegateState(
  pocket: Pick<PocketRecord, "state">,
  delegateReady: boolean,
): PocketRecord["state"] {
  if (pocket.state === "Registered" || pocket.state === "DelegateReady") {
    return delegateReady ? "DelegateReady" : "Registered";
  }
  return pocket.state;
}
