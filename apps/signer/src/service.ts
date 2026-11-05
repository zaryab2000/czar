// The signer service (CZ-27 §6): caller and key checks → shape → policy (digest rebuilt) → rate limit →
// backend → audit. A refusal returns `kms_denied` with the rule; nothing is signed and the backend is
// never called.
import {
  encodeFunctionData,
  keccak256,
  parseTransaction,
  serializeTransaction,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { createLogger, type Logger } from "@czar/logging";
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
import { USDC_ABI } from "./abi.ts";
import {
  decide,
  Denied,
  gasReserveAtomic,
  pocketEmpty,
  usdcPaysGas,
  type PolicyContext,
  type PurposeIds,
  type SignerNetwork,
} from "./policy.ts";
import type { SpendRecord } from "./pending.ts";
import type { Projection } from "./projection.ts";
import { parseRequest } from "./requests.ts";

/**
 * SCR-180 §3: the scope whose read pending → check → record sequence must not interleave. `gateway-nano`
 * spends and checks per pocket; `usdc-3009` records the calls that `vault-call` (`reserve`,
 * `reserveWithDigests`, `openJob`, `registerPocket`) checks, so both run per vault. Other kinds neither record
 * nor read pending.
 */
function spendScope(kind: Kind, parsed: Record<string, unknown>): string | undefined {
  switch (kind) {
    case "gateway-nano":
      return `pocket:${String(parsed["pocket"]).toLowerCase()}`;
    case "usdc-3009":
    case "vault-call":
      return `vault:${String(parsed["vault"]).toLowerCase()}`;
    default:
      return undefined;
  }
}

/** The release of a spend lock that was never taken. */
const NOT_HELD = (): void => undefined;

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
  /**
   * SCR-180 §2, signed `gateway-nano` and `usdc-3009` rows only: the fields pending spend is computed from
   * (stored in `object_ids` and `amount_atomic`). Ids and amounts, never payloads.
   */
  readonly spend?: SpendRecord;
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

/**
 * SCR-152 `gasReserve` of a `pocket-return` of `amount` USDC from `pocket` to its vault, from the transaction
 * `prepare` builds for it (the same preparer the signer signs with).
 */
export async function pocketReturnGasReserve(
  prepare: TransactionPreparer,
  input: {
    readonly usdc: Address;
    readonly pocket: Address;
    readonly vault: Address;
    readonly amount: bigint;
  },
): Promise<bigint> {
  const tx = await prepare(input.pocket, {
    to: input.usdc,
    data: encodeFunctionData({
      abi: USDC_ABI,
      functionName: "transfer",
      args: [input.vault, input.amount],
    }),
    value: 0n,
  });
  return gasReserveAtomic(tx);
}

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
  /** Shared signer alert delivery for policy and gas-refill alerts. */
  readonly alert?: SignerAlertPort;
  readonly logger?: Pick<Logger, "error">;
  /** Milliseconds. */
  readonly nowMs?: () => number;
}

/** Delivers public signer-operational alert messages. */
export type SignerAlertPort = (message: string) => Promise<void>;

const RATE_WINDOW_MS = 60_000;
const ADDRESS_KEY_OWNERS: Readonly<Record<string, { caller: string; keyId: KeyId }>> = {
  K3: { caller: "cz-15", keyId: "K3" },
  K5: { caller: "cz-24", keyId: "K5" },
  K7: { caller: "cz-16", keyId: "K7" },
  K8: { caller: "cz-17", keyId: "K8" },
};

/** `kms.maxSignaturesPerMin.<key>`; K4 counts per pocket. */
function rateLimitFor(config: Config, keyId: KeyId): number {
  const key = keyId === "relayer" ? "relayer" : keyId;
  const name = `kms.maxSignaturesPerMin.${key}` as Parameters<Config["get"]>[0];
  return Number(config.get(name));
}

export interface Signer {
  sign(caller: string, request: SignRequest): Promise<SignResult>;
  /** Returns a key address only when the caller already owns that key (SCR-129). */
  keyAddress(caller: string, keyRef: string): Promise<Address>;
  /** CZ-13 at planning (D71): a fresh pocket key; the address goes into the plan's `payeeRoot`. */
  createPocketKey(caller: string): Promise<Address>;
  /** Refused unless every balance is zero (RV-004); the key is destroyed `signer.pocketKeyRetainHours` later. */
  retirePocketKey(caller: string, pocket: Address): Promise<{ destroyAfterMs: number }>;
  destroyRetiredPocketKeys(): Promise<Address[]>;
  /**
   * In-process only: a transaction this signer signed for `keyRef` that its sender failed to broadcast. Its
   * nonce is assigned again when it is still the key's last, so later transactions never wait behind a gap.
   */
  abandonTransaction(keyRef: string, signedTransaction: Hex): Promise<void>;
}

