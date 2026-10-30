import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTransaction, type Hex } from "viem";
import { loadConfig } from "@czar/config";
import type { Address } from "@czar/hashing";
import { runGasRefill, startGasRefillJob, type GasRefillOptions } from "../src/gas-refill.ts";
import { harness } from "./helpers.ts";

const addresses = {
  K3: "0x0000000000000000000000000000000000000003",
  K7: "0x0000000000000000000000000000000000000007",
  K8: "0x0000000000000000000000000000000000000008",
} as const;
const relayer = "0x00000000000000000000000000000000000000aa";
/** Arc native balances are 18-decimal wei; `signer.gas.*` and the payload are USDC 6-decimal atomic. */
const WEI_PER_ATOMIC = 10n ** 12n;
const usdcWei = (atomic: bigint) => atomic * WEI_PER_ATOMIC;
const gasBound = (key: "K3" | "K7" | "K8", bound: "minAtomic" | "targetAtomic" | "maxAtomic") =>
  BigInt(loadConfig().get(`signer.gas.${key}.${bound}` as never) as number);

async function refillThroughPolicy(native: Readonly<Record<"K3" | "K7" | "K8", bigint>>) {
  const t = await harness();
  for (const key of ["K3", "K7", "K8"] as const)
    t.state.native.set(t.address(key).toLowerCase(), native[key]);
  const values: { to: string; value: bigint }[] = [];
  const alerts: string[] = [];
  const results = await runGasRefill({
    config: loadConfig(),
    signer: t.signer,
    keyAddress: (key) => t.address(key),
    getNativeBalance: async (address) => t.state.native.get(address.toLowerCase()) ?? 0n,
    submitTransaction: async (transaction: Hex) => {
      const tx = parseTransaction(transaction);
      const to = (tx.to ?? "").toLowerCase();
      const value = tx.value ?? 0n;
      values.push({ to, value });
      t.state.native.set(to, (t.state.native.get(to) ?? 0n) + value);
    },
    alert: async (message) => {
      alerts.push(message);
    },
  });
  return { t, values, alerts, results };
}

