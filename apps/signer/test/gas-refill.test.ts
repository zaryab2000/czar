import { describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { runGasRefill } from "../src/gas-refill.ts";

const addresses = {
  K3: "0x0000000000000000000000000000000000000003",
  K7: "0x0000000000000000000000000000000000000007",
  K8: "0x0000000000000000000000000000000000000008",
} as const;
const relayer = "0x00000000000000000000000000000000000000aa";

describe("gas refill job", () => {
  it("gasRefill_keepsK3K7K8WithinBounds", async () => {
    const balances = new Map<string, bigint>([
      [addresses.K3, 499_999n],
      [addresses.K7, 99_999n],
      [addresses.K8, 500_000n],
      [relayer, 10_000_000n],
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
        balances.set(address, (balances.get(address) ?? 0n) + BigInt(request.amount));
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
      ["K3", 2_000_000n],
      ["K7", 500_000n],
      ["K8", 500_000n],
    ]);
    expect(alerts).toEqual([]);
    for (const key of ["K3", "K7", "K8"] as const) {
      expect(balances.get(addresses[key])).toBeLessThanOrEqual(
        BigInt(loadConfig().get(`signer.gas.${key}.maxAtomic` as never) as number),
      );
    }
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
