// The signer service (CZ-27 §6): caller and key checks → shape → policy (digest rebuilt) → rate limit →
// backend → audit. A refusal returns `kms_denied` with the rule; nothing is signed and the backend is
// never called.
import type { Hex, TransactionSerializableEIP1559 } from "viem";
import type { Config } from "@czar/config";
import type { Address, Hash32 } from "@czar/hashing";
import type { SignerBackend } from "./backend.ts";
import {
  INTERACTIVE_KEYS,
  KEY_IDS,
  KEY_KINDS,
  KINDS,
  NEVER_SENDS,
  TRANSACTION_KINDS,
  type KeyId,
  type Kind,
} from "./kinds.ts";
import {
  decide,
  Denied,
  type PolicyContext,
  type PurposeIds,
  type SignerNetwork,
} from "./policy.ts";
import type { Projection } from "./projection.ts";
import { parseRequest } from "./requests.ts";

/** One row per request; ids, digests and outcome only, never payloads or text (CZ-27 §5.2, §8). */
export interface AuditRow {
  readonly at: number;
  readonly caller: string;
  readonly keyRef: string;
  readonly kind: string;
  readonly digest?: Hash32;
  readonly purpose: PurposeIds;
  readonly outcome: "signed" | "kms_denied" | "backend-error";
  readonly rule?: string;
}

export interface AuditSink {
  write(row: AuditRow): Promise<void>;
}

export function memoryAudit(): AuditSink & { rows: AuditRow[] } {
  const rows: AuditRow[] = [];
  return {
    rows,
    write: async (row) => {
      rows.push(row);
    },
  };
}

/** Fills nonce, gas and fees for a call from `from` (RPC-backed in production). */
export type TransactionPreparer = (
  from: Address,
  call: { to: Address; data: Hex; value: bigint },
) => Promise<TransactionSerializableEIP1559>;

export interface SignRequest {
  readonly keyId: string;
  readonly kind: string;
  readonly payload: unknown;
}

export type SignResult =
  | { readonly signature: Hex; readonly digest: Hash32 }
  | { readonly signedTransaction: Hex };

export interface SignerOptions {
  readonly backend: SignerBackend;
  readonly projection: Projection;
  readonly network: SignerNetwork;
  readonly config: Config;
  readonly audit: AuditSink;
  /** Service identity → the keys it owns (CZ-27 §5.1 "owner service"). */
  readonly callers: Readonly<Record<string, readonly KeyId[]>>;
  readonly prepareTransaction: TransactionPreparer;
  /** Milliseconds. */
  readonly nowMs?: () => number;
}

const RATE_WINDOW_MS = 60_000;

/** `kms.maxSignaturesPerMin.<key>`; K4 counts per pocket. */
function rateLimitFor(config: Config, keyId: KeyId): number {
  const key = keyId === "relayer" ? "relayer" : keyId;
  const name = `kms.maxSignaturesPerMin.${key}` as Parameters<Config["get"]>[0];
  return Number(config.get(name));
}

export interface Signer {
  sign(caller: string, request: SignRequest): Promise<SignResult>;
  /** CZ-13 at planning (D71): a fresh pocket key; the address goes into the plan's `payeeRoot`. */
  createPocketKey(caller: string): Promise<Address>;
  /** Refused unless every balance is zero (RV-004); the key is destroyed `signer.pocketKeyRetainHours` later. */
  retirePocketKey(caller: string, pocket: Address): Promise<{ destroyAfterMs: number }>;
  destroyRetiredPocketKeys(): Promise<Address[]>;
}