describe("gas refill job", () => {
  it("gasRefill_keepsK3K7K8WithinBounds", async () => {
    const balances = new Map<string, bigint>([
      [addresses.K3, usdcWei(499_999n)],
      [addresses.K7, usdcWei(99_999n)],
      [addresses.K8, usdcWei(500_000n)],
      [relayer, usdcWei(10_000_000n)],
    ]);
    const requests: { target: string; amount: string }[] = [];
    const alerts: string[] = [];
    const results = await runGasRefill({
      config: loadConfig(),
      signer: {
        async sign(_caller, request) {
          requests.push(request.payload as { target: string; amount: string });
          return { signedTransaction: "0x01" };
        },
      },
      keyAddress: (key) => addresses[key],
      getNativeBalance: async (address) => balances.get(address.toLowerCase()) ?? 0n,
      submitTransaction: async () => {
        const request = requests.at(-1);
        if (!request) throw new Error("missing gas refill request");
        const address = request.target.toLowerCase();
        balances.set(address, (balances.get(address) ?? 0n) + usdcWei(BigInt(request.amount)));
      },
      alert: async (message) => {
        alerts.push(message);
      },
    });

    expect(requests).toEqual([
      { target: addresses.K3, amount: "1500001" },
      { target: addresses.K7, amount: "400001" },
    ]);
    expect(results.map(({ key, balance }) => [key, balance])).toEqual([
      ["K3", usdcWei(2_000_000n)],
      ["K7", usdcWei(500_000n)],
      ["K8", usdcWei(500_000n)],
    ]);
    expect(alerts).toEqual([]);
    for (const key of ["K3", "K7", "K8"] as const) {
      expect(balances.get(addresses[key])).toBeLessThanOrEqual(usdcWei(gasBound(key, "maxAtomic")));
    }
  });

  it("refills K3 from 0.4 USDC to 2 USDC with a signed value of 1.6 USDC in wei", async () => {
    const { t, values, alerts, results } = await refillThroughPolicy({
      K3: usdcWei(400_000n),
      K7: usdcWei(gasBound("K7", "minAtomic")),
      K8: usdcWei(gasBound("K8", "minAtomic")),
    });

    expect(values).toEqual([{ to: t.address("K3").toLowerCase(), value: usdcWei(1_600_000n) }]);
    expect(results.map(({ key, status }) => [key, status])).toEqual([
      ["K3", "refilled"],
      ["K7", "unchanged"],
      ["K8", "unchanged"],
    ]);
    expect(t.state.native.get(t.address("K3").toLowerCase())).toBe(
      usdcWei(gasBound("K3", "targetAtomic")),
    );
    expect(alerts).toEqual([]);
  });

  it("leaves a key at or above minAtomic in wei unchanged and refills one wei below it", async () => {
    const min = usdcWei(gasBound("K3", "minAtomic"));
    const atMin = await refillThroughPolicy({ K3: min, K7: min, K8: min });
    expect(atMin.values).toEqual([]);
    expect(atMin.results.map(({ status }) => status)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);

    const below = await refillThroughPolicy({ K3: min - 1n, K7: min, K8: min });
    const refilled = below.t.state.native.get(below.t.address("K3").toLowerCase()) ?? 0n;
    expect(below.results[0]).toMatchObject({ key: "K3", status: "refilled" });
    expect(refilled).toBeGreaterThanOrEqual(usdcWei(gasBound("K3", "targetAtomic")));
    expect(refilled).toBeLessThanOrEqual(usdcWei(gasBound("K3", "maxAtomic")));
  });

  it("alerts instead of refilling when target exceeds max in wei terms", async () => {
    const config = loadConfig({
      envFile: { "signer.gas.K3.targetAtomic": 2_000_000, "signer.gas.K3.maxAtomic": 1_999_999 },
    });
    const requests: unknown[] = [];
    const alerts: string[] = [];
    const results = await runGasRefill({
      config,
      signer: {
        async sign(_caller, request) {
          requests.push(request.payload);
          return { signedTransaction: "0x01" };
        },
      },
      keyAddress: (key) => addresses[key],
      getNativeBalance: async (address) =>
        address === addresses.K3 ? usdcWei(400_000n) : usdcWei(1_000_000n),
      submitTransaction: async () => undefined,
      alert: async (message) => {
        alerts.push(message);
      },
    });

    expect(requests).toEqual([]);
    expect(results[0]).toMatchObject({ key: "K3", status: "failed" });
    expect(alerts).toEqual([expect.stringContaining("signer.gas.K3")]);
  });

  it("alerts when the relayer cannot submit a refill", async () => {
    const alerts: string[] = [];
    const results = await runGasRefill({
      config: loadConfig(),
      signer: {
        async sign() {
          return { signedTransaction: "0x01" };
        },
      },
      keyAddress: (key) => addresses[key],
      getNativeBalance: async (address) => (address === addresses.K3 ? 1n : 0n),
      submitTransaction: async () => {
        throw new Error("insufficient funds for gas * price + value");
      },
      alert: async (message) => {
        alerts.push(message);
      },
    });

    expect(results[0]).toMatchObject({ key: "K3", status: "failed" });
    expect(alerts).toEqual([expect.stringContaining("relayer")]);
  });
});

/** In-memory chain for the refill pass: each submitted refill credits its target. */
function fakeRefillChain(native: Partial<Record<"K3" | "K7" | "K8", bigint>>) {
  const balances = new Map<string, bigint>(
    (["K3", "K7", "K8"] as const).map((key) => [addresses[key], native[key] ?? 0n]),
  );
  const requests: { target: string; amount: string }[] = [];
  const alerts: string[] = [];
  const options: GasRefillOptions = {
    config: loadConfig(),
    signer: {
      async sign(_caller, request) {
        requests.push(request.payload as { target: string; amount: string });
        return { signedTransaction: "0x01" };
      },
    },
    keyAddress: (key) => addresses[key],
    getNativeBalance: async (address: Address) => balances.get(address.toLowerCase()) ?? 0n,
    submitTransaction: async () => {
      const request = requests.at(-1);
      if (!request) throw new Error("missing gas refill request");
      const address = request.target.toLowerCase();
      balances.set(address, (balances.get(address) ?? 0n) + usdcWei(BigInt(request.amount)));
    },
    alert: async (message) => {
      alerts.push(message);
    },
  };
  return { balances, requests, alerts, options };
}

