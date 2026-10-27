import type { Config } from "@czar/config";
import type { Address } from "@czar/hashing";
import type { Hex } from "viem";
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

/** Refill low-balance signer keys to their configured targets through the relayer policy. */
export async function runGasRefill(options: GasRefillOptions): Promise<GasRefillResult[]> {
  const results: GasRefillResult[] = [];
  for (const key of REFILL_KEYS) {
    const target = options.keyAddress(key);
    const balance = await options.getNativeBalance(target);
    const min = readGasBound(options.config, key, "minAtomic");
    const refillTarget = readGasBound(options.config, key, "targetAtomic");
    const max = readGasBound(options.config, key, "maxAtomic");
    if (balance >= min) {
      results.push({ key, balance, status: "unchanged" });
      continue;
    }
    const amount = refillTarget - balance;
    if (amount <= 0n || balance + amount > max) {
      await options.alert(`Gas refill bounds invalid for ${key}; check signer.gas.${key} config.`);
      results.push({ key, balance, status: "failed" });
      continue;
    }
    try {
      const signed = await options.signer.sign("relayer", {
        keyId: "relayer",
        kind: "gas-refill",
        payload: { target, amount: amount.toString() },
      });
      if (!("signedTransaction" in signed))
        throw new Error("gas-refill policy returned a signature");
      const { signedTransaction } = signed;
      await options.submitTransaction(signedTransaction);
      const updatedBalance = await options.getNativeBalance(target);
      if (updatedBalance > max || updatedBalance < refillTarget) {
        throw new Error(`refill left ${key} outside its target and max bounds`);
      }
      results.push({ key, balance: updatedBalance, status: "refilled" });
    } catch (error) {
      await options.alert(`relayer gas refill failed for ${key}: ${errorMessage(error)}`);
      results.push({ key, balance, status: "failed" });
      break;
    }
  }
  return results;
}

/** Start the five-minute refill loop; errors are alerted and do not stop later runs. */
export function startGasRefillJob(
  options: GasRefillOptions,
  onError: (error: unknown) => void,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runGasRefill(options)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, GAS_REFILL_INTERVAL_MS);
  return () => clearInterval(timer);
}

function readGasBound(
  config: Config,
  key: RefillKey,
  bound: "minAtomic" | "targetAtomic" | "maxAtomic",
) {
  return BigInt(config.get(`signer.gas.${key}.${bound}` as never) as number);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
