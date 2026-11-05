// SCR-180 §2 on the production adapters: `postgresAudit` records the spend fields in the existing `object_ids`
// and `amount_atomic` columns, and `createPostgresProjection` reads pending back from those rows, minus what
// the indexer has seen (`gateway_transfers` by nonce; `authorizations` used by nonce), minus what has expired.
import type { Address, Hash32 } from "@czar/hashing";
import { loadConfig } from "@czar/config";
import { describe, expect, it } from "vitest";
import { createPostgresProjection } from "../src/postgres-projection.ts";
import { postgresAudit, type AuditQueryExecutor } from "../src/postgres-audit.ts";
import type { AuditRow } from "../src/service.ts";

const factory = "0x00000000000000000000000000000000000000a2" as Address;
const pocket = "0x00000000000000000000000000000000000000b2" as Address;
const vault = "0x00000000000000000000000000000000000000a1" as Address;
const payTo = "0x00000000000000000000000000000000000000c1" as Address;
const other = "0x00000000000000000000000000000000000000c2" as Address;
const NOW = 1_800_000_000;
const n = (byte: string) => `0x${byte.repeat(64)}` as Hash32;

type Row = Record<string, unknown>;
interface Query {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function recording(rows: (sql: string) => readonly Row[]) {
  const queries: Query[] = [];
  const database: AuditQueryExecutor = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      return { rows: rows(sql) };
    },
  };
  return { database, queries };
}

const projectionOn = (database: AuditQueryExecutor) =>
  createPostgresProjection({
    config: loadConfig(),
    database,
    chain: {} as never,
    factory,
  });

const nanoIds = (overrides: Row = {}): Row => ({
  keyRef: `K4:${pocket}`,
  purpose: { envelopeRef: "1" },
  digest: n("d"),
  pocket,
  payTo,
  nonce: n("1"),
  validBefore: String(NOW + 60),
  envelopeId: "1",
  stepIndex: 2,
  ...overrides,
});

const nanoRow = (ids: Row, amount: unknown, indexed = false): Row => ({
  ids,
  amount_atomic: amount,
  indexed,
});

const callIds = (overrides: Row = {}): Row => ({
  keyRef: "K3",
  purpose: { reservationId: "12" },
  digest: n("d"),
  vault,
  nonce: n("1"),
  validBefore: String(NOW + 60),
  envelopeId: "1",
  stepIndex: 0,
  ...overrides,
});

describe("postgresAudit records the SCR-180 spend fields", () => {
  it("writes pocket, payTo, nonce, validBefore, envelope and step to object_ids and the amount to amount_atomic", async () => {
    const { database, queries } = recording(() => []);
    const row: AuditRow = {
      at: NOW * 1000,
      caller: "cz-15",
      keyRef: `K4:${pocket}`,
      kind: "gateway-nano",
      digest: n("d"),
      purpose: { envelopeRef: "1" },
      outcome: "signed",
      spend: {
        kind: "gateway-nano",
        pocket,
        payTo,
        nonce: n("1"),
        validBefore: BigInt(NOW + 60),
        envelopeId: 1n,
        stepIndex: 2,
        amount: 800n,
      },
    };
    await postgresAudit(database).write(row);
    expect(queries[0]?.sql).toContain("amount_atomic");
    expect(JSON.parse(String(queries[0]?.values[2]))).toEqual([nanoIds()]);
    expect(queries[0]?.values[5]).toBe("800");
  });

  it("writes the usdc-3009 vault, nonce, validBefore, envelope and step, and leaves amount_atomic empty without a spend", async () => {
    const { database, queries } = recording(() => []);
    await postgresAudit(database).write({
      at: NOW * 1000,
      caller: "cz-15",
      keyRef: "K3",
      kind: "usdc-3009",
      digest: n("d"),
      purpose: { reservationId: "12" },
      outcome: "signed",
      spend: {
        kind: "usdc-3009",
        vault,
        nonce: n("1"),
        validBefore: BigInt(NOW + 60),
        envelopeId: 1n,
        stepIndex: 0,
        amount: 100_000n,
      },
    });
    await postgresAudit(database).write({
      at: NOW * 1000,
      caller: "cz-15",
      keyRef: "K3",
      kind: "vault-call",
      purpose: {},
      outcome: "kms_denied",
      rule: "frozen",
    });
    expect(JSON.parse(String(queries[0]?.values[2]))).toEqual([callIds()]);
    expect(queries[0]?.values[5]).toBe("100000");
    expect(queries[1]?.values[5]).toBeNull();
  });
});

