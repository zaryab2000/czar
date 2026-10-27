import { readFileSync } from "node:fs";
import { loadConfig } from "@czar/config";
import { derivedNonce } from "@czar/hashing";
import {
  validateEnvelope,
  validateJobRecord,
  validatePocketRecord,
  validateReservation,
  validationErrors,
} from "@czar/schemas";
import {
  anchors,
  authorizations,
  haltFlags,
  indexedEvents,
  envelopes,
  escrowJobs,
  gatewayTransfers,
  jobs,
  manualReturns,
  pockets,
  pocketBalances,
  pullbacks,
  reservations,
  vaults,
} from "@czar/indexer/schema";
import { envelopeMirror, jobMirror, pocketMirror, reservationMirror } from "@czar/indexer/mirrors";
import type { Address, Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { createIndexerApi } from "#src/api/router";
import { createQueryStore, PULLBACK_CANCEL_DELAY_BLOCKS } from "#src/api/store";
import { createQueryDatabase } from "#test/query-db";

const VAULT: Address = "0x00000000000000000000000000000000000c2a21";
const OTHER_VAULT: Address = "0x00000000000000000000000000000000000c2a99";
const PAYEE: Address = "0x00000000000000000000000000000000000c2a22";
const POCKET: Address = "0x00000000000000000000000000000000000c2a23";
const ESCROW: Address = "0x0747eef0706327138c69792bf28cd525089e4583";
const PUBLISHER: Address = "0x00000000000000000000000000000000000c2a24";
const HASH = `0x${"a".repeat(64)}` as Hex;
const ZERO = `0x${"0".repeat(64)}` as Hex;
const hash = (c: string) => `0x${c.repeat(64)}` as Hex;
const lower = (a: string) => a.toLowerCase();

type Db = Awaited<ReturnType<typeof createQueryDatabase>>["db"];
let db: Db;

const envelopeView = (envelopeId: bigint) => ({
  cap: 1_000_000n,
  maxStepAmount: 100_000n,
  spent: 0n,
  reserved: 0n,
  pocketOutstanding: 0n,
  jobEscrowed: 0n,
  shortfall: 0n,
  categoryId: HASH,
  objectiveHash: HASH,
  planHash: HASH,
  payeeRoot: HASH,
  pocket: POCKET,
  expiresAt: 10_000n + envelopeId,
  pocketCapBps: 2500,
  state: 1,
  approverIsOwner: true,
});

async function seedEnvelope(vault: Address, envelopeId: bigint): Promise<string> {
  const mirror = envelopeMirror({
    vault,
    envelopeId,
    view: envelopeView(envelopeId),
    approvalTx: HASH,
    block: 1n,
    timestamp: 1n,
    closeStarted: false,
  });
  await db.insert(envelopes).values({
    id: `${lower(vault)}:${envelopeId}`,
    vault: lower(vault),
    envelopeId,
    envelopeRef: mirror.envelopeRef,
    mirror,
  });
  return mirror.envelopeRef;
}

async function seedReservation(
  vault: Address,
  reservationId: bigint,
  input: { state: number; validBefore: bigint; count?: number; settledMask?: bigint },
): Promise<void> {
  const count = input.count ?? 1;
  const view = {
    envelopeId: 1n,
    stepIndex: 0,
    payee: PAYEE,
    unitAmount: 100n,
    count,
    validBefore: input.validBefore,
    mode: 1,
    state: input.state,
    settledCount: 0,
    releasedCount: 0,
    settledMask: input.settledMask ?? 0n,
  };
  const mirror = reservationMirror(vault, reservationId, view);
  await db.insert(reservations).values({
    id: `${lower(vault)}:${String(reservationId).padStart(4, "0")}`,
    vault: lower(vault),
    reservationId,
    envelopeId: 1n,
    stepIndex: 0,
    state: mirror.state,
    validBefore: input.validBefore,
    mirror,
  });
}

async function seedAuthorization(
  vault: Address,
  reservationId: bigint,
  index: number,
  input: { used?: boolean; settled?: boolean; released?: boolean; createdAt: string },
): Promise<void> {
  await db.insert(authorizations).values({
    id: `${lower(vault)}:${reservationId}:${index}`,
    vault: lower(vault),
    reservationId,
    index,
    nonce: derivedNonce(vault, reservationId, index),
    amount: "100",
    used: input.used ?? false,
    settled: input.settled ?? false,
    released: input.released ?? false,
    settlementTx: input.settled ? hash("b") : null,
    createdAt: input.createdAt,
  });
}

async function seedJob(
  jobId: bigint,
  vaultState: number,
  escrowStatus: string | null,
  createdAt = "2026-10-21T00:00:10.000Z",
): Promise<void> {
  const jobKey = hash(String(jobId));
  const mirror = jobMirror({
    vault: VAULT,
    jobKey,
    jobEscrow: ESCROW,
    evaluator: PAYEE,
    descriptionHash: ZERO,
    view: {
      provider: PAYEE,
      envelopeId: 1n,
      stepIndex: 1,
      state: vaultState,
      expiredAt: 1000n,
      jobId,
      reservedCap: 500n,
      budget: 400n,
    },
  });
  await db.insert(jobs).values({
    id: `${lower(VAULT)}:job${jobId}`,
    vault: lower(VAULT),
    envelopeId: 1n,
    jobEscrow: lower(ESCROW),
    jobId: String(jobId),
    stepIndex: 1,
    state: mirror.state,
    createdAt,
    mirror,
  });
  if (escrowStatus) {
    await db.insert(escrowJobs).values({
      id: `${lower(ESCROW)}:${jobId}`,
      jobEscrow: lower(ESCROW),
      jobId: String(jobId),
      status: escrowStatus,
      block: 5n,
    });
  }
}

beforeEach(async () => {
  ({ db } = await createQueryDatabase());
});

describe("T-034 query store (SQL)", () => {
  it("returns manual return credits only for the requested vault", async () => {
    await db.insert(manualReturns).values([
      {
        id: `${lower(VAULT)}:${hash("a")}:1`,
        vault: lower(VAULT),
        pocket: lower(POCKET),
        credit: "700",
        txHash: hash("a"),
        logIndex: 1,
        block: 9n,
      },
      {
        id: `${lower(VAULT)}:${hash("b")}:2`,
        vault: lower(VAULT),
        pocket: lower(POCKET),
        credit: "300",
        txHash: hash("b"),
        logIndex: 2,
        block: 9n,
      },
      {
        id: `${lower(OTHER_VAULT)}:${hash("c")}:0`,
        vault: lower(OTHER_VAULT),
        pocket: lower(POCKET),
        credit: "999",
        txHash: hash("c"),
        logIndex: 0,
        block: 8n,
      },
    ]);
    const app = createIndexerApi(createQueryStore(db), loadConfig());
    const response = await app.request(`/pockets/manual-returns?vault=${lower(VAULT)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        { pocket: lower(POCKET), credit: "700", txHash: hash("a"), block: "9", logIndex: 1 },
        { pocket: lower(POCKET), credit: "300", txHash: hash("b"), block: "9", logIndex: 2 },
      ],
    });
    const invalid = await app.request("/pockets/manual-returns?vault=bad");
    expect(invalid.status).toBe(400);
  });

  it("serves pocket balance ages, funded pockets and Closed pockets with balances", async () => {
    const fundedRef = await seedEnvelope(VAULT, 1n);
    await seedEnvelope(VAULT, 2n);
    const recordPocket = async (envelopeId: bigint, address: Address, state: number) => {
      const mirror = pocketMirror({
        vault: VAULT,
        pocket: address,
        view: {
          envelopeId,
          state,
          funded: 1000n,
          gasGranted: 1n,
          outstanding: 500n,
          pendingPullback: state === 4 ? 0n : 100n,
        },
        pullbacks: [],
        delegateReady: state === 1,
      });
      await db.insert(pockets).values({
        id: `${lower(VAULT)}:${lower(address)}`,
        vault: lower(VAULT),
        envelopeId,
        pocket: lower(address),
        mirror,
      });
    };
    await recordPocket(1n, POCKET, 1);
    const closedPocket = "0x00000000000000000000000000000000000c2a25" as Address;
    await recordPocket(2n, closedPocket, 4);
    const observedAt = new Date().toISOString();
    await db.insert(pocketBalances).values([
      {
        pocket: lower(POCKET),
        vault: lower(VAULT),
        gatewayAvailableAtomic: "750",
        gatewayPendingBatchAtomic: "25",
        gatewayWithdrawingAtomic: "0",
        withdrawalBlock: 0n,
        pocketUsdcAtomic: "0",
        apiObservedAt: observedAt,
        chainObservedBlock: 100n,
        apiConsecutiveFailures: 0,
        apiLastError: null,
        closedZeroSince: null,
        pollEndedAt: null,
      },
      {
        pocket: lower(closedPocket),
        vault: lower(VAULT),
        gatewayAvailableAtomic: "1",
        gatewayPendingBatchAtomic: "0",
        gatewayWithdrawingAtomic: "0",
        withdrawalBlock: 0n,
        pocketUsdcAtomic: "0",
        apiObservedAt: observedAt,
        chainObservedBlock: 100n,
        apiConsecutiveFailures: 0,
        apiLastError: null,
        closedZeroSince: null,
        pollEndedAt: null,
      },
    ]);
    await db.insert(indexedEvents).values({
      id: "head-event",
      emitter: lower(VAULT),
      name: "PocketFunded",
      block: 120n,
    });
    const app = createIndexerApi(createQueryStore(db), loadConfig());

    const balanceResponse = await app.request(`/pocket-balances/${lower(POCKET)}`);
    expect(balanceResponse.status).toBe(200);
    const balanceBody = await balanceResponse.json();
    expect(balanceBody).toMatchObject({
      pocket: lower(POCKET),
      gatewayAvailableAtomic: "750",
      gatewayPendingBatchAtomic: "25",
      apiAgeSeconds: expect.any(Number),
      chainAgeBlocks: "20",
      slowWithdrawalOpen: false,
    });
    expect(balanceBody).not.toHaveProperty("closedZeroSince");
    expect(balanceBody).not.toHaveProperty("pocketUsdcAtomic");
    expect(balanceBody).not.toHaveProperty("pollEndedAt");
    const fundedResponse = await app.request(`/pockets/funded?vault=${lower(VAULT)}`);
    expect(await fundedResponse.json()).toMatchObject({
      items: [{ envelopeRef: fundedRef, outstanding: "500", pendingPullback: "100" }],
    });
    const closedResponse = await app.request("/pockets/closed-with-balance");
    const closedBody = await closedResponse.json();
    expect(closedBody).toMatchObject({
      items: [{ pocket: lower(closedPocket), pocketRecord: { state: "Closed" } }],
    });
    const closedItems = (closedBody as { items: Array<{ balance: Record<string, unknown> }> })
      .items;
    expect(closedItems[0]?.balance).not.toHaveProperty("closedZeroSince");
    expect(closedItems[0]?.balance).not.toHaveProperty("pocketUsdcAtomic");
    expect(closedItems[0]?.balance).not.toHaveProperty("pollEndedAt");
  });

  it("finds a vault by its owner and pages envelopes by vault", async () => {
    await db.insert(vaults).values({
      id: lower(VAULT),
      owner: lower(PAYEE),
      version: 1,
      agentSigner: lower(PAYEE),
      autonomySigner: lower(PAYEE),
      evaluator: lower(PAYEE),
      createdBlock: 12n,
    });
    await seedEnvelope(VAULT, 1n);
    await seedEnvelope(VAULT, 2n);
    await seedEnvelope(OTHER_VAULT, 1n);
    const store = createQueryStore(db);

    expect((await store.vaultByOwner(lower(PAYEE)))?.["id"]).toBe(lower(VAULT));
    const first = await store.envelopesForVault(lower(VAULT), null, 1);
    const second = await store.envelopesForVault(lower(VAULT), { after: first[0]!.key }, 1);
    expect([...first, ...second].map((row) => row.item["envelopeId"])).toEqual([1, 2]);
  });

  it("pages reservationsNeedingFinalize in SQL across pages with no gaps or repeats", async () => {
    for (let id = 1n; id <= 7n; id += 1n) {
      await seedReservation(VAULT, id, { state: 1, validBefore: 100n + id });
    }
    await seedReservation(VAULT, 8n, { state: 3, validBefore: 101n }); // Final: excluded
    await seedReservation(VAULT, 9n, { state: 1, validBefore: 999n }); // not yet expired
    const store = createQueryStore(db);
    const first = await store.reservationsNeedingFinalize(200n, null, 3);
    expect(first).toHaveLength(3);
    const second = await store.reservationsNeedingFinalize(200n, { after: first[2]!.key }, 3);
    const third = await store.reservationsNeedingFinalize(200n, { after: second[2]!.key }, 3);
    const ids = [...first, ...second, ...third].map((row) => row.item["reservationId"]);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("finds reservations with a used but unsettled authorization, per vault", async () => {
    await seedReservation(VAULT, 1n, { state: 1, validBefore: 999n, count: 2 });
    await seedAuthorization(VAULT, 1n, 0, {
      used: true,
      settled: true,
      createdAt: "2026-10-21T00:00:01.000Z",
    });
    await seedAuthorization(VAULT, 1n, 1, { used: true, createdAt: "2026-10-21T00:00:01.000Z" });
    await seedReservation(VAULT, 2n, { state: 1, validBefore: 999n });
    await seedAuthorization(VAULT, 2n, 0, { used: false, createdAt: "2026-10-21T00:00:02.000Z" });
    await seedReservation(VAULT, 3n, { state: 3, validBefore: 1n });
    await seedAuthorization(VAULT, 3n, 0, { used: true, createdAt: "2026-10-21T00:00:03.000Z" });
    await seedReservation(OTHER_VAULT, 1n, { state: 1, validBefore: 999n });
    await seedAuthorization(OTHER_VAULT, 1n, 0, {
      used: true,
      createdAt: "2026-10-21T00:00:04.000Z",
    });
    const rows = await createQueryStore(db).reservationsNeedingSettle(lower(VAULT), null, 10);
    expect(rows.map((row) => row.item["reservationId"])).toEqual([1]);
  });

  it("confirms attested pullbacks and cancels unattested ones only after maxBlockHeight + delay", async () => {
    const seed = (id: number, attested: boolean, maxBlockHeight: bigint, state = "Pending") =>
      db.insert(pullbacks).values({
        id: `${lower(VAULT)}:${id}`,
        vault: lower(VAULT),
        pullbackId: BigInt(id),
        pocket: lower(POCKET),
        state,
        transferSpecHash: hash(String(id)),
        maxBlockHeight,
        attested,
      });
    await seed(1, true, 100n);
    await seed(2, false, 100n);
    await seed(3, false, 5000n);
    await seed(4, false, 100n, "Confirmed");
    const store = createQueryStore(db);
    const confirm = await store.pullbacksToConfirm(null, 10);
    expect(confirm.map((row) => row.item["pullbackId"])).toEqual(["1"]);
    const atBoundary = 100n + PULLBACK_CANCEL_DELAY_BLOCKS;
    expect(await store.pullbacksToCancel(atBoundary - 1n, null, 10)).toEqual([]);
    const cancel = await store.pullbacksToCancel(atBoundary, null, 10);
    expect(cancel.map((row) => row.item["pullbackId"])).toEqual(["2"]);
  });

  it("selects jobs syncJob would move, and jobs awaiting evaluation", async () => {
    await seedJob(1n, 1, "Funded"); // Opened, escrow funded -> sync
    await seedJob(2n, 1, "Open"); // nothing to do
    await seedJob(3n, 2, "Funded"); // Funded, escrow Funded -> nothing
    await seedJob(4n, 2, "Submitted"); // -> sync, and awaiting evaluation
    await seedJob(5n, 3, "Submitted"); // Submitted both -> nothing, awaiting evaluation
    await seedJob(6n, 3, "Rejected"); // -> sync (refund)
    await seedJob(7n, 4, "Completed"); // vault already Completed -> nothing
    await seedJob(8n, 1, null); // no escrow event yet -> nothing
    const store = createQueryStore(db);
    const sync = await store.jobsToSync(null, 10);
    expect(sync.map((row) => (row.item["job"] as { jobId: string }).jobId)).toEqual([
      "1",
      "4",
      "6",
    ]);
    const awaiting = await store.jobsAwaitingEvaluation(null, 10);
    expect(awaiting.map((row) => row.item["jobId"])).toEqual(["4", "5"]);
  });

  it("returns receipt facts for all three rails with the SCR-119 status mapping, paged in order", async () => {
    const ref = await seedEnvelope(VAULT, 1n);
    await seedReservation(VAULT, 1n, { state: 1, validBefore: 999n, count: 3 });
    await seedAuthorization(VAULT, 1n, 0, {
      used: true,
      settled: true,
      createdAt: "2026-10-21T00:00:01.000Z",
    });
    await seedAuthorization(VAULT, 1n, 1, { used: true, createdAt: "2026-10-21T00:00:02.000Z" });
    await seedAuthorization(VAULT, 1n, 2, {
      released: true,
      createdAt: "2026-10-21T00:00:03.000Z",
    });
    await db.insert(pockets).values({
      id: `${lower(VAULT)}:${lower(POCKET)}`,
      vault: lower(VAULT),
      envelopeId: 1n,
      pocket: lower(POCKET),
      mirror: pocketMirror({
        vault: VAULT,
        pocket: POCKET,
        delegateReady: false,
        pullbacks: [],
        view: {
          envelopeId: 1n,
          state: 2,
          funded: 1000n,
          gasGranted: 0n,
          outstanding: 1000n,
          pendingPullback: 0n,
        },
      }),
    });
    const transfer = (id: string, status: string, createdAt: string) =>
      db.insert(gatewayTransfers).values({
        transferId: id,
        status,
        fromAddress: lower(POCKET),
        toAddress: lower(PAYEE),
        amount: "50",
        nonce: id,
        txHash: status === "completed" ? hash("c") : null,
        createdAt,
        updatedAt: createdAt,
        pocketAddress: lower(POCKET),
      });
    await transfer("t1", "batched", "2026-10-21T00:00:04Z");
    await transfer("t2", "completed", "2026-10-21T00:00:05.500+00:00");
    await transfer("t3", "failed", "2026-10-21T00:00:06Z");
    await seedJob(1n, 2, "Funded", "2026-10-21T00:00:07.000Z");
    await seedJob(2n, 5, "Rejected", "2026-10-21T00:00:08.000Z");
    await seedJob(3n, 4, "Completed", "2026-10-21T00:00:09.000Z");
    await seedJob(9n, 6, "Rejected", "2026-10-21T00:00:09.500Z"); // cancelled before funding
    // Another vault's settlement never appears.
    await seedReservation(OTHER_VAULT, 1n, { state: 1, validBefore: 999n });
    await seedAuthorization(OTHER_VAULT, 1n, 0, {
      settled: true,
      createdAt: "2026-10-21T00:00:00.500Z",
    });

    const store = createQueryStore(db);
    const all: Awaited<ReturnType<typeof store.receiptsForLedger>> = [];
    let cursor: { createdAt: string; id: string } | null = null;
    for (;;) {
      const page = await store.receiptsForLedger(lower(VAULT), cursor, 4);
      const kept = page.slice(0, 3);
      all.push(...kept);
      if (page.length <= 3) break;
      const last = kept.at(-1)!;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    expect(all.map((fact) => [fact.rail, fact.status])).toEqual([
      ["x402-exact", "settled"],
      ["x402-exact", "reserved"],
      ["x402-exact", "released"],
      ["gateway-batched", "pending"],
      ["gateway-batched", "completed"],
      ["gateway-batched", "failed"],
      ["erc8183-job", "reserved"],
      ["erc8183-job", "refunded"],
      ["erc8183-job", "settled"],
      ["erc8183-job", "released"],
    ]);
    expect(new Set(all.map((fact) => fact.envelopeRef))).toEqual(new Set([ref]));
    expect(all[0]).toMatchObject({
      amount: "100",
      reservationId: "1",
      index: 0,
      stepIndex: 0,
      settlementTx: hash("b"),
    });
    expect(all[4]).toMatchObject({
      transferId: "t2",
      amount: "50",
      settlementTx: hash("c"),
      createdAt: "2026-10-21T00:00:05.500Z",
    });
    expect(all[6]).toMatchObject({ amount: "400", stepIndex: 1, jobKey: hash("1") });
    expect(all[0]).toMatchObject({
      payer: lower(VAULT),
      nonce: derivedNonce(VAULT, 1n, 0),
      validBefore: 999,
    });
    expect(all[0]?.payee?.toLowerCase()).toBe(lower(PAYEE));
    const response = await createIndexerApi(store).request(`/receipts?vault=${lower(VAULT)}`);
    expect(response.status).toBe(200);
    const page = (await response.json()) as { items: { validBefore: number | null }[] };
    expect(page.items[0]?.validBefore).toBe(999);
  });

  it("pages receipts correctly when several rails share one timestamp", async () => {
    await seedEnvelope(VAULT, 1n);
    await seedReservation(VAULT, 1n, { state: 1, validBefore: 999n, count: 2 });
    const same = "2026-10-21T00:00:01.000Z";
    await seedAuthorization(VAULT, 1n, 0, { createdAt: same });
    await seedAuthorization(VAULT, 1n, 1, { createdAt: same });
    await seedJob(1n, 2, "Funded", same);
    await seedJob(2n, 2, "Funded", same);
    const store = createQueryStore(db);
    const seen: string[] = [];
    let cursor: { createdAt: string; id: string } | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await store.receiptsForLedger(lower(VAULT), cursor, 2);
      const kept = page.slice(0, 1);
      seen.push(...kept.map((fact) => fact.id));
      if (page.length <= 1) break;
      cursor = { createdAt: kept[0]!.createdAt, id: kept[0]!.id };
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(seen).toEqual(seen.toSorted());
  });

  it("returns the latest anchor by numeric seq and finds an anchor by root or batch root", async () => {
    const anchor = (seq: string, root: Hex, batchRoot: Hex | null) =>
      db.insert(anchors).values({
        id: `a${seq}`,
        publisher: lower(PUBLISHER),
        kind: 1,
        seq,
        root,
        prev: ZERO,
        uriHash: ZERO,
        uri: "ar://x",
        batchRoot,
        block: BigInt(seq),
        transaction: hash("d"),
      });
    await anchor("9", hash("1"), null);
    await anchor("10", hash("2"), hash("3"));
    const store = createQueryStore(db);
    expect(await store.latestAnchor(lower(PUBLISHER), 1)).toEqual({
      root: hash("2"),
      seq: "10",
      block: "10",
      transaction: hash("d"),
    });
    expect(await store.latestAnchor(lower(PUBLISHER), 0)).toBeNull();
    expect((await store.anchorByBatch(hash("3")))?.["seq"]).toBe("10");
    expect((await store.anchorByBatch(hash("1")))?.["seq"]).toBe("9");
    expect(await store.anchorByBatch(hash("e"))).toBeNull();
  });

  it("matches the contract's PULLBACK_CANCEL_DELAY_BLOCKS", () => {
    const source = readFileSync(
      new URL("../../../contracts/src/libraries/CzarConstants.sol", import.meta.url),
      "utf8",
    );
    const match = /uint256 constant PULLBACK_CANCEL_DELAY_BLOCKS = ([0-9_]+);/.exec(source);
    expect(match).not.toBeNull();
    expect(BigInt(match![1]!.replaceAll("_", ""))).toBe(PULLBACK_CANCEL_DELAY_BLOCKS);
  });
});

describe("T-034 HTTP routes", () => {
  const config = loadConfig({ envFile: { "api.pageDefaultLimit": 2 } });

  it("serves owner vault lookup and cursor-paged envelopes by vault", async () => {
    await db.insert(vaults).values({
      id: lower(VAULT),
      owner: lower(PAYEE),
      version: 1,
      agentSigner: lower(PAYEE),
      autonomySigner: lower(PAYEE),
      evaluator: lower(PAYEE),
      createdBlock: 12n,
    });
    for (let id = 1n; id <= 5n; id += 1n) await seedEnvelope(VAULT, id);
    await seedEnvelope(OTHER_VAULT, 1n);
    const app = createIndexerApi(createQueryStore(db), config);
    expect((await app.request(`/vaults?owner=${lower(PAYEE)}`)).status).toBe(200);
    expect((await app.request(`/vaults?owner=${lower(OTHER_VAULT)}`)).status).toBe(404);
    expect((await app.request("/vaults?owner=invalid")).status).toBe(400);

    const ids: number[] = [];
    let url = `/envelopes?vault=${lower(VAULT)}`;
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const response = await app.request(url);
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        items: { envelopeId: number }[];
        nextCursor: string | null;
      };
      ids.push(...page.items.map((envelope) => envelope.envelopeId));
      if (!page.nextCursor) break;
      url = `/envelopes?vault=${lower(VAULT)}&cursor=${page.nextCursor}`;
    }
    expect(ids.toSorted((left, right) => left - right)).toEqual([1, 2, 3, 4, 5]);
    expect((await app.request("/envelopes?vault=invalid")).status).toBe(400);
  });

  it("serves envelopeByRef with schema-valid mirrors and 404 for an unknown ref", async () => {
    const ref = await seedEnvelope(VAULT, 1n);
    await seedReservation(VAULT, 1n, { state: 1, validBefore: 999n });
    await seedJob(1n, 2, "Funded");
    const app = createIndexerApi(createQueryStore(db), config);
    const found = await app.request(`/envelopes/${encodeURIComponent(ref)}`);
    expect(found.status).toBe(200);
    const body = (await found.json()) as { reservations: unknown[]; jobs: unknown[] };
    expect(body.reservations).toHaveLength(1);
    expect(body.jobs).toHaveLength(1);
    expect((await app.request("/envelopes/eip155%3A5042002%3A0x00%3A1")).status).toBe(404);
  });

  it("serves envelopeByPlanHash with the SCR-119 response and validates its mirrors", async () => {
    const ref = await seedEnvelope(VAULT, 1n);
    await seedReservation(VAULT, 1n, { state: 1, validBefore: 999n });
    await db.insert(pockets).values({
      id: `${lower(VAULT)}:${lower(POCKET)}`,
      vault: lower(VAULT),
      envelopeId: 1n,
      pocket: lower(POCKET),
      mirror: pocketMirror({
        vault: VAULT,
        pocket: POCKET,
        view: {
          envelopeId: 1n,
          state: 2,
          funded: 1000n,
          gasGranted: 0n,
          outstanding: 1000n,
          pendingPullback: 0n,
        },
        pullbacks: [],
        delegateReady: false,
      }),
    });
    await seedJob(1n, 2, "Funded");
    const app = createIndexerApi(createQueryStore(db), config);

    const response = await app.request(`/envelopes/by-plan-hash/${HASH}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      envelope: unknown;
      reservations: unknown[];
      pockets: unknown[];
      jobs: unknown[];
    };
    expect(body.envelope).toMatchObject({ envelopeRef: ref, planHash: HASH });
    expect(validateEnvelope(body.envelope)).toBe(true);
    expect(body.reservations.every(validateReservation)).toBe(true);
    expect(body.pockets).toHaveLength(1);
    const validPocket = validatePocketRecord(body.pockets[0]);
    const pocketErrors = validationErrors("pocket-record");
    expect(
      validPocket ||
        pocketErrors.every(
          (error) => error.keyword === "required" && error.params["missingProperty"] === "keyRef",
        ),
    ).toBe(true);
    expect(body.jobs.every(validateJobRecord)).toBe(true);
  });

  it("returns 404 when no envelope has the requested plan hash", async () => {
    const app = createIndexerApi(createQueryStore(db), config);

    expect((await app.request(`/envelopes/by-plan-hash/${HASH}`)).status).toBe(404);
  });

  it("rejects plan hashes that are not lowercase 32-byte hex", async () => {
    const app = createIndexerApi(createQueryStore(db), config);

    expect((await app.request(`/envelopes/by-plan-hash/0x${"A".repeat(64)}`)).status).toBe(400);
    expect((await app.request("/envelopes/by-plan-hash/0x1234")).status).toBe(400);
  });

  it("pages over HTTP with opaque cursors bound to the query, and rejects bad input", async () => {
    for (let id = 1n; id <= 5n; id += 1n) {
      await seedReservation(VAULT, id, { state: 1, validBefore: 100n });
    }
    const app = createIndexerApi(createQueryStore(db), config);
    const ids: number[] = [];
    let url = "/reservations/needing-finalize?now=200";
    for (let guard = 0; guard < 5; guard += 1) {
      const response = await app.request(url);
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        items: { reservationId: number }[];
        nextCursor: string | null;
      };
      expect(page.items.length).toBeLessThanOrEqual(2);
      ids.push(...page.items.map((item) => item.reservationId));
      if (!page.nextCursor) break;
      url = `/reservations/needing-finalize?now=200&cursor=${page.nextCursor}`;
    }
    expect(ids).toEqual([1, 2, 3, 4, 5]);

    const first = (await (await app.request("/reservations/needing-finalize?now=200")).json()) as {
      nextCursor: string;
    };
    const foreign = await app.request(
      `/reservations/needing-finalize?now=300&cursor=${first.nextCursor}`,
    );
    expect(foreign.status).toBe(400);
    expect((await app.request("/reservations/needing-finalize?now=-1")).status).toBe(400);
    expect((await app.request("/reservations/needing-finalize?now=1&limit=201")).status).toBe(400);
    expect((await app.request("/reservations/needing-finalize?now=1&limit=0")).status).toBe(400);
    expect((await app.request("/reservations/needing-settle?vault=0xnope")).status).toBe(400);
    expect((await app.request("/receipts")).status).toBe(400);
    expect((await app.request("/anchors/latest?publisher=0x1&kind=1")).status).toBe(400);
    expect((await app.request("/anchors/by-batch/0x12")).status).toBe(400);
  });

  it("serves every remaining T-034 query route", async () => {
    await seedEnvelope(VAULT, 1n);
    const app = createIndexerApi(createQueryStore(db), config);
    for (const path of [
      `/reservations/needing-settle?vault=${lower(VAULT)}`,
      "/pullbacks/to-confirm",
      "/pullbacks/to-cancel?block=1",
      "/jobs/to-sync",
      "/jobs/awaiting-evaluation",
      `/receipts?vault=${lower(VAULT)}`,
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(await response.json()).toEqual({ items: [], nextCursor: null });
    }
    expect(
      await (await app.request(`/anchors/latest?publisher=${lower(PUBLISHER)}&kind=1`)).json(),
    ).toBeNull();
    expect(await (await app.request(`/anchors/by-batch/${hash("1")}`)).json()).toBeNull();
  });

  it("returns dependency state flags from PGlite through the query store and HTTP route", async () => {
    await db.insert(haltFlags).values([
      {
        path: "gateway-nano",
        halted: true,
        reason: "dependency-upgraded",
        sourceProxy: "0x01",
        block: 12n,
        transaction: hash("1"),
      },
      {
        path: "x402-exact",
        halted: true,
        reason: "dependency-upgraded",
        sourceProxy: "0x02",
        block: 10n,
        transaction: hash("2"),
      },
    ]);
    const store = createQueryStore(db);
    expect((await store.dependencyState()).map((flag) => flag.path)).toEqual([
      "gateway-nano",
      "x402-exact",
    ]);
    const app = createIndexerApi(store, config);
    expect(await (await app.request("/dependency-state")).json()).toEqual({
      items: [
        {
          path: "gateway-nano",
          halted: true,
          reason: "dependency-upgraded",
          sourceProxy: "0x01",
          block: "12",
          transaction: hash("1"),
        },
        {
          path: "x402-exact",
          halted: true,
          reason: "dependency-upgraded",
          sourceProxy: "0x02",
          block: "10",
          transaction: hash("2"),
        },
      ],
    });
  });
});
