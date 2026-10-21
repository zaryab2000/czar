import { ponder } from "ponder:registry";
import { and, eq } from "drizzle-orm";
import { anchors, externalEvents, pockets, vaults } from "ponder:schema";
import type { Amount6, PocketRecord } from "@czar/schemas";
import type { Address } from "viem";
import { mirrorKey } from "@czar/indexer/mirrors";
import { normalizeTransferAmount } from "#src/amounts";
import { externalEventId, isKnownTransfer, pocketDelegateState } from "#src/external-events";
import { EXTERNAL_ADDRESSES } from "#src/external-events";

type Context = Parameters<Parameters<typeof ponder.on>[1]>[0]["context"];
type Event = Parameters<Parameters<typeof ponder.on>[1]>[0]["event"];
type TransferArgs = { from: Address; to: Address; value: bigint };
type AuthArgs = { authorizer: Address; nonce: `0x${string}` };

function jsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  }
  return value;
}

async function save(context: Context, event: Event, name: string, payload: unknown): Promise<void> {
  await context.db
    .insert(externalEvents)
    .values({
      id: externalEventId(event),
      emitter: event.log.address.toLowerCase(),
      name,
      block: event.block.number,
      payload: jsonValue(payload),
    })
    .onConflictDoNothing();
}

async function knownAddresses(context: Context): Promise<Set<string>> {
  const [knownVaults, knownPockets] = await Promise.all([
    context.db.sql.select().from(vaults),
    context.db.sql.select().from(pockets),
  ]);
  return new Set(
    [
      ...knownVaults.map((row) => row.id),
      ...knownPockets.map((row) => (row.mirror as { pocket: string }).pocket),
    ].map((address) => address.toLowerCase()),
  );
}

async function transfer(
  context: Context,
  event: Event,
  emitter: "usdc" | "eip7708",
): Promise<void> {
  const args = event.args as unknown as TransferArgs;
  if (!isKnownTransfer(args.from, args.to, await knownAddresses(context))) return;
  const amount: Amount6 = normalizeTransferAmount(emitter, args.value);
  await save(context, event, "Transfer", {
    from: args.from.toLowerCase(),
    to: args.to.toLowerCase(),
    amount,
  });
}

ponder.on("USDC:Transfer", async ({ event, context }) => transfer(context, event, "usdc"));
ponder.on("EIP7708System:Transfer", async ({ event, context }) =>
  transfer(context, event, "eip7708"),
);
ponder.on("USDC:AuthorizationUsed", async ({ event, context }) => {
  const args = event.args as unknown as AuthArgs;
  const vaultRows = await context.db.sql.select().from(vaults);
  if (!vaultRows.some((row) => row.id.toLowerCase() === args.authorizer.toLowerCase())) return;
  await save(context, event, "AuthorizationUsed", {
    authorizer: args.authorizer.toLowerCase(),
    nonce: args.nonce.toLowerCase(),
  });
});

const genericEvents = [
  ["GatewayWallet", "Deposited"],
  ["GatewayWallet", "BatchProcessed"],
  ["GatewayMinter", "AttestationUsed"],
  ["ERC8183", "JobCreated"],
  ["ERC8183", "BudgetSet"],
  ["ERC8183", "JobFunded"],
  ["ERC8183", "JobSubmitted"],
  ["ERC8183", "JobCompleted"],
  ["ERC8183", "JobRejected"],
  ["ERC8183", "JobExpired"],
  ["ERC8183", "PaymentReleased"],
  ["ERC8183", "Refunded"],
  ["ERC8183", "EvaluatorFeePaid"],
] as const;

ponder.on("OpenEvidenceLog:Committed", async ({ event, context }) => {
  const args = event.args;
  const known = await knownAddresses(context);
  if (!known.has(args.publisher.toLowerCase())) return;
  const id = `${args.publisher.toLowerCase()}:${args.kind}:${args.seq}`;
  await context.db
    .insert(anchors)
    .values({
      id,
      publisher: args.publisher.toLowerCase(),
      kind: args.kind,
      seq: args.seq.toString(),
      root: args.root.toLowerCase(),
      prev: args.prev.toLowerCase(),
      uriHash: args.uriHash.toLowerCase(),
      uri: args.uri,
      block: event.block.number,
      transaction: event.transaction.hash.toLowerCase(),
    })
    .onConflictDoNothing();
  await save(context, event, "Committed", args);
});

ponder.on("OpenEvidenceLog:Revealed", async ({ event, context }) => {
  const args = event.args;
  if (!(await knownAddresses(context)).has(args.publisher.toLowerCase())) return;
  const [anchor] = await context.db.sql
    .select()
    .from(anchors)
    .where(
      and(
        eq(anchors.publisher, args.publisher.toLowerCase()),
        eq(anchors.kind, 0),
        eq(anchors.root, args.intentRoot.toLowerCase()),
      ),
    );
  if (anchor) {
    await context.db
      .update(anchors, { id: anchor.id })
      .set({ batchRoot: args.batchRoot.toLowerCase() });
  }
  await save(context, event, "Revealed", args);
});

for (const name of ["DelegateAdded", "DelegateRemoved"] as const) {
  const eventName = `GatewayWallet:${name}` as Parameters<typeof ponder.on>[0];
  ponder.on(eventName, async ({ event, context }) => {
    const args = event.args as unknown as { token: Address; depositor: Address; delegate: Address };
    await save(context, event, name, args);
    if (args.token.toLowerCase() !== EXTERNAL_ADDRESSES.usdc.toLowerCase()) return;
    const id = mirrorKey(args.delegate, args.depositor);
    const row = await context.db.find(pockets, { id });
    if (!row) return;
    const previous = row.mirror as PocketRecord;
    const state = pocketDelegateState(previous, name === "DelegateAdded");
    if (state !== previous.state) {
      await context.db.update(pockets, { id }).set({ mirror: { ...previous, state } });
    }
  });
}

for (const [contract, name] of genericEvents) {
  const eventName = `${contract}:${name}` as Parameters<typeof ponder.on>[0];
  ponder.on(eventName, async ({ event, context }) => {
    const args = event.args as unknown as Record<string, unknown>;
    const known = await knownAddresses(context);
    const addresses = Object.values(args).filter(
      (value): value is Address => typeof value === "string" && /^0x[\da-fA-F]{40}$/.test(value),
    );
    if (!addresses.some((address) => known.has(address.toLowerCase()))) return;
    const normalized = Object.fromEntries(
      Object.entries(args).map(([key, value]) => [
        key,
        typeof value === "bigint" && ["amount", "value"].includes(key)
          ? normalizeTransferAmount("usdc", value)
          : value,
      ]),
    );
    await save(context, event, name, normalized);
  });
}
