// `payment-identifier` idempotency store (CZ-20 §5.4). Keyed per route and id; the fingerprint binds the
// request (`payment_identifier.md` "Request Binding"), so a reused id with a different request is a 409.
// The Postgres implementation follows the same interface; this in-memory one serves tests and local runs.
import { H, type Hash32 } from "@czar/hashing";

export interface StoredResponse {
  readonly status: number;
  readonly body: string;
  readonly paymentResponse: string;
}

export interface FingerprintInput {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly route: string;
  readonly method: string;
  readonly inputHash: Hash32;
}

export const fingerprint = (input: FingerprintInput): Hash32 => H(input);

export type Claim =
  | { readonly kind: "new" }
  | { readonly kind: "replay"; readonly response: StoredResponse }
  | { readonly kind: "conflict" }
  | { readonly kind: "in-flight" };

export interface PaymentIdStore {
  /** Reserves `(route, id)` for this fingerprint, or reports what is already there. */
  claim(route: string, id: string, fingerprint: Hash32): Promise<Claim>;
  complete(route: string, id: string, response: StoredResponse): Promise<void>;
  /** Drops a reservation whose request ended without a stored response (no charge happened). */
  release(route: string, id: string): Promise<void>;
}

const key = (route: string, id: string) => `${route} ${id}`;

export function memoryPaymentIdStore(options: {
  readonly ttlMs: number;
  readonly maxBytes: number;
  readonly now?: () => number;
}): PaymentIdStore & { size(): number } {
  const now = options.now ?? Date.now;
  const entries = new Map<
    string,
    { fingerprint: Hash32; storedAt: number; response?: StoredResponse }
  >();
  const sweep = () => {
    for (const [k, entry] of entries)
      if (now() - entry.storedAt >= options.ttlMs) entries.delete(k);
  };
  return {
    size: () => entries.size,
    async claim(route, id, fp) {
      sweep();
      const existing = entries.get(key(route, id));
      if (existing === undefined) {
        entries.set(key(route, id), { fingerprint: fp, storedAt: now() });
        return { kind: "new" };
      }
      if (existing.fingerprint !== fp) return { kind: "conflict" };
      if (existing.response === undefined) return { kind: "in-flight" };
      return { kind: "replay", response: existing.response };
    },
    async complete(route, id, response) {
      const entry = entries.get(key(route, id));
      if (entry === undefined) return;
      const size = Buffer.byteLength(response.body) + Buffer.byteLength(response.paymentResponse);
      // Too large to cache: keep the fingerprint so a reused id still conflicts, but do not replay.
      if (size > options.maxBytes) return;
      entries.set(key(route, id), { ...entry, response, storedAt: now() });
    },
    async release(route, id) {
      const entry = entries.get(key(route, id));
      if (entry !== undefined && entry.response === undefined) entries.delete(key(route, id));
    },
  };
}