export function createSigner(options: SignerOptions): Signer {
  const { backend, projection, network, config, audit, callers } = options;
  const nowMs = options.nowMs ?? Date.now;
  const windows = new Map<string, number[]>();
  const retiring = new Map<string, number>();

  const keyAddress = (key: "K3" | "K7" | "K8"): Address => {
    const address = backend.address(key);
    if (address === undefined) throw new Denied("unknown-key");
    return address;
  };
  const ctx: PolicyContext = {
    projection,
    network,
    now: () => Math.floor(nowMs() / 1000),
    freezeStateMaxAgeSec: Number(config.get("signer.freezeStateMaxAgeSec")),
    keyAddress,
    merchantKeyAddress: (service) => {
      const address = backend.address(`K10:${service}`);
      if (address === undefined) throw new Denied("unknown-key");
      return address;
    },
    gasMaxAtomic: {
      K3: BigInt(config.get("signer.gas.K3.maxAtomic") as number),
      K7: BigInt(config.get("signer.gas.K7.maxAtomic") as number),
      K8: BigInt(config.get("signer.gas.K8.maxAtomic") as number),
    },
  };

  const owns = (caller: string, keyId: KeyId) => (callers[caller] ?? []).includes(keyId);

  function takeRateSlot(keyId: KeyId, keyRef: string) {
    const limit = rateLimitFor(config, keyId);
    const now = nowMs();
    const recent = (windows.get(keyRef) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= limit) {
      windows.set(keyRef, recent);
      throw new Denied("rate-limit");
    }
    recent.push(now);
    windows.set(keyRef, recent);
  }

  async function sign(caller: string, request: SignRequest): Promise<SignResult> {
    let keyRef = String(request.keyId);
    let digest: Hash32 | undefined;
    let purpose: PurposeIds = {};
    try {
      if (!KEY_IDS.includes(request.keyId as KeyId)) throw new Denied("unknown-key");
      if (!KINDS.includes(request.kind as Kind)) throw new Denied("unknown-kind");
      const keyId = request.keyId as KeyId;
      const kind = request.kind as Kind;
      if (!owns(caller, keyId)) throw new Denied("caller-not-owner");
      if (INTERACTIVE_KEYS.has(keyId)) throw new Denied("interactive-only");
      if (!KEY_KINDS[keyId].includes(kind)) throw new Denied("kind-not-allowed");
      if (NEVER_SENDS.has(keyId) && TRANSACTION_KINDS.has(kind)) throw new Denied("never-sends");

      let parsed: Record<string, unknown>;
      try {
        parsed = parseRequest(kind, request.payload);
      } catch {
        throw new Denied("shape");
      }
      if (keyId === "K4") keyRef = `K4:${parsed["pocket"] as string}`;
      if (keyId === "K10") {
        const service = parsed["service"] as string;
        if (!network.merchantServices.includes(service)) throw new Denied("unknown-service");
        keyRef = `K10:${service}`;
      }
      const from = backend.address(keyRef);
      if (from === undefined) throw new Denied("unknown-key");
      if (retiring.has(keyRef)) throw new Denied("pocket-key-retiring");

      const decision = await decide(ctx, kind, parsed);
      purpose = decision.purpose;
      takeRateSlot(keyId, keyRef);

      if (decision.type === "digest") {
        digest = decision.digest;
        const raw = await backend.signDigest(keyRef, decision.digest);
        await audit.write({
          at: nowMs(),
          caller,
          keyRef,
          kind,
          digest,
          purpose,
          outcome: "signed",
        });
        return { signature: decision.wrap ? decision.wrap(raw) : raw, digest };
      }
      const tx = await options.prepareTransaction(from, {
        to: decision.to,
        data: decision.data,
        value: decision.value,
      });
      if (
        tx.chainId !== network.chainId ||
        tx.to?.toLowerCase() !== decision.to.toLowerCase() ||
        tx.data !== decision.data ||
        (tx.value ?? 0n) !== decision.value
      )
        throw new Denied("prepared-transaction-mismatch");
      const signedTransaction = await backend.signTransaction(keyRef, tx);
      await audit.write({ at: nowMs(), caller, keyRef, kind, purpose, outcome: "signed" });
      return { signedTransaction };
    } catch (error) {
      const denied = error instanceof Denied;
      await audit.write({
        at: nowMs(),
        caller,
        keyRef,
        kind: String(request.kind),
        ...(digest === undefined ? {} : { digest }),
        purpose,
        outcome: denied ? "kms_denied" : "backend-error",
        rule: denied ? error.rule : "backend",
      });
      throw error;
    }
  }

  return {
    sign,
    async createPocketKey(caller) {
      if (!owns(caller, "K4")) throw new Denied("caller-not-owner");
      return (await backend.createKey("K4")).address;
    },
    async retirePocketKey(caller, pocket) {
      if (!owns(caller, "K4")) throw new Denied("caller-not-owner");
      const keyRef = `K4:${pocket.toLowerCase()}`;
      if (backend.address(keyRef) === undefined) throw new Denied("unknown-key");
      await requireZeroBalances(pocket);
      const destroyAfterMs =
        nowMs() + Number(config.get("signer.pocketKeyRetainHours")) * 3_600_000;
      retiring.set(keyRef, destroyAfterMs);
      return { destroyAfterMs };
    },
    async destroyRetiredPocketKeys() {
      const destroyed: Address[] = [];
      for (const [keyRef, after] of retiring) {
        if (nowMs() < after) continue;
        const pocket = keyRef.slice(3) as Address;
        try {
          await requireZeroBalances(pocket);
        } catch {
          // A balance came back during the retain window: keep the key and stop the countdown.
          retiring.delete(keyRef);
          continue;
        }
        await backend.destroyKey(keyRef);
        retiring.delete(keyRef);
        destroyed.push(pocket);
      }
      return destroyed;
    },
  };

  async function requireZeroBalances(pocket: Address) {
    const b = await projection.pocketBalances(pocket);
    const view = await projection.pocket(pocket);
    const dust = BigInt(config.get("signer.pocketDustAtomic") as number);
    const zero =
      b.gatewayApi === 0n &&
      b.gatewayAvailable === 0n &&
      b.gatewayWithdrawing === 0n &&
      b.usdc === 0n &&
      !b.pendingPullback &&
      b.native < dust &&
      view?.slowWithdrawalOpen !== true;
    if (!zero) throw new Denied("pocket-balance-not-zero");
  }
}
