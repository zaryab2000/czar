import type { Config } from "@czar/config";
import type { Address } from "@czar/hashing";
import type { Hex } from "viem";
import { NATIVE_PER_USDC_ATOMIC } from "./policy.ts";
import type { SignResult } from "./service.ts";

type RefillKey = "K3" | "K7" | "K8";

export interface GasRefillResult {
  readonly key: RefillKey;
  readonly balance: bigint;
  readonly status: "unchanged" | "refilled" | "failed";
}

export interface GasRefillOptions {
  readonly config: Config;
  readonly signer: {
    sign(
      caller: string,
      request: {
        keyId: string;
        kind: string;
        payload: unknown;
      },
    ): Promise<SignResult>;
  };
  readonly keyAddress: (key: RefillKey) => Address;
  readonly getNativeBalance: (address: Address) => Promise<bigint>;
  readonly submitTransaction: (transaction: Hex) => Promise<void>;
  readonly alert: (message: string) => Promise<void>;
}

const REFILL_KEYS: readonly RefillKey[] = ["K3", "K7", "K8"];
const GAS_REFILL_INTERVAL_MS = 5 * 60_000;

/** Where a key's refill stopped; the only detail an alert carries besides the key id. */
type RefillFault = "key-unavailable" | "balance-read-failed" | "sign-failed" | "send-failed";

/**
 * Refill low-balance signer keys to their configured targets through the relayer policy.
 *
 * Each key is evaluated on its own: a fault on one key is alerted with the key id and fault
 * only, and the pass continues with the remaining keys (SCR-155 §3).
 */
export async function runGasRefill(options: GasRefillOptions): Promise<GasRefillResult[]> {
  const results: GasRefillResult[] = [];
  for (const key of REFILL_KEYS) results.push(await refillKey(options, key));
  return results;
}

async function refillKey(options: GasRefillOptions, key: RefillKey): Promise<GasRefillResult> {
  // Balances are native wei; `signer.gas.*` and the request `amount` stay USDC atomic (A1-05).
  const min = readGasBound(options.config, key, "minAtomic") * NATIVE_PER_USDC_ATOMIC;
  const refillTarget = readGasBound(options.config, key, "targetAtomic") * NATIVE_PER_USDC_ATOMIC;
  const max = readGasBound(options.config, key, "maxAtomic") * NATIVE_PER_USDC_ATOMIC;
  let fault: RefillFault = "key-unavailable";
  let target: Address;
  let balance: bigint;
  try {
    target = options.keyAddress(key);
    fault = "balance-read-failed";
    balance = await options.getNativeBalance(target);
  } catch {
    return refillFailed(options, key, 0n, fault);
  }
  if (balance >= min) return { key, balance, status: "unchanged" };
  const amount = (refillTarget - balance + NATIVE_PER_USDC_ATOMIC - 1n) / NATIVE_PER_USDC_ATOMIC;
  const refilled = balance + amount * NATIVE_PER_USDC_ATOMIC;
  if (amount <= 0n || refilled > max) {
    await options.alert(`Gas refill bounds invalid for ${key}; check signer.gas.${key} config.`);
    return { key, balance, status: "failed" };
  }
  try {
    fault = "sign-failed";
    const signed = await options.signer.sign("relayer", {
      keyId: "relayer",
      kind: "gas-refill",
      payload: { target, amount: amount.toString() },
    });
    if (!("signedTransaction" in signed)) throw new Error("gas-refill policy returned a signature");
    fault = "send-failed";
    await options.submitTransaction(signed.signedTransaction);
  } catch {
    return refillFailed(options, key, balance, fault);
  }
  // A mined refill is the outcome. A balance read after the receipt can race the key's own
  // spending, so it is not used to judge the refill (SCR-155 §3).
  return { key, balance: refilled, status: "refilled" };
}

async function refillFailed(
  options: GasRefillOptions,
  key: RefillKey,
  balance: bigint,
  fault: RefillFault,
): Promise<GasRefillResult> {
  await options.alert(`relayer gas refill failed for ${key}: ${fault}`);
  return { key, balance, status: "failed" };
}

/**
 * Run one refill pass now, then one every five minutes. A pass never starts while another is
 * running; errors go to `onError` and do not stop later passes.
 */
export function startGasRefillJob(
  options: GasRefillOptions,
  onError: (error: unknown) => void,
): () => void {
  let running = false;
  const runPass = () => {
    if (running) return;
    running = true;
    void runGasRefill(options)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(runPass, GAS_REFILL_INTERVAL_MS);
  runPass();
  return () => clearInterval(timer);
}

function readGasBound(
  config: Config,
  key: RefillKey,
  bound: "minAtomic" | "targetAtomic" | "maxAtomic",
) {
  return BigInt(config.get(`signer.gas.${key}.${bound}` as never) as number);
}