describe("Postgres pendingNanoSpent", () => {
  it("sums signed, unexpired, unindexed nano rows for the pocket, per payTo and in total", async () => {
    const { database, queries } = recording(() => [
      nanoRow(nanoIds({ nonce: n("1") }), "800"),
      nanoRow(nanoIds({ nonce: n("2") }), "300"),
      nanoRow(nanoIds({ nonce: n("3"), payTo: other }), "500"),
      // Indexed: already in nanoSpent, so not pending.
      nanoRow(nanoIds({ nonce: n("4") }), "900", true),
      // validBefore reached: dead on chain.
      nanoRow(nanoIds({ nonce: n("5"), validBefore: String(NOW) }), "700"),
    ]);
    await expect(projectionOn(database).pendingNanoSpent(pocket, payTo, NOW)).resolves.toEqual({
      step: 1_100n,
      pocket: 1_600n,
    });
    expect(queries).toHaveLength(1);
    const [query] = queries;
    expect(query?.sql).toContain("action='signer:gateway-nano'");
    expect(query?.sql).toContain("outcome='signed'");
    expect(query?.sql).toContain("FROM gateway_transfers");
    expect(query?.sql).toContain("'received','batched','confirmed','completed'");
    expect(query?.values).toEqual([`K4:${pocket}`, pocket, NOW]);
  });

  it("counts a nonce signed twice once, at its largest amount", async () => {
    const { database } = recording(() => [
      nanoRow(nanoIds(), "800"),
      nanoRow(nanoIds(), "1000"),
      nanoRow(nanoIds({ payTo: other }), "900"),
    ]);
    await expect(projectionOn(database).pendingNanoSpent(pocket, payTo, NOW)).resolves.toEqual({
      step: 1_000n,
      pocket: 1_000n,
    });
  });

  it("returns zero when nothing is pending", async () => {
    const { database } = recording(() => []);
    await expect(projectionOn(database).pendingNanoSpent(pocket, payTo, NOW)).resolves.toEqual({
      step: 0n,
      pocket: 0n,
    });
  });

  const malformed: readonly [string, Row][] = [
    ["no nonce", nanoRow(nanoIds({ nonce: undefined }), "800")],
    ["a malformed nonce", nanoRow(nanoIds({ nonce: "0x12" }), "800")],
    [
      "no validBefore (a row from before SCR-180)",
      nanoRow(nanoIds({ validBefore: undefined }), "800"),
    ],
    ["a non-decimal validBefore", nanoRow(nanoIds({ validBefore: "1e9" }), "800")],
    ["no amount", nanoRow(nanoIds(), null)],
    ["a negative amount", nanoRow(nanoIds(), "-1")],
    ["a fractional amount", nanoRow(nanoIds(), "1.5")],
    ["no payTo", nanoRow(nanoIds({ payTo: undefined }), "800")],
    ["another pocket than its key", nanoRow(nanoIds({ pocket: other }), "800")],
    ["object_ids that are not an object", nanoRow("[]" as never, "800")],
  ];
  for (const [label, row] of malformed) {
    it(`throws (fails closed) on a signed row with ${label}`, async () => {
      const { database } = recording(() => [row]);
      await expect(projectionOn(database).pendingNanoSpent(pocket, payTo, NOW)).rejects.toThrow(
        /pending/,
      );
    });
  }

  it("rejects when the audit read fails", async () => {
    const database: AuditQueryExecutor = {
      async query() {
        throw new Error('relation "audit" does not exist');
      },
    };
    await expect(projectionOn(database).pendingNanoSpent(pocket, payTo, NOW)).rejects.toThrow(
      'relation "audit" does not exist',
    );
  });
});

describe("Postgres pendingCalls", () => {
  it("counts signed, unexpired usdc-3009 rows for the step whose authorization is not indexed as used", async () => {
    const { database, queries } = recording(() => [
      nanoRow(callIds({ nonce: n("1") }), "100000"),
      nanoRow(callIds({ nonce: n("2") }), "100000"),
      // The same authorization signed twice is one call.
      nanoRow(callIds({ nonce: n("2") }), "100000"),
      nanoRow(callIds({ nonce: n("3") }), "100000", true),
      nanoRow(callIds({ nonce: n("4"), validBefore: String(NOW) }), "100000"),
      nanoRow(callIds({ nonce: n("5"), stepIndex: 1 }), "100000"),
      nanoRow(callIds({ nonce: n("6"), envelopeId: "2" }), "100000"),
    ]);
    await expect(projectionOn(database).pendingCalls(vault, 1n, 0, NOW)).resolves.toBe(2);
    expect(queries).toHaveLength(1);
    const [query] = queries;
    expect(query?.sql).toContain("action='signer:usdc-3009'");
    expect(query?.sql).toContain("outcome='signed'");
    expect(query?.sql).toContain("FROM authorizations");
    expect(query?.sql).toContain("used=true");
    expect(query?.values).toEqual([vault, NOW]);
  });

  const malformed: readonly [string, Row][] = [
    ["no nonce", nanoRow(callIds({ nonce: undefined }), "100000")],
    ["no validBefore", nanoRow(callIds({ validBefore: undefined }), "100000")],
    ["no envelope", nanoRow(callIds({ envelopeId: undefined }), "100000")],
    ["a non-integer step", nanoRow(callIds({ stepIndex: "x" }), "100000")],
    ["another vault", nanoRow(callIds({ vault: other }), "100000")],
  ];
  for (const [label, row] of malformed) {
    it(`throws (fails closed) on a signed row with ${label}`, async () => {
      const { database } = recording(() => [row]);
      await expect(projectionOn(database).pendingCalls(vault, 1n, 0, NOW)).rejects.toThrow(
        /pending/,
      );
    });
  }
});
