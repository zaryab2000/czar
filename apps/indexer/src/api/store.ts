// SQL-side reads for the CZ-19 §5.4 queries (T-034, SCR-119). Every query filters, orders and
// limits in the database; nothing loads a projection table into memory.
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  anchors,
  authorizations,
  envelopes,
  escrowJobs,
  gatewayTransfers,
  jobs,
  haltFlags,
  pockets,
  pullbacks,
  reservations,
  vaults,
} from "@czar/indexer/schema";
import { safeNumber } from "#src/mirrors";

/**
 * `PULLBACK_CANCEL_DELAY_BLOCKS` in contracts/src/libraries/CzarConstants.sol. A contract constant,
 * not a tunable parameter: `cancelPullback` reverts `TooEarly` before
 * `maxBlockHeight + PULLBACK_CANCEL_DELAY_BLOCKS` (03 czar-vault.md §5, RV-036). A test parses the
 * Solidity source so the two cannot drift.
 */
export const PULLBACK_CANCEL_DELAY_BLOCKS = 3000n;

/** Vault job states from which `syncJob` can still move a job (JobLogic.syncJob). */
const SYNCABLE_JOB_STATES = ["Opened", "Funded", "Submitted"] as const;

/** Keyset position: rows strictly after (`after`) in `id` order. */
export interface IdCursor {
  readonly after: string;
}

/** Keyset position for receipts: strictly after (`createdAt`, `id`) in that order. */
export interface ReceiptCursor {
  readonly createdAt: string;
  readonly id: string;
}

export type ReceiptRail = "x402-exact" | "gateway-batched" | "erc8183-job";
export type ReceiptStatus =
  | "reserved"
  | "settled"
  | "pending"
  | "completed"
  | "released"
  | "refunded"
  | "failed";

/** One settlement fact (SCR-119). The server joins its own fields to build `LedgerReceipt`. */
export interface ReceiptFact {
  readonly id: string;
  readonly envelopeRef: string;
  readonly stepIndex: number | null;
  readonly reservationId: string | null;
  readonly index: number | null;
  readonly transferId: string | null;
  readonly jobKey: string | null;
  readonly payer: string | null;
  readonly payee: string | null;
  readonly nonce: string | null;
  readonly validBefore: number | null;
  readonly transferTx: string | null;
  readonly amount: string;
  readonly rail: ReceiptRail;
  readonly status: ReceiptStatus;
  readonly settlementTx: string | null;
  readonly createdAt: string;
}

export interface AnchorHead {
  readonly root: string;
  readonly seq: string;
  readonly block: string;
  readonly transaction: string;
}

export interface HaltFlag {
  readonly path: string;
  readonly halted: boolean;
  readonly reason: string;
  readonly sourceProxy: string;
  readonly block: string;
  readonly transaction: string;
}

type Row = Record<string, unknown>;

/** A row and the internal key the next keyset page starts after. */
export interface Keyed {
  readonly key: string;
  readonly item: Row;
}

/** The subset of a drizzle Postgres database the queries need (Ponder's `db` or a test database). */
// oxlint-disable-next-line typescript/no-explicit-any -- drizzle's builder types differ per driver
export type QueryDb = any;

export interface QueryStore {
  vaultByOwner(owner: string): Promise<Row | null>;
  envelopesForVault(vault: string, cursor: IdCursor | null, limit: number): Promise<Keyed[]>;
  envelopeByRef(envelopeRef: string): Promise<{
    envelope: Row;
    reservations: Row[];
    pockets: Row[];
    jobs: Row[];
  } | null>;
  reservationsNeedingSettle(
    vault: string,
    cursor: IdCursor | null,
    limit: number,
  ): Promise<Keyed[]>;
  reservationsNeedingFinalize(
    now: bigint,
    cursor: IdCursor | null,
    limit: number,
  ): Promise<Keyed[]>;
  pullbacksToConfirm(cursor: IdCursor | null, limit: number): Promise<Keyed[]>;
  pullbacksToCancel(block: bigint, cursor: IdCursor | null, limit: number): Promise<Keyed[]>;
  jobsToSync(cursor: IdCursor | null, limit: number): Promise<Keyed[]>;
  jobsAwaitingEvaluation(cursor: IdCursor | null, limit: number): Promise<Keyed[]>;
  receiptsForLedger(
    vault: string,
    cursor: ReceiptCursor | null,
    limit: number,
  ): Promise<ReceiptFact[]>;
  latestAnchor(publisher: string, kind: number): Promise<AnchorHead | null>;
  anchorByBatch(root: string): Promise<Row | null>;
  dependencyState(): Promise<HaltFlag[]>;
}

