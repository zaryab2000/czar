import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createIndexerApi } from "#src/api/router";
import { loadConfig } from "@czar/config";
import { derivedNonce } from "@czar/hashing";
import type { QueryRows, QueryTable } from "#src/api/types";

const envelope = {
  schemaVersion: "1.1",
  envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
  vault: "0x0000000000000000000000000000000000000001",
  envelopeId: 1,
  objectiveHash: `0x${"1".repeat(64)}`,
  planHash: `0x${"2".repeat(64)}`,
  payeeRoot: `0x${"3".repeat(64)}`,
  categoryId: `0x${"4".repeat(64)}`,
  cap: "1000000",
  maxStepAmount: "100000",
  pocketCapBps: 5000,
  expiresAt: 1_900_000_000,
  approver: "owner",
  approvalTx: `0x${"5".repeat(64)}`,
  spent: "0",
  reserved: "0",
  pocketOutstanding: "0",
  jobEscrowed: "0",
  shortfall: "0",
  state: "Open",
  lastEventBlock: 1,
};

const reservation = {
  schemaVersion: "1.0",
  vault: envelope.vault,
  reservationId: 7,
  envelopeId: 1,
  stepIndex: 0,
  payee: "0x0000000000000000000000000000000000000002",
  unitAmount: "50000",
  count: 2,
  validBefore: 1_800_000_000,
  mode: "envelope",
  settledMask: `0x${"0".repeat(64)}`,
  settledCount: 0,
  releasedCount: 0,
  state: "Active",
};

const pullback = {
  pullbackId: 3,
  value: "25000",
  salt: `0x${"6".repeat(64)}`,
  maxFee: "1000",
  maxBlockHeight: 100,
  transferSpecHash: `0x${"7".repeat(64)}`,
  requestedAtBlock: 100,
  state: "Pending",
  recovery: false,
};

const pocket = {
  schemaVersion: "1.1",
  vault: envelope.vault,
  envelopeId: 1,
  pocket: "0x0000000000000000000000000000000000000003",
  keyRef: "pocket-test-key",
  state: "Draining",
  funded: "50000",
  gasGranted: "0",
  outstanding: "25000",
  pendingPullback: "25000",
  pullbacks: [pullback],
};

const job = {
  schemaVersion: "1.1",
  vault: envelope.vault,
  envelopeId: 1,
  stepIndex: 0,
  jobEscrow: "0x0000000000000000000000000000000000000004",
  jobId: "9",
  jobKey: `0x${"8".repeat(64)}`,
  provider: "0x0000000000000000000000000000000000000005",
  evaluator: "0x0000000000000000000000000000000000000006",
  reservedCap: "50000",
  budget: "50000",
  descriptionHash: `0x${"9".repeat(64)}`,
  state: "Submitted",
  expiredAt: 1_900_000_000,
};

const seed = (): QueryRows => ({
  envelopes: [
    { id: `${envelope.vault}:1`, vault: envelope.vault, envelopeId: 1n, mirror: envelope },
  ],
  reservations: [
    { id: `${envelope.vault}:7`, vault: envelope.vault, reservationId: 7n, mirror: reservation },
  ],
  pockets: [
    { id: `${envelope.vault}:0x03`, vault: envelope.vault, envelopeId: 1n, mirror: pocket },
  ],
  jobs: [{ id: "job:9", vault: envelope.vault, envelopeId: 1n, mirror: job }],
  externalEvents: [],
  anchors: [],
  gatewayTransfers: [],
});

function seededDb(rows = seed()) {
  const readCounts: Partial<Record<QueryTable, number>> = {};
  return {
    readCounts,
    async rows(table: QueryTable) {
      readCounts[table] = (readCounts[table] ?? 0) + rows[table].length;
      return rows[table];
    },
  };
}