const atTarget = (key: "K3" | "K7" | "K8") => usdcWei(gasBound(key, "targetAtomic"));

describe("gas refill per key (SCR-155 §3)", () => {
  it("still refills the second key when the first key's balance read throws", async () => {
    const chain = fakeRefillChain({ K3: atTarget("K3"), K7: 0n, K8: atTarget("K8") });
    const read = chain.options.getNativeBalance;
    const results = await runGasRefill({
      ...chain.options,
      getNativeBalance: async (address) => {
        if (address === addresses.K3) throw new Error(`rpc read failed for ${address}`);
        return read(address);
      },
    });

    expect(results.map(({ key, status }) => [key, status])).toEqual([
      ["K3", "failed"],
      ["K7", "refilled"],
      ["K8", "unchanged"],
    ]);
    expect(chain.balances.get(addresses.K7)).toBe(atTarget("K7"));
    expect(chain.alerts).toEqual(["relayer gas refill failed for K3: balance-read-failed"]);
  });

  it("still refills the second key when the first key's send fails", async () => {
    const chain = fakeRefillChain({ K3: 0n, K7: 0n, K8: atTarget("K8") });
    const submit = chain.options.submitTransaction;
    const results = await runGasRefill({
      ...chain.options,
      submitTransaction: async (transaction) => {
        if (chain.requests.at(-1)?.target === addresses.K3)
          throw new Error(`insufficient funds for ${relayer} at https://rpc.example/?key=secret`);
        await submit(transaction);
      },
    });

    expect(results.map(({ key, status }) => [key, status])).toEqual([
      ["K3", "failed"],
      ["K7", "refilled"],
      ["K8", "unchanged"],
    ]);
    expect(chain.balances.get(addresses.K7)).toBe(atTarget("K7"));
    expect(chain.alerts).toEqual(["relayer gas refill failed for K3: send-failed"]);
  });

  it("counts a mined refill as refilled even if the key spends gas before the next read", async () => {
    const chain = fakeRefillChain({ K3: 0n, K7: atTarget("K7"), K8: atTarget("K8") });
    const submit = chain.options.submitTransaction;
    const results = await runGasRefill({
      ...chain.options,
      submitTransaction: async (transaction) => {
        await submit(transaction);
        const k3 = chain.balances.get(addresses.K3) ?? 0n;
        chain.balances.set(addresses.K3, k3 - usdcWei(5_000n));
      },
    });

    expect(results.map(({ key, status }) => [key, status])).toEqual([
      ["K3", "refilled"],
      ["K7", "unchanged"],
      ["K8", "unchanged"],
    ]);
    expect(chain.alerts).toEqual([]);
  });
});

describe("gas refill job start (SCR-155 §3)", () => {
  afterEach(() => vi.useRealTimers());

  it("refills a key with no gas in its first pass, before the interval elapses", async () => {
    vi.useFakeTimers();
    const chain = fakeRefillChain({ K3: 0n, K7: atTarget("K7"), K8: atTarget("K8") });
    const stop = startGasRefillJob(chain.options, () => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(chain.balances.get(addresses.K3)).toBe(atTarget("K3"));
      expect(chain.requests).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("runs again on the five-minute interval and never overlaps passes", async () => {
    vi.useFakeTimers();
    const chain = fakeRefillChain({ K3: atTarget("K3"), K7: atTarget("K7"), K8: atTarget("K8") });
    let passes = 0;
    let release: () => void = () => undefined;
    const read = chain.options.getNativeBalance;
    const stop = startGasRefillJob(
      {
        ...chain.options,
        getNativeBalance: async (address) => {
          if (address === addresses.K3) {
            passes += 1;
            if (passes === 1) await new Promise<void>((resolve) => (release = resolve));
          }
          return read(address);
        },
      },
      () => undefined,
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(passes).toBe(1);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(passes).toBe(1);
      release();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(passes).toBe(2);
    } finally {
      stop();
    }
  });
});