const afterId = (column: Parameters<typeof gt>[0], cursor: IdCursor | null): SQL | undefined =>
  cursor ? gt(column, cursor.after) : undefined;

const mirrorOf = (row: { mirror: unknown }): Row => row.mirror as Row;

export function createQueryStore(db: QueryDb): QueryStore {
  return {
    async vaultByOwner(owner) {
      const [vault] = await db.select().from(vaults).where(eq(vaults.owner, owner)).limit(1);
      return vault ?? null;
    },

    async envelopesForVault(vault, cursor, limit) {
      const rows = await db
        .select()
        .from(envelopes)
        .where(and(eq(envelopes.vault, vault), afterId(envelopes.id, cursor)))
        .orderBy(asc(envelopes.id))
        .limit(limit);
      return rows.map((row: { id: string; mirror: unknown }) => ({
        key: row.id,
        item: row.mirror as Row,
      }));
    },

    async envelopeByRef(envelopeRef) {
      const [envelope] = await db
        .select()
        .from(envelopes)
        .where(eq(envelopes.envelopeRef, envelopeRef))
        .limit(1);
      if (!envelope) return null;
      const scope = (table: typeof reservations | typeof pockets | typeof jobs) =>
        and(eq(table.vault, envelope.vault), eq(table.envelopeId, envelope.envelopeId));
      const [reservationRows, pocketRows, jobRows] = await Promise.all([
        db.select().from(reservations).where(scope(reservations)).orderBy(asc(reservations.id)),
        db.select().from(pockets).where(scope(pockets)).orderBy(asc(pockets.id)),
        db.select().from(jobs).where(scope(jobs)).orderBy(asc(jobs.id)),
      ]);
      return {
        envelope: mirrorOf(envelope),
        reservations: reservationRows.map(mirrorOf),
        pockets: pocketRows.map(mirrorOf),
        jobs: jobRows.map(mirrorOf),
      };
    },

    async reservationsNeedingSettle(vault, cursor, limit) {
      const usedUnsettled = db
        .select({ one: sql`1` })
        .from(authorizations)
        .where(
          and(
            eq(authorizations.vault, reservations.vault),
            eq(authorizations.reservationId, reservations.reservationId),
            eq(authorizations.used, true),
            eq(authorizations.settled, false),
          ),
        );
      const rows = await db
        .select()
        .from(reservations)
        .where(
          and(
            eq(reservations.vault, vault),
            inArray(reservations.state, ["Active", "Finalizing"]),
            sql`exists (${usedUnsettled})`,
            afterId(reservations.id, cursor),
          ),
        )
        .orderBy(asc(reservations.id))
        .limit(limit);
      return rows.map((row: { id: string; mirror: unknown }) => ({
        key: row.id,
        item: mirrorOf(row),
      }));
    },

    async reservationsNeedingFinalize(now, cursor, limit) {
      const rows = await db
        .select()
        .from(reservations)
        .where(
          and(
            lt(reservations.validBefore, now),
            ne(reservations.state, "Final"),
            afterId(reservations.id, cursor),
          ),
        )
        .orderBy(asc(reservations.id))
        .limit(limit);
      return rows.map((row: { id: string; mirror: unknown }) => ({
        key: row.id,
        item: mirrorOf(row),
      }));
    },

    async pullbacksToConfirm(cursor, limit) {
      const rows = await db
        .select()
        .from(pullbacks)
        .where(
          and(
            eq(pullbacks.state, "Pending"),
            eq(pullbacks.attested, true),
            afterId(pullbacks.id, cursor),
          ),
        )
        .orderBy(asc(pullbacks.id))
        .limit(limit);
      return rows.map((row: Parameters<typeof pullbackFact>[0]) => ({
        key: row.id,
        item: pullbackFact(row),
      }));
    },

    async pullbacksToCancel(block, cursor, limit) {
      const rows = await db
        .select()
        .from(pullbacks)
        .where(
          and(
            eq(pullbacks.state, "Pending"),
            eq(pullbacks.attested, false),
            sql`${pullbacks.maxBlockHeight} + ${PULLBACK_CANCEL_DELAY_BLOCKS} <= ${block}`,
            afterId(pullbacks.id, cursor),
          ),
        )
        .orderBy(asc(pullbacks.id))
        .limit(limit);
      return rows.map((row: Parameters<typeof pullbackFact>[0]) => ({
        key: row.id,
        item: pullbackFact(row),
      }));
    },

    async jobsToSync(cursor, limit) {
      // syncJob changes state when: Opened and the escrow moved past Open; Funded and the escrow
      // is Submitted or final; Submitted and the escrow is final (JobLogic.syncJob).
      const rows = await db
        .select({ id: jobs.id, mirror: jobs.mirror, escrowStatus: escrowJobs.status })
        .from(jobs)
        .innerJoin(
          escrowJobs,
          and(eq(escrowJobs.jobEscrow, jobs.jobEscrow), eq(escrowJobs.jobId, jobs.jobId)),
        )
        .where(
          and(
            inArray(jobs.state, [...SYNCABLE_JOB_STATES]),
            ne(escrowJobs.status, "Open"),
            or(
              eq(jobs.state, "Opened"),
              and(eq(jobs.state, "Funded"), ne(escrowJobs.status, "Funded")),
              and(
                eq(jobs.state, "Submitted"),
                notInArray(escrowJobs.status, ["Funded", "Submitted"]),
              ),
            ),
            afterId(jobs.id, cursor),
          ),
        )
        .orderBy(asc(jobs.id))
        .limit(limit);
      return rows.map((row: { id: string; mirror: unknown; escrowStatus: string }) => ({
        key: row.id,
        item: { job: mirrorOf(row), escrowStatus: row.escrowStatus },
      }));
    },

    async jobsAwaitingEvaluation(cursor, limit) {
      const rows = await db
        .select({ id: jobs.id, mirror: jobs.mirror })
        .from(jobs)
        .innerJoin(
          escrowJobs,
          and(eq(escrowJobs.jobEscrow, jobs.jobEscrow), eq(escrowJobs.jobId, jobs.jobId)),
        )
        .where(and(eq(escrowJobs.status, "Submitted"), afterId(jobs.id, cursor)))
        .orderBy(asc(jobs.id))
        .limit(limit);
      return rows.map((row: { id: string; mirror: unknown }) => ({
        key: row.id,
        item: mirrorOf(row),
      }));
    },

    async receiptsForLedger(vault, cursor, limit) {
      // Each rail is paged in SQL on (createdAt, id); the three bounded pages merge in order.
      const [x402, gateway, job] = await Promise.all([
        x402Receipts(db, vault, cursor, limit),
        gatewayReceipts(db, vault, cursor, limit),
        jobReceipts(db, vault, cursor, limit),
      ]);
      return [...x402, ...gateway, ...job].toSorted(compareReceipts).slice(0, limit);
    },

    async latestAnchor(publisher, kind) {
      const [row] = await db
        .select()
        .from(anchors)
        .where(and(eq(anchors.publisher, publisher), eq(anchors.kind, kind)))
        .orderBy(desc(sql`${anchors.seq}::numeric`))
        .limit(1);
      return row
        ? {
            root: row.root,
            seq: String(row.seq),
            block: String(row.block),
            transaction: row.transaction,
          }
        : null;
    },

    async anchorByBatch(root) {
      const [row] = await db
        .select()
        .from(anchors)
        .where(or(eq(anchors.root, root), eq(anchors.batchRoot, root)))
        .orderBy(asc(anchors.id))
        .limit(1);
      return row ? { ...row, block: String(row.block) } : null;
    },

    async dependencyState() {
      const rows = await db.select().from(haltFlags).orderBy(asc(haltFlags.path));
      return rows.map(
        (row: {
          path: string;
          halted: boolean;
          reason: string;
          sourceProxy: string;
          block: bigint;
          transaction: string;
        }) => ({ ...row, block: row.block.toString() }),
      );
    },
  };
}

