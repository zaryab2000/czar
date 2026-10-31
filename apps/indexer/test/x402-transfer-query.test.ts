import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { externalEvents, indexerProgress } from "@czar/indexer/schema";
import { createIndexerApi } from "#src/api/router";
import { createQueryStore } from "#src/api/store";
import { createQueryDatabase } from "#test/query-db";

const PAYER = "0x0000000000000000000000000000000000000001";
const PAYEE = "0x0000000000000000000000000000000000000002";
const USDC = "0x3600000000000000000000000000000000000000";
const NONCE = `0x${"11".repeat(32)}`;
const TRANSFER_TX = `0x${"22".repeat(32)}`;
const BOOKING_TX = `0x${"33".repeat(32)}`;
const BLOCK_HASH = `0x${"44".repeat(32)}`;
const NETWORK = "eip155:5042002";

type Db = Awaited<ReturnType<typeof createQueryDatabase>>["db"];
let db: Db;

beforeEach(async () => {
  ({ db } = await createQueryDatabase());
});

function route(overrides: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    network: NETWORK,
    vault: PAYER,
    nonce: NONCE,
    payTo: PAYEE,
    amount: "1000",
    asset: USDC,
    ...overrides,
  });
  return `/settlements/x402-transfer?${query}`;
}

async function seedTransfer(
  tx: string,
  changes: {
    readonly authorizer?: string;
    readonly nonce?: string;
    readonly from?: string;
    readonly to?: string;
    readonly amount?: string;
    readonly emitter?: string;
  } = {},
): Promise<void> {
  await db
    .insert(indexerProgress)
    .values({ network: NETWORK, indexedHead: 10n })
    .onConflictDoUpdate({ target: indexerProgress.network, set: { indexedHead: 10n } });
  await db.insert(externalEvents).values([
    {
      id: `${tx}:0`,
      emitter: changes.emitter ?? USDC,
      name: "AuthorizationUsed",
      block: 10n,
      blockHash: BLOCK_HASH,
      payload: { authorizer: changes.authorizer ?? PAYER, nonce: changes.nonce ?? NONCE },
    },
    {
      id: `${tx}:1`,
      emitter: changes.emitter ?? USDC,
      name: "Transfer",
      block: 10n,
      blockHash: BLOCK_HASH,
      payload: {
        from: changes.from ?? PAYER,
        to: changes.to ?? PAYEE,
        amount: changes.amount ?? "1000",
      },
    },
  ]);
}