export function createSigner(options: SignerOptions): Signer {
  const { backend, projection, network, config, audit, callers } = options;
  const nowMs = options.nowMs ?? Date.now;
  const logger = options.logger ?? createLogger({ service: "signer", component: "CZ-27" });
  const windows = new Map<string, number[]>();
  const keyAddressWindows = new Map<string, number[]>();
  const retiring = new Map<string, number>();
  const nonceLocks = new Map<string, Promise<unknown>>();
  const spendLocks = new Map<string, Promise<unknown>>();
  const lastNonces = new Map<string, number>();

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
    gatewayWriteOffMaxAtomic:
      BigInt(config.get("payer.pullbackMaxFeeAtomic") as number) +
      BigInt(config.get("payer.pullbackSafetyAtomic") as number),
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
    pocketReturnGasReserve: (pocket, vault, amount) =>
      pocketReturnGasReserve(options.prepareTransaction, {
        usdc: network.usdc,
        pocket,
        vault,
        amount,
      }),
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

  function takeKeyAddressRateSlot(caller: string) {
    const limit = Number(config.get("signer.keyAddressPerMin"));
    const now = nowMs();
    const recent = (keyAddressWindows.get(caller) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length >= limit) {
      keyAddressWindows.set(caller, recent);
      throw new Denied("rate-limit");
    }
    recent.push(now);
    keyAddressWindows.set(caller, recent);
  }

  function mayReadAddress(caller: string, keyRef: string): boolean {
    if (keyRef.startsWith("K10:")) {
      const service = keyRef.slice(4);
      return (
        service.length > 0 && network.merchantServices.includes(service) && owns(caller, "K10")
      );
    }
    const owner = ADDRESS_KEY_OWNERS[keyRef];
    return owner !== undefined && owner.caller === caller && owns(caller, owner.keyId);
  }

  /**
   * SCR-159 §2: transactions for one key are prepared and signed one at a time, so two concurrent requests (the
   * dispatcher and the freeze handler, both K3) never read the same pending count.
   */
  async function withNonceLock<T>(keyRef: string, run: () => Promise<T>): Promise<T> {
    const previous = nonceLocks.get(keyRef) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    nonceLocks.set(keyRef, current);
    try {
      return await current;
    } finally {
      if (nonceLocks.get(keyRef) === current) nonceLocks.delete(keyRef);
    }
  }

  /**
   * SCR-180 §3: one request per spend scope at a time, from the policy's pending read to the signed audit row.
   * One signer process runs (SCR-170 §1), so an in-process lock is enough. Resolves once every earlier holder
   * of the scope has released it, and returns the release. It is taken before, and released after, the per-key
   * nonce lock; the nonce lock never takes it.
   */
  async function acquireSpendLock(scope: string | undefined): Promise<() => void> {
    if (scope === undefined) return NOT_HELD;
    const previous = spendLocks.get(scope) ?? Promise.resolve();
    let release: () => void = NOT_HELD;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    spendLocks.set(scope, tail);
    await previous;
    return () => {
      release();
      if (spendLocks.get(scope) === tail) spendLocks.delete(scope);
    };
  }

  /** `nonce = max(pending count from the RPC, last nonce assigned to this key + 1)` (SCR-159 §2). */
  /** Hands back a signed transaction's nonce while it is still the key's last one (SCR-159 §2). */
  function releaseNonce(keyRef: string, signedTransaction: Hex): Promise<void> {
    return withNonceLock(keyRef, async () => {
      if (lastNonces.get(keyRef) === parseTransaction(signedTransaction).nonce)
        lastNonces.delete(keyRef);
    });
  }

  function assignNonce(
    keyRef: string,
    tx: TransactionSerializableEIP1559,
  ): TransactionSerializableEIP1559 & { readonly nonce: number } {
    if (tx.nonce === undefined) throw new Error("Prepared transaction has no nonce.");
    const last = lastNonces.get(keyRef);
    return { ...tx, nonce: last === undefined ? tx.nonce : Math.max(tx.nonce, last + 1) };
  }

  async function sign(caller: string, request: SignRequest): Promise<SignResult> {
    let keyRef = String(request.keyId);
    let digest: Hash32 | undefined;
    let purpose: PurposeIds = {};
    let releaseSpend: () => void = NOT_HELD;
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

      // SCR-180 §3: the pending read inside `decide`, the check and the signed audit row run under one lock,
      // released in `finally` below whatever the outcome.
      releaseSpend = await acquireSpendLock(spendScope(kind, parsed));
      const decision = await decide(ctx, kind, parsed, { keyId, address: from });
      purpose = decision.purpose;
      takeRateSlot(keyId, keyRef);

      if (decision.type === "digest") {
        digest = decision.digest;
        const raw = await backend.signDigest(keyRef, decision.digest);
        // Written before the signature is returned: a signature without its row is never handed out.
        await audit.write({
          at: nowMs(),
          caller,
          keyRef,
          kind,
          digest,
          purpose,
          outcome: "signed",
          ...(decision.spend === undefined ? {} : { spend: decision.spend }),
        });
        return { signature: decision.wrap ? decision.wrap(raw) : raw, digest };
      }
      const signed = await withNonceLock(keyRef, async () => {
        const tx = assignNonce(
          keyRef,
          await options.prepareTransaction(from, {
            to: decision.to,
            data: decision.data,
            value: decision.value,
          }),
        );
        if (
          tx.chainId !== network.chainId ||
          tx.to?.toLowerCase() !== decision.to.toLowerCase() ||
          tx.data !== decision.data ||
          (tx.value ?? 0n) !== decision.value
        )
          throw new Denied("prepared-transaction-mismatch");
        const txDigest = keccak256(serializeTransaction(tx)) as Hash32;
        digest = txDigest;
        decision.checkPrepared?.(tx);
        const signedTransaction = await backend.signTransaction(keyRef, tx);
        lastNonces.set(keyRef, tx.nonce);
        return { signedTransaction, txDigest };
      });
      const { signedTransaction } = signed;
      digest = signed.txDigest;
      try {
        await audit.write({
          at: nowMs(),
          caller,
          keyRef,
          kind,
          digest,
          purpose,
          outcome: "signed",
          ...(decision.rule === undefined ? {} : { rule: decision.rule }),
        });
      } catch (error) {
        // Review M1: the transaction is never returned, so its nonce is handed back for the next request.
        await releaseNonce(keyRef, signedTransaction);
        throw error;
      }
      if (decision.alert !== undefined) {
        const observedAt =
          decision.alert.apiObservedAt === null
            ? "none"
            : new Date(decision.alert.apiObservedAt).toISOString();
        const message =
          `${decision.alert.name} vault=${decision.alert.vault} pocket=${decision.alert.pocket} ` +
          `apiObservedAt=${observedAt} digest=${digest}`;
        let alertDeliveryFailed = options.alert === undefined;
        if (options.alert !== undefined) {
          try {
            await options.alert(message);
          } catch {
            alertDeliveryFailed = true;
          }
        }
        if (alertDeliveryFailed) {
          try {
            logger.error("signer_alert_delivery_failed", { rule: decision.alert.name });
          } catch {
            // The signed audit row is durable even if alert diagnostics fail.
          }
        }
      }
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
    } finally {
      releaseSpend();
    }
  }

  return {
    sign,
    abandonTransaction: releaseNonce,
    async keyAddress(caller, keyRef) {
      if (!mayReadAddress(caller, keyRef)) throw new Denied("key-not-allowed");
      takeKeyAddressRateSlot(caller);
      const address = backend.address(keyRef);
      if (address === undefined) throw new Denied("key-not-allowed");
      return address;
    },
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
    if (!b.gatewayApiFresh) throw new Denied("gateway-balance-stale");
    const zero =
      b.gatewayApi === 0n &&
      b.gatewayAvailable === 0n &&
      b.gatewayWithdrawing === 0n &&
      !b.pendingPullback &&
      view?.slowWithdrawalOpen !== true &&
      (await eoaEmpty(pocket, view?.vault, b));
    if (!zero) throw new Denied("pocket-balance-not-zero");
  }

  /**
   * CZ-27 §5.3 as amended by SCR-152 §2: on Arc the USDC-zero and native-dust checks are one check, the EOA is
   * empty (nothing returnable at the current fee); elsewhere both stay, with `signer.pocketDustAtomic` as the floor.
   */
  async function eoaEmpty(
    pocket: Address,
    vault: Address | undefined,
    b: Awaited<ReturnType<Projection["pocketBalances"]>>,
  ): Promise<boolean> {
    if (!usdcPaysGas(network))
      return b.usdc === 0n && b.native < BigInt(config.get("signer.pocketDustAtomic") as number);
    if (vault === undefined) return b.usdc === 0n;
    return pocketEmpty(ctx, pocket, vault, b.usdc);
  }
}