function pullbackFact(row: {
  id: string;
  vault: string;
  pullbackId: bigint;
  pocket: string;
  transferSpecHash: string;
  maxBlockHeight: bigint;
}): Row {
  return {
    id: row.id,
    vault: row.vault,
    pullbackId: row.pullbackId.toString(),
    pocket: row.pocket,
    transferSpecHash: row.transferSpecHash,
    maxBlockHeight: row.maxBlockHeight.toString(),
  };
}

const RAIL_PREFIX: Readonly<Record<ReceiptRail, string>> = {
  "x402-exact": "a:",
  "gateway-batched": "g:",
  "erc8183-job": "j:",
};

/**
 * Keyset predicate for one rail. Receipt ids are `<rail prefix><row id>`, so at an equal
 * timestamp a whole rail sorts before or after the cursor's rail.
 */
function afterReceipt(
  createdAt: SQL,
  id: Parameters<typeof gt>[0],
  rail: ReceiptRail,
  cursor: ReceiptCursor | null,
): SQL | undefined {
  if (!cursor) return undefined;
  const prefix = RAIL_PREFIX[rail];
  const sameInstant = sql`${createdAt} = ${cursor.createdAt}::timestamptz`;
  const later = sql`${createdAt} > ${cursor.createdAt}::timestamptz`;
  const cursorPrefix = cursor.id.slice(0, 2);
  if (prefix > cursorPrefix) return or(later, sameInstant);
  if (prefix < cursorPrefix) return later;
  return or(later, and(sameInstant, gt(id, cursor.id.slice(2))));
}

