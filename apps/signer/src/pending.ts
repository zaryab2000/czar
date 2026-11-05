// SCR-180: what this signer has signed that the indexer has not seen yet. The signed audit row records the
// spend in its existing columns (`object_ids`, `amount_atomic`); these helpers write those fields and read
// them back. A row that is in scope but cannot be read makes pending uncomputable, so the caller throws and
// the request ends `backend-error` with nothing signed (§3).
import type { Address, Hash32 } from "@czar/hashing";

/** A signed `gateway-nano` authorization (SCR-180 §2). */
export interface NanoSpendRecord {
  readonly kind: "gateway-nano";
  readonly pocket: Address;
  readonly payTo: Address;
  /** The EIP-3009 nonce; the indexer's `gateway_transfers.nonce` once it has seen the transfer. */
  readonly nonce: Hash32;
  /** Unix seconds; the authorization counts while `now < validBefore`. */
  readonly validBefore: bigint;
  readonly envelopeId: bigint;
  readonly stepIndex: number;
  readonly amount: bigint;
}

/**
 * A signed `usdc-3009` (x402 call) authorization: one call of its step (SCR-180 §2, expected calls). No payee:
 * the count does not need it, and K3 audit rows have never carried the x402 payee.
 */
export interface CallSpendRecord {
  readonly kind: "usdc-3009";
  readonly vault: Address;
  /** The derived EIP-3009 nonce; the indexer's `authorizations.nonce`. */
  readonly nonce: Hash32;
  readonly validBefore: bigint;
  readonly envelopeId: bigint;
  readonly stepIndex: number;
  readonly amount: bigint;
}

export type SpendRecord = NanoSpendRecord | CallSpendRecord;

/** The spend fields of `object_ids[0]`; integers that can exceed 2^53 travel as decimal strings. */
export function spendObjectIds(spend: SpendRecord): Record<string, string | number> {
  const owner =
    spend.kind === "gateway-nano"
      ? { pocket: spend.pocket, payTo: spend.payTo }
      : { vault: spend.vault };
  return {
    ...owner,
    nonce: spend.nonce,
    validBefore: spend.validBefore.toString(),
    envelopeId: spend.envelopeId.toString(),
    stepIndex: spend.stepIndex,
  };
}

/** One signed audit row read back: `object_ids[0]`, `amount_atomic`, and whether the indexer has its payment. */
export interface AuditSpendRow {
  readonly ids: unknown;
  readonly amountAtomic: unknown;
  readonly indexed: boolean;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_STEP_INDEX = 0xffff_ffff;

class PendingUnreadable extends Error {
  constructor(field: string) {
    super(`pending spend cannot be computed: a signed audit row has no valid ${field}`);
    this.name = "PendingUnreadable";
  }
}

function ids(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new PendingUnreadable("object_ids");
  return parsed as Record<string, unknown>;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new PendingUnreadable("object_ids");
  }
}

function address(record: Record<string, unknown>, field: string): Address {
  const value = record[field];
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new PendingUnreadable(field);
  return value.toLowerCase() as Address;
}

function nonceOf(record: Record<string, unknown>): Hash32 {
  const value = record["nonce"];
  if (typeof value !== "string" || !BYTES32.test(value)) throw new PendingUnreadable("nonce");
  return value.toLowerCase() as Hash32;
}

function decimal(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new PendingUnreadable(field);
  return BigInt(value);
}

function stepIndexOf(record: Record<string, unknown>): number {
  const value = record["stepIndex"];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_STEP_INDEX)
    throw new PendingUnreadable("stepIndex");
  return value;
}

interface ParsedRow {
  readonly nonce: Hash32;
  readonly validBefore: bigint;
  readonly envelopeId: bigint;
  readonly stepIndex: number;
  readonly amount: bigint;
  readonly indexed: boolean;
  readonly record: Record<string, unknown>;
}

function parseRow(row: AuditSpendRow): ParsedRow {
  const record = ids(row.ids);
  return {
    nonce: nonceOf(record),
    validBefore: decimal(record["validBefore"], "validBefore"),
    envelopeId: decimal(record["envelopeId"], "envelopeId"),
    stepIndex: stepIndexOf(record),
    amount: decimal(row.amountAtomic, "amount_atomic"),
    indexed: row.indexed,
    record,
  };
}

/** Rows still pending: the indexer has not seen the payment and `now < validBefore` (SCR-180 §2). */
const live = <T extends ParsedRow>(rows: readonly T[], now: number): T[] =>
  rows.filter((row) => !row.indexed && BigInt(now) < row.validBefore);

/**
 * The sum over nonces of each nonce's largest amount: only one authorization with a given nonce can ever be
 * used, so a request signed twice is one payment, never two.
 */
function sumByNonce(rows: readonly ParsedRow[]): bigint {
  const largest = new Map<string, bigint>();
  for (const row of rows) {
    const seen = largest.get(row.nonce);
    if (seen === undefined || seen < row.amount) largest.set(row.nonce, row.amount);
  }
  let total = 0n;
  for (const amount of largest.values()) total += amount;
  return total;
}

/**
 * SCR-180 §2 `pending.step` (this `payTo`) and `pending.pocket` (every payee) for `gateway-nano`. Every row is
 * validated, including ones that no longer count, so a malformed row in scope always refuses.
 */
export function pendingNanoTotals(
  rows: readonly AuditSpendRow[],
  scope: { readonly pocket: Address; readonly payTo: Address },
  now: number,
): { step: bigint; pocket: bigint } {
  const parsed = rows.map((row) => {
    const read = parseRow(row);
    if (address(read.record, "pocket") !== scope.pocket.toLowerCase())
      throw new PendingUnreadable("pocket");
    return { ...read, payTo: address(read.record, "payTo") };
  });
  const pending = live(parsed, now);
  const payTo = scope.payTo.toLowerCase();
  return {
    step: sumByNonce(pending.filter((row) => row.payTo === payTo)),
    pocket: sumByNonce(pending),
  };
}

/** SCR-180 §2 pending calls of one step: live usdc-3009 authorizations not yet indexed as used, one per nonce. */
export function pendingCallCount(
  rows: readonly AuditSpendRow[],
  scope: {
    readonly vault: Address;
    readonly envelopeId: bigint;
    readonly stepIndex: number;
  },
  now: number,
): number {
  const parsed = rows.map(parseRow);
  for (const row of parsed)
    if (address(row.record, "vault") !== scope.vault.toLowerCase())
      throw new PendingUnreadable("vault");
  const step = live(parsed, now).filter(
    (row) => row.envelopeId === scope.envelopeId && row.stepIndex === scope.stepIndex,
  );
  return new Set(step.map((row) => row.nonce)).size;
}
