import type { Pool } from "pg";
import type { Hash32 } from "@czar/hashing";
import type { Claim, PaymentIdStore } from "./payment-id-store.ts";

const SWEEP_BATCH_SIZE = 100;

interface StoreOptions {
  readonly pool: Pool;
  readonly ttlMs: number;
  readonly maxBytes: number;
}

interface StoredRow {
  readonly fingerprint: Buffer;
  readonly state: "pending" | "complete";
  readonly response_status: number | null;
  readonly response_body: string | null;
  readonly payment_response: string | null;
}

export function postgresPaymentIdStore(options: StoreOptions): PaymentIdStore {
  const ttlInterval = `${options.ttlMs} milliseconds`;

  return {
    async claim(route, id, fingerprint) {
      const client = await options.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `DELETE FROM merchant_payment_identifiers
           WHERE ctid IN (
             SELECT ctid FROM merchant_payment_identifiers
             WHERE expires_at <= now()
             ORDER BY expires_at
             LIMIT $1
             FOR UPDATE SKIP LOCKED
           )`,
          [SWEEP_BATCH_SIZE],
        );
        const inserted = await client.query(
          `INSERT INTO merchant_payment_identifiers
            (route, payment_identifier, fingerprint, state, expires_at)
           VALUES ($1, $2, $3, 'pending', now() + $4::interval)
           ON CONFLICT (route, payment_identifier) DO UPDATE SET
             fingerprint = EXCLUDED.fingerprint,
             state = 'pending', stored_at = now(), expires_at = EXCLUDED.expires_at,
             response_status = NULL, response_body = NULL, payment_response = NULL
           WHERE merchant_payment_identifiers.expires_at <= now()
           RETURNING payment_identifier`,
          [route, id, hashBytes(fingerprint), ttlInterval],
        );
        if (inserted.rowCount === 1) {
          await client.query("COMMIT");
          return { kind: "new" };
        }
        const existing = await client.query<StoredRow>(
          `SELECT fingerprint, state, response_status, response_body, payment_response
           FROM merchant_payment_identifiers
           WHERE route = $1 AND payment_identifier = $2 FOR UPDATE`,
          [route, id],
        );
        const row = existing.rows[0];
        if (row === undefined) throw new Error("payment identifier claim disappeared");
        const claim = classify(row, fingerprint);
        await client.query("COMMIT");
        return claim;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Payment identifier claim rollback failed.",
            { cause: rollbackError },
          );
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async complete(route, id, response) {
      const size = Buffer.byteLength(response.body) + Buffer.byteLength(response.paymentResponse);
      const storable = size <= options.maxBytes;
      await options.pool.query(
        `UPDATE merchant_payment_identifiers SET
           state = 'complete', stored_at = now(), expires_at = now() + $3::interval,
           response_status = $4, response_body = $5, payment_response = $6
         WHERE route = $1 AND payment_identifier = $2 AND state = 'pending'`,
        [
          route,
          id,
          ttlInterval,
          storable ? response.status : null,
          storable ? response.body : null,
          storable ? response.paymentResponse : null,
        ],
      );
    },

    async release(route, id) {
      await options.pool.query(
        `DELETE FROM merchant_payment_identifiers
         WHERE route = $1 AND payment_identifier = $2 AND state = 'pending'`,
        [route, id],
      );
    },
  };
}

function classify(row: StoredRow, fingerprint: Hash32): Claim {
  if (!row.fingerprint.equals(hashBytes(fingerprint))) return { kind: "conflict" };
  if (row.state === "pending") return { kind: "in-flight" };
  if (row.response_status === null || row.response_body === null || row.payment_response === null)
    return { kind: "in-flight" };
  return {
    kind: "replay",
    response: {
      status: row.response_status,
      body: row.response_body,
      paymentResponse: row.payment_response,
    },
  };
}

function hashBytes(value: Hash32): Buffer {
  return Buffer.from(value.slice(2), "hex");
}