describe("exact indexed x402 transfer lookup", () => {
  it("rejects malformed payment identifiers without querying transfer facts", async () => {
    const app = createIndexerApi(createQueryStore(db));
    for (const query of [
      route({ nonce: "0x1" }),
      route({ vault: "not-an-address" }),
      route({ amount: "0001" }),
      route({ asset: "not-an-address" }),
      route({ network: "" }),
    ]) {
      const response = await app.request(query);
      expect(response.status).toBe(400);
    }
  });

  it("rejects a payment on another network or asset before lookup", async () => {
    await seedTransfer(TRANSFER_TX);
    const app = createIndexerApi(createQueryStore(db));
    for (const query of [
      route({ network: "eip155:1" }),
      route({ asset: "0x0000000000000000000000000000000000000004" }),
    ]) {
      expect((await app.request(query)).status).toBe(400);
    }
  });

  it("returns only the unique transaction with a same-tx USDC authorization and transfer", async () => {
    await seedTransfer(TRANSFER_TX);
    await db
      .update(indexerProgress)
      .set({ indexedHead: 11n })
      .where(eq(indexerProgress.network, NETWORK));
    const response = await createIndexerApi(createQueryStore(db)).request(route());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      transferTx: TRANSFER_TX,
      blockNumber: "10",
      blockHash: BLOCK_HASH,
      authorizationUsed: { logIndex: 0, emitter: USDC },
      transfer: { logIndex: 1, emitter: USDC, from: PAYER, to: PAYEE, value: "1000" },
      indexedHead: "11",
    });
  });

  it("counts the USDC transfer once when Arc also emits the native-transfer mirror", async () => {
    await seedTransfer(TRANSFER_TX);
    await db.insert(externalEvents).values({
      id: `${TRANSFER_TX}:2`,
      emitter: "0xfffffffffffffffffffffffffffffffffffffffe",
      name: "Transfer",
      block: 10n,
      blockHash: BLOCK_HASH,
      payload: { from: PAYER, to: PAYEE, amount: "1000000000000000" },
    });
    const response = await createIndexerApi(createQueryStore(db)).request(route());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      transfer: {
        logIndex: 1,
        emitter: USDC,
        from: PAYER,
        to: PAYEE,
        value: "1000",
      },
    });
  });

  it("withholds transfer proof until the indexer progress covers its block", async () => {
    await seedTransfer(TRANSFER_TX);
    await db
      .update(indexerProgress)
      .set({ indexedHead: 9n })
      .where(eq(indexerProgress.network, NETWORK));
    const response = await createIndexerApi(createQueryStore(db)).request(route());
    expect(response.status).toBe(503);
  });

  it.each([
    ["nonce", { nonce: `0x${"44".repeat(32)}` }],
    ["authorizer", { authorizer: "0x0000000000000000000000000000000000000004" }],
    ["payer", { from: "0x0000000000000000000000000000000000000004" }],
    ["payee", { to: "0x0000000000000000000000000000000000000004" }],
    ["amount", { amount: "1001" }],
    ["asset", { emitter: "0x0000000000000000000000000000000000000004" }],
  ])("rejects a mismatched %s", async (_name, changes) => {
    await seedTransfer(TRANSFER_TX, changes);
    const response = await createIndexerApi(createQueryStore(db)).request(route());
    expect(response.status).toBe(404);
  });

  it("rejects a vault booking transaction without exact USDC transfer logs", async () => {
    await db.insert(externalEvents).values({
      id: `${BOOKING_TX}:0`,
      emitter: PAYER,
      name: "Settled",
      block: 10n,
      blockHash: BLOCK_HASH,
      payload: { nonce: NONCE },
    });
    const response = await createIndexerApi(createQueryStore(db)).request(route());
    expect(response.status).toBe(404);
  });

  it("rejects a transfer in a different transaction", async () => {
    await seedTransfer(TRANSFER_TX);
    await db.delete(externalEvents);
    await db.insert(externalEvents).values([
      {
        id: `${TRANSFER_TX}:0`,
        emitter: USDC,
        name: "AuthorizationUsed",
        block: 10n,
        blockHash: BLOCK_HASH,
        payload: { authorizer: PAYER, nonce: NONCE },
      },
      {
        id: `${BOOKING_TX}:1`,
        emitter: USDC,
        name: "Transfer",
        block: 10n,
        blockHash: BLOCK_HASH,
        payload: { from: PAYER, to: PAYEE, amount: "1000" },
      },
    ]);
    const response = await createIndexerApi(createQueryStore(db)).request(route());
    expect(response.status).toBe(404);
  });

  it("fails closed when two matching transfer transactions are indexed", async () => {
    await seedTransfer(TRANSFER_TX);
    await seedTransfer(BOOKING_TX);
    const logger = { error: vi.fn() };
    const response = await createIndexerApi(
      createQueryStore(db),
      undefined,
      undefined,
      logger,
    ).request(route());
    expect(response.status).toBe(409);
    expect(logger.error).toHaveBeenCalledWith("indexer_transfer_ambiguous", {
      vault: PAYER,
      hash: NONCE,
    });
  });

  it("fails closed when one transaction contains duplicate matching transfers", async () => {
    await seedTransfer(TRANSFER_TX);
    await db.insert(externalEvents).values({
      id: `${TRANSFER_TX}:2`,
      emitter: USDC,
      name: "Transfer",
      block: 10n,
      blockHash: BLOCK_HASH,
      payload: { from: PAYER, to: PAYEE, amount: "1000" },
    });
    const response = await createIndexerApi(createQueryStore(db), undefined, undefined, {
      error: vi.fn(),
    }).request(route());
    expect(response.status).toBe(409);
  });
});
