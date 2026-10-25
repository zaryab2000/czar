import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hash32 } from "@czar/hashing";
import { appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";
import { encodeBase64Json } from "@czar/x402";
import { postgresPaymentIdStore } from "../src/postgres-payment-id-store.ts";
import { createSearchRoute } from "../src/search/route.ts";
import type { Facilitator } from "../src/facilitator.ts";
import { migrateMerchant } from "../src/migrate.ts";

const TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:15432/postgres";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Postgres payment identifier store", () => {
  let admin: Pool;
  let pool: Pool;
  let databaseName: string;
  const fp = `0x${"11".repeat(32)}` as Hash32;
  const response = { status: 200, body: '{"ok":true}', paymentResponse: "settled" };

  beforeAll(async () => {
    admin = new Pool({ connectionString: TEST_DATABASE_URL });
    databaseName = `czar_t_${randomBytes(8).toString("hex")}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.toString() });
    await migrateMerchant(pool);
    await migrateMerchant(pool);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseName) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  });

  it("atomically claims a route/id across concurrent callers", async () => {
    const store = postgresPaymentIdStore({ pool, ttlMs: 60_000, maxBytes: 1024 });
    const claims = await Promise.all(
      Array.from({ length: 12 }, () => store.claim("/v1/search", "pay_parallel_000001", fp)),
    );
    expect(claims.filter((claim) => claim.kind === "new")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "in-flight")).toHaveLength(11);
  });

  it("does not call settle for an in-flight duplicate HTTP payment", async () => {
    const store = postgresPaymentIdStore({ pool, ttlMs: 60_000, maxBytes: 1024 });
    const started = deferred();
    const verifyGate = deferred();
    let settles = 0;
    const facilitator: Facilitator = {
      async verify() {
        started.resolve();
        await verifyGate.promise;
        return { isValid: true, payer: "0x00000000000000000000000000000000000c2a21" };
      },
      async settle() {
        settles += 1;
        return { success: true, transaction: "0xabc", network: "eip155:5042002" };
      },
    };
    const resourceUrl = "https://merchant.test/v1/search";
    const route = createSearchRoute({
      resourceUrl,
      network: "eip155:5042002",
      payTo: "0x00000000000000000000000000000000000000A1",
      priceAtomic: "50000",
      maxTimeoutSeconds: 300,
      handlerTimeoutMs: 1000,
      facilitator,
      store,
    });
    const challenge = await route(new Request(`${resourceUrl}?q=x`));
    const accepted = (await challenge.json()) as { accepts: [Record<string, unknown>] };
    const header = encodeBase64Json({
      x402Version: 2,
      resource: { url: resourceUrl },
      accepted: accepted.accepts[0],
      payload: {
        signature: `0x${"11".repeat(65)}`,
        authorization: {
          from: "0x00000000000000000000000000000000000c2a21",
          to: "0x00000000000000000000000000000000000000A1",
          value: "50000",
          validAfter: "0",
          validBefore: "1760800300",
          nonce: `0x${"22".repeat(32)}`,
        },
      },
      extensions: appendPaymentIdentifierToExtensions(
        { "payment-identifier": { info: { required: false } } },
        "pay_inflight_postgres_0001",
      ),
    });
    const request = () =>
      route(new Request(`${resourceUrl}?q=x`, { headers: { "payment-signature": header } }));
    const first = request();
    await started.promise;
    const duplicate = await request();
    expect(duplicate.status).toBe(409);
    verifyGate.resolve();
    expect((await first).status).toBe(200);
    expect(settles).toBe(1);
  });

  it("replays after a new store instance and rejects a different fingerprint", async () => {
    const first = postgresPaymentIdStore({ pool, ttlMs: 60_000, maxBytes: 1024 });
    await first.claim("/v1/search", "pay_restart_000001", fp);
    await first.complete("/v1/search", "pay_restart_000001", response);
    const restarted = postgresPaymentIdStore({ pool, ttlMs: 60_000, maxBytes: 1024 });
    expect(await restarted.claim("/v1/search", "pay_restart_000001", fp)).toEqual({
      kind: "replay",
      response,
    });
    expect(
      await restarted.claim("/v1/search", "pay_restart_000001", `0x${"22".repeat(32)}` as Hash32),
    ).toEqual({
      kind: "conflict",
    });
  });

  it("expires claims, keeps oversized completed responses non-replayable, and surfaces database errors", async () => {
    const store = postgresPaymentIdStore({ pool, ttlMs: 1, maxBytes: 4 });
    await store.claim("/v1/search", "pay_ttl_0000000001", fp);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await store.claim("/v1/search", "pay_ttl_0000000001", fp)).toEqual({ kind: "new" });

    await store.complete("/v1/search", "pay_ttl_0000000001", response);
    expect(await store.claim("/v1/search", "pay_ttl_0000000001", fp)).toEqual({
      kind: "in-flight",
    });

    const unavailable = new Pool({
      connectionString: "postgres://127.0.0.1:1/unavailable",
      connectionTimeoutMillis: 50,
    });
    await expect(
      postgresPaymentIdStore({ pool: unavailable, ttlMs: 1000, maxBytes: 1024 }).claim(
        "/v1/search",
        "pay_db_error_000001",
        fp,
      ),
    ).rejects.toThrow();
    await unavailable.end();
  });
});