describe("indexer query API", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the envelope and validates all included mirror records", async () => {
    const app = createIndexerApi(seededDb(), loadConfig());
    const response = await app.request(`/envelopes/${encodeURIComponent(envelope.envelopeRef)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ envelope, reservations: [reservation] });
  });

  it("returns reservations whose authorization nonce is not settled", async () => {
    const rows = seed();
    rows.externalEvents.push({
      id: "tx:1",
      emitter: envelope.vault,
      name: "AuthorizationUsed",
      block: 2n,
      payload: { nonce: derivedNonce(envelope.vault as `0x${string}`, 7n, 0) },
    });
    const app = createIndexerApi(seededDb(rows), loadConfig());
    const response = await app.request(`/reservations/needing-settle?vault=${envelope.vault}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [reservation], nextCursor: null });
  });

  it("returns reservations needing finalization", async () => {
    const app = createIndexerApi(seededDb(), loadConfig());
    const response = await app.request("/reservations/needing-finalize?now=1800000001");
    expect(((await response.json()) as { items: unknown[] }).items).toEqual([reservation]);
  });

  it("returns pending pullbacks with matching attestations and enforces the cancel delay", async () => {
    const rows = seed();
    rows.externalEvents.push({
      id: "attest:1",
      emitter: "minter",
      name: "AttestationUsed",
      block: 120n,
      payload: { transferSpecHash: pullback.transferSpecHash },
    });
    const app = createIndexerApi(seededDb(rows), loadConfig());
    const confirm = await app.request("/pullbacks/to-confirm");
    expect(((await confirm.json()) as { items: unknown[] }).items).toMatchObject([{ pullback }]);
    const cancelEarly = await app.request("/pullbacks/to-cancel?block=3099");
    expect(((await cancelEarly.json()) as { items: unknown[] }).items).toEqual([]);
    const cancelOld = await app.request("/pullbacks/to-cancel?block=3101");
    expect(((await cancelOld.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("returns stale pending pullbacks for cancellation after the configured delay", async () => {
    const rows = seed();
    const app = createIndexerApi(seededDb(rows), loadConfig());
    const response = await app.request("/pullbacks/to-cancel?block=3100");
    expect(((await response.json()) as { items: unknown[] }).items).toMatchObject([{ pullback }]);
  });

  it("keeps the named pullback delay equal to the Solidity contract constant", () => {
    const solidity = readFileSync(
      new URL("../../../contracts/src/libraries/CzarConstants.sol", import.meta.url),
      "utf8",
    );
    expect(solidity).toMatch(/PULLBACK_CANCEL_DELAY_BLOCKS\s*=\s*3_000\s*;/);
  });

  it("selects jobs whose indexed escrow status differs from the vault mirror", async () => {
    const rows = seed();
    rows.externalEvents.push({
      id: "job-complete:1",
      emitter: job.jobEscrow,
      name: "JobCompleted",
      block: 20n,
      payload: { jobId: job.jobId },
    });
    const app = createIndexerApi(seededDb(rows), loadConfig());
    const response = await app.request("/jobs/to-sync");
    expect(((await response.json()) as { items: unknown[] }).items).toEqual([job]);
    const awaiting = await app.request("/jobs/awaiting-evaluation");
    expect(((await awaiting.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("returns submitted jobs awaiting evaluation", async () => {
    const app = createIndexerApi(seededDb(), loadConfig());
    const response = await app.request("/jobs/awaiting-evaluation");
    expect(((await response.json()) as { items: unknown[] }).items).toEqual([job]);
  });

  it("returns the highest matching anchor and the anchor for a batch root", async () => {
    const rows = seed();
    rows.anchors.push(
      {
        id: "a1",
        publisher: "publisher",
        kind: 1,
        seq: "2",
        root: "root-2",
        prev: "root-1",
        uriHash: "hash",
        uri: "uri",
        batchRoot: "batch",
        block: 20n,
        transaction: "tx-2",
      },
      {
        id: "a2",
        publisher: "publisher",
        kind: 1,
        seq: "3",
        root: "root-3",
        prev: "root-2",
        uriHash: "hash",
        uri: "uri",
        batchRoot: "batch",
        block: 30n,
        transaction: "tx-3",
      },
    );
    const app = createIndexerApi(seededDb(rows), loadConfig());
    expect(await (await app.request("/anchors/latest?publisher=publisher&kind=1")).json()).toEqual({
      root: "root-3",
      seq: "3",
      block: "30",
      transaction: "tx-3",
    });
    expect(await (await app.request("/anchors/batch")).json()).toMatchObject({ root: "root-2" });
    expect((await app.request("/dependency-state")).status).toBe(404);
  });

  it("returns one SQL-selected page rather than loading every reservation", async () => {
    const rows = seed();
    for (let id = 8; id < 20; id += 1) {
      rows.reservations.push({
        id: `${envelope.vault}:${id}`,
        vault: envelope.vault,
        reservationId: BigInt(id),
        mirror: { ...reservation, reservationId: id },
      });
    }
    const source = seededDb(rows);
    const app = createIndexerApi(source, loadConfig({ envFile: { "api.pageDefaultLimit": 2 } }));
    const response = await app.request("/reservations/needing-finalize?now=1900000000&limit=2");
    expect(((await response.json()) as { items: unknown[] }).items).toHaveLength(2);
    expect(source.readCounts?.reservations).toBe(2);
  });

  it("returns ledger facts with the fixed chain and Gateway status mapping", async () => {
    const app = createIndexerApi(seededDb(), loadConfig());
    expect((await app.request(`/receipts?vault=${envelope.vault}`)).status).toBe(200);
  });

  it("paginates reservations with opaque cursors that expire", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T00:00:00.000Z"));
    const rows = seed();
    rows.reservations.push({
      id: `${envelope.vault}:8`,
      vault: envelope.vault,
      reservationId: 8n,
      mirror: { ...reservation, reservationId: 8, validBefore: 1_800_000_001 },
    });
    const config = loadConfig({ envFile: { "api.pageDefaultLimit": 1 } });
    const app = createIndexerApi(seededDb(rows), config);
    const first = await app.request("/reservations/needing-finalize?now=1900000000&limit=1");
    expect(first.status).toBe(200);
    const page = (await first.json()) as { items: unknown[]; nextCursor: string | null };
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    vi.advanceTimersByTime(61 * 60_000);
    const expired = await app.request(
      `/reservations/needing-finalize?now=1900000000&limit=1&cursor=${page.nextCursor}`,
    );
    expect(expired.status).toBe(400);
  });

  it("rejects limits outside 1 through 200", async () => {
    const app = createIndexerApi(seededDb(), loadConfig());
    expect((await app.request("/reservations/needing-finalize?now=1&limit=0")).status).toBe(400);
    expect((await app.request("/reservations/needing-finalize?now=1&limit=201")).status).toBe(400);
  });
});
