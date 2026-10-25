import { describe, expect, it, vi } from "vitest";
import {
  amount6FromDecimal,
  advanceGatewayApiFailures,
  classifyBalanceFailure,
  isClosedPocketQuiet,
  isPocketStale,
  pollPocketBalance,
  type PocketBalanceRow,
} from "#src/gateway-balances";

const pocket = "0x00000000000000000000000000000000000000e1" as const;
const vault = "0x00000000000000000000000000000000000000e2" as const;

function memoryStore(initial: PocketBalanceRow | null = null) {
  let current = initial;
  return {
    async find() {
      return current;
    },
    async save(row: PocketBalanceRow) {
      current = { ...row };
    },
    current: () => current,
  };
}

describe("Gateway balance projection rules", () => {
  it("alerts only for Funded or Draining pockets closed beyond the stale period", () => {
    const now = Date.parse("2026-10-25T12:00:00.000Z");
    const staleMs = 24 * 60 * 60 * 1000;
    const condition = {
      envelopeState: "Closed",
      envelopeClosedAt: now - staleMs - 1,
      now,
      staleMs,
    };

    expect(isPocketStale({ ...condition, pocketState: "Funded" })).toBe(true);
    expect(isPocketStale({ ...condition, pocketState: "Draining" })).toBe(true);
    expect(isPocketStale({ ...condition, pocketState: "Registered" })).toBe(false);
    expect(isPocketStale({ ...condition, pocketState: "Closed" })).toBe(false);
    expect(isPocketStale({ ...condition, envelopeState: "Closing", pocketState: "Draining" })).toBe(
      false,
    );
    expect(
      isPocketStale({ ...condition, envelopeClosedAt: now - staleMs, pocketState: "Funded" }),
    ).toBe(false);
    expect(isPocketStale({ ...condition, envelopeClosedAt: null, pocketState: "Funded" })).toBe(
      false,
    );
  });

  it("counts consecutive Gateway API failures and resets on each successful API request", () => {
    expect(
      advanceGatewayApiFailures(8, [
        { apiError: true, chainError: true },
        { apiError: true, chainError: false },
      ]),
    ).toBe(10);
    expect(
      advanceGatewayApiFailures(10, [
        { apiError: false, chainError: true },
        { apiError: true, chainError: false },
      ]),
    ).toBe(1);
    expect(advanceGatewayApiFailures(4, [{ apiError: false, chainError: true }])).toBe(0);
  });

  it.each([
    ["0", 0n],
    ["1.2", 1_200_000n],
    ["0.000001", 1n],
    ["123456789.123456", 123456789123456n],
  ])("converts exact decimal %s to Amount6", (input, expected) => {
    expect(amount6FromDecimal(input)).toBe(expected);
  });

  it.each(["", ".1", "01.2", "1.", "1.0000001", "-1", "1e-6", " 1"])(
    "rejects malformed decimal %s without rounding",
    (input) => expect(() => amount6FromDecimal(input)).toThrow(),
  );

  it.each([
    ["TimeoutError", "timeout"],
    ["HTTP 404", "http-4xx"],
    ["HTTP 503", "http-5xx"],
    ["Malformed Gateway balance response", "malformed"],
    ["socket hang up", "network"],
  ])("classifies a Gateway poll failure", (message, expected) => {
    expect(classifyBalanceFailure(new Error(message))).toBe(expected);
  });

  it("keeps a Closed pocket in scope until every balance is zero for the quiet period", () => {
    const now = Date.parse("2026-10-25T12:00:00.000Z");
    const quietMs = 48 * 60 * 60 * 1000;
    expect(
      isClosedPocketQuiet({
        now,
        quietMs,
        zeroSince: new Date(now - quietMs + 1).toISOString(),
        gatewayAvailable: 0n,
        gatewayWithdrawing: 0n,
        usdc: 0n,
      }),
    ).toBe(false);
    expect(
      isClosedPocketQuiet({
        now,
        quietMs,
        zeroSince: new Date(now - quietMs).toISOString(),
        gatewayAvailable: 0n,
        gatewayWithdrawing: 0n,
        usdc: 0n,
      }),
    ).toBe(true);
    expect(
      isClosedPocketQuiet({
        now,
        quietMs,
        zeroSince: new Date(now - quietMs).toISOString(),
        gatewayAvailable: 0n,
        gatewayWithdrawing: 1n,
        usdc: 0n,
      }),
    ).toBe(false);
  });

  it("polls an exact pocket balance and reads withdrawal state at one chain block", async () => {
    const store = memoryStore();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "USDC",
          balances: [{ domain: 26, depositor: pocket, balance: "0.001000", pendingBatch: "0" }],
        }),
        { status: 200 },
      ),
    );
    const readContract = vi.fn(
      async ({ functionName }: { functionName: string; blockNumber?: bigint }) =>
        functionName === "withdrawingBalance" ? 0n : 12n,
    );
    const now = Date.parse("2026-10-25T12:00:00.000Z");

    const result = await pollPocketBalance(
      {
        pocket,
        vault,
        state: "Closed",
        domain: 26,
        gatewayWallet: vault,
        usdc: vault,
        apiBase: "http://127.0.0.1:4999",
        timeoutMs: 1000,
        quietMs: 48 * 60 * 60 * 1000,
      },
      {
        fetch: fetcher,
        chain: { getBlockNumber: async () => 123n, readContract } as never,
        store,
        now: () => now,
      },
    );

    expect(result).toMatchObject({ apiError: false, chainError: false });
    expect(store.current()).toMatchObject({
      gatewayAvailableAtomic: "1000",
      gatewayPendingBatchAtomic: "0",
      gatewayWithdrawingAtomic: "0",
      withdrawalBlock: 12n,
      pocketUsdcAtomic: "12",
      apiObservedAt: new Date(now).toISOString(),
      chainObservedBlock: 123n,
      closedZeroSince: null,
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      token: "USDC",
      balances: [{ domain: 26, depositor: pocket }],
    });
    expect(readContract).toHaveBeenCalledTimes(3);
    expect(readContract.mock.calls.every((call) => call[0].blockNumber === 123n)).toBe(true);
  });

  it("retains last good API figures and restarts Closed quiet time after a malformed poll", async () => {
    const previous: PocketBalanceRow = {
      pocket,
      vault,
      gatewayAvailableAtomic: "0",
      gatewayPendingBatchAtomic: "0",
      gatewayWithdrawingAtomic: "0",
      withdrawalBlock: 0n,
      pocketUsdcAtomic: "0",
      apiObservedAt: "2026-10-24T12:00:00.000Z",
      chainObservedBlock: 100n,
      apiConsecutiveFailures: 0,
      apiLastError: null,
      closedZeroSince: "2026-10-24T12:00:00.000Z",
    };
    const store = memoryStore(previous);
    const result = await pollPocketBalance(
      {
        pocket,
        vault,
        state: "Closed",
        domain: 26,
        gatewayWallet: vault,
        usdc: vault,
        apiBase: "http://127.0.0.1:4999",
        timeoutMs: 1000,
        quietMs: 48 * 60 * 60 * 1000,
      },
      {
        fetch: vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({ balances: [] }), { status: 200 })),
        chain: { getBlockNumber: async () => 123n, readContract: async () => 0n } as never,
        store,
        now: () => Date.parse("2026-10-25T12:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({ apiError: true, chainError: false });
    expect(store.current()).toMatchObject({
      gatewayAvailableAtomic: "0",
      apiObservedAt: "2026-10-24T12:00:00.000Z",
      apiConsecutiveFailures: 1,
      apiLastError: "malformed",
      closedZeroSince: null,
    });
  });
});