async function x402Receipts(
  db: QueryDb,
  vault: string,
  cursor: ReceiptCursor | null,
  limit: number,
): Promise<ReceiptFact[]> {
  const createdAt = sql`${authorizations.createdAt}::timestamptz`;
  const rows = await db
    .select({
      id: authorizations.id,
      vault: authorizations.vault,
      reservationId: authorizations.reservationId,
      index: authorizations.index,
      nonce: authorizations.nonce,
      amount: authorizations.amount,
      settled: authorizations.settled,
      released: authorizations.released,
      settlementTx: authorizations.settlementTx,
      createdAt: authorizations.createdAt,
      stepIndex: reservations.stepIndex,
      validBefore: reservations.validBefore,
      reservation: reservations.mirror,
      reservationState: reservations.state,
      envelopeRef: envelopes.envelopeRef,
    })
    .from(authorizations)
    .innerJoin(
      reservations,
      and(
        eq(reservations.vault, authorizations.vault),
        eq(reservations.reservationId, authorizations.reservationId),
      ),
    )
    .innerJoin(
      envelopes,
      and(
        eq(envelopes.vault, reservations.vault),
        eq(envelopes.envelopeId, reservations.envelopeId),
      ),
    )
    .where(
      and(
        eq(authorizations.vault, vault),
        afterReceipt(createdAt, authorizations.id, "x402-exact", cursor),
      ),
    )
    .orderBy(asc(createdAt), asc(authorizations.id))
    .limit(limit);
  return rows.map(
    (row: {
      id: string;
      vault: string;
      reservationId: bigint;
      index: number;
      nonce: string;
      amount: string;
      settled: boolean;
      released: boolean;
      settlementTx: string | null;
      createdAt: string;
      stepIndex: number;
      validBefore: bigint;
      reservation: { payee: string };
      reservationState: string;
      envelopeRef: string;
    }): ReceiptFact => ({
      id: `${RAIL_PREFIX["x402-exact"]}${row.id}`,
      envelopeRef: row.envelopeRef,
      stepIndex: row.stepIndex,
      reservationId: row.reservationId.toString(),
      index: row.index,
      transferId: null,
      jobKey: null,
      payer: row.vault,
      payee: row.reservation.payee,
      nonce: row.nonce,
      validBefore: safeNumber(row.validBefore),
      transferTx: null,
      amount: row.amount,
      rail: "x402-exact",
      status: row.settled
        ? "settled"
        : row.released || row.reservationState === "Final"
          ? "released"
          : "reserved",
      settlementTx: row.settlementTx,
      createdAt: new Date(row.createdAt).toISOString(),
    }),
  );
}

const GATEWAY_RECEIPT_STATUS: Readonly<Record<string, ReceiptStatus>> = {
  received: "pending",
  batched: "pending",
  confirmed: "pending",
  completed: "completed",
  failed: "failed",
};

async function gatewayReceipts(
  db: QueryDb,
  vault: string,
  cursor: ReceiptCursor | null,
  limit: number,
): Promise<ReceiptFact[]> {
  const createdAt = sql`${gatewayTransfers.createdAt}::timestamptz`;
  const rows = await db
    .select({
      transferId: gatewayTransfers.transferId,
      payer: gatewayTransfers.fromAddress,
      payee: gatewayTransfers.toAddress,
      nonce: gatewayTransfers.nonce,
      status: gatewayTransfers.status,
      amount: gatewayTransfers.amount,
      txHash: gatewayTransfers.txHash,
      createdAt: gatewayTransfers.createdAt,
      envelopeRef: envelopes.envelopeRef,
    })
    .from(gatewayTransfers)
    .innerJoin(pockets, eq(pockets.pocket, gatewayTransfers.pocketAddress))
    .innerJoin(
      envelopes,
      and(eq(envelopes.vault, pockets.vault), eq(envelopes.envelopeId, pockets.envelopeId)),
    )
    .where(
      and(
        eq(pockets.vault, vault),
        isNotNull(gatewayTransfers.pocketAddress),
        afterReceipt(createdAt, gatewayTransfers.transferId, "gateway-batched", cursor),
      ),
    )
    .orderBy(asc(createdAt), asc(gatewayTransfers.transferId))
    .limit(limit);
  return rows.map(
    (row: {
      transferId: string;
      payer: string;
      payee: string;
      nonce: string;
      status: string;
      amount: string;
      txHash: string | null;
      createdAt: string;
      envelopeRef: string;
    }): ReceiptFact => ({
      id: `${RAIL_PREFIX["gateway-batched"]}${row.transferId}`,
      envelopeRef: row.envelopeRef,
      // A pocket serves the whole envelope; the server maps a transfer to its step.
      stepIndex: null,
      reservationId: null,
      index: null,
      transferId: row.transferId,
      jobKey: null,
      payer: row.payer,
      payee: row.payee,
      nonce: row.nonce,
      validBefore: null,
      transferTx: row.txHash,
      amount: row.amount,
      rail: "gateway-batched",
      status: GATEWAY_RECEIPT_STATUS[row.status] ?? "failed",
      settlementTx: row.txHash,
      createdAt: new Date(row.createdAt).toISOString(),
    }),
  );
}

async function jobReceipts(
  db: QueryDb,
  vault: string,
  cursor: ReceiptCursor | null,
  limit: number,
): Promise<ReceiptFact[]> {
  const createdAt = sql`${jobs.createdAt}::timestamptz`;
  const rows = await db
    .select({
      id: jobs.id,
      mirror: jobs.mirror,
      state: jobs.state,
      stepIndex: jobs.stepIndex,
      createdAt: jobs.createdAt,
      escrowStatus: escrowJobs.status,
      envelopeRef: envelopes.envelopeRef,
    })
    .from(jobs)
    .innerJoin(
      envelopes,
      and(eq(envelopes.vault, jobs.vault), eq(envelopes.envelopeId, jobs.envelopeId)),
    )
    .leftJoin(
      escrowJobs,
      and(eq(escrowJobs.jobEscrow, jobs.jobEscrow), eq(escrowJobs.jobId, jobs.jobId)),
    )
    .where(and(eq(jobs.vault, vault), afterReceipt(createdAt, jobs.id, "erc8183-job", cursor)))
    .orderBy(asc(createdAt), asc(jobs.id))
    .limit(limit);
  return rows.map(
    (row: {
      id: string;
      mirror: unknown;
      state: string;
      stepIndex: number;
      createdAt: string;
      escrowStatus: string | null;
      envelopeRef: string;
    }): ReceiptFact => {
      const job = row.mirror as { jobKey: string; budget: string; reservedCap: string };
      return {
        id: `${RAIL_PREFIX["erc8183-job"]}${row.id}`,
        envelopeRef: row.envelopeRef,
        stepIndex: row.stepIndex,
        reservationId: null,
        index: null,
        transferId: null,
        jobKey: job.jobKey,
        payer: null,
        payee: null,
        nonce: null,
        validBefore: null,
        transferTx: null,
        amount: job.budget === "0" ? job.reservedCap : job.budget,
        rail: "erc8183-job",
        status: jobReceiptStatus(row.state, row.escrowStatus),
        settlementTx: null,
        createdAt: new Date(row.createdAt).toISOString(),
      };
    },
  );
}

function jobReceiptStatus(vaultState: string, escrowStatus: string | null): ReceiptStatus {
  // The vault's own state wins once it is final; escrow status covers the gap before syncJob.
  // Released is cancelJob before funding (the escrow reports that job as Rejected): the reserved
  // cap went back and nothing was paid.
  if (vaultState === "Released") return "released";
  if (vaultState === "Refunded") return "refunded";
  if (vaultState === "Completed") return "settled";
  if (escrowStatus === "Completed") return "settled";
  if (escrowStatus === "Rejected" || escrowStatus === "Expired") return "refunded";
  return "reserved";
}

function compareReceipts(left: ReceiptFact, right: ReceiptFact): number {
  const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (byTime !== 0) return byTime;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
