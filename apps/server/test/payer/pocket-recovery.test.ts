import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { createLogger } from "@czar/logging";
import { createPocketRecoveryOperations } from "#src/payer/pocket-recovery";
import * as pullback from "#src/payer/pullback";

const VAULT = "0x0000000000000000000000000000000000000001" as const;
const POCKETS = [
  "0x0000000000000000000000000000000000000002",
  "0x0000000000000000000000000000000000000003",
  "0x0000000000000000000000000000000000000004",
  "0x0000000000000000000000000000000000000005",
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pocket halt discovery", () => {
  it("accepts all projection states and drains only funded pockets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          items: ["Registered", "DelegateReady", "Funded", "Draining"].map((state, index) => ({
            pocket: POCKETS[index],
            vault: VAULT,
            state,
            outstanding: "0",
            pendingPullback: "0",
            envelopeRef: "eip155:5042002:0xvault:1",
          })),
        }),
      ),
    );
    const operations = createPocketRecoveryOperations({
      pool: {} as never,
      config: loadConfig(),
      logger: createLogger({ service: "server", component: "CZ-15", sink: vi.fn() }),
      signer: { sign: vi.fn() },
      publicClient: {} as never,
      walletClient: {} as never,
      safeFetch: vi.fn() as never,
      indexerUrl: "http://127.0.0.1:42069",
      gatewayMinter: "0x0000000000000000000000000000000000000006",
      gatewayDomain: 26,
      now: () => new Date("2026-10-22T00:00:00Z"),
    });

    await expect(operations.halt.listFundedPockets(VAULT)).resolves.toEqual([
      POCKETS[2],
      POCKETS[3],
    ]);
  });

  it("resumes durable closed-pocket rows when the indexer no longer lists them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [] })),
    );
    const durableRow = {
      plan_id: "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
      pocket: POCKETS[0],
      vault_address: VAULT,
      step_index: 7,
      envelope_ref: "eip155:5042002:0xvault:1",
      unavailable_since: new Date("2026-10-21T00:00:00Z"),
      value: "9000",
      attempt: 2,
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM payer_pullback_gateway_failures")) {
        const selectedColumns = sql.slice(sql.indexOf("SELECT") + 6, sql.indexOf("FROM"));
        const selected = selectedColumns.split(",").map((column) => column.trim());
        return {
          rows: [
            Object.fromEntries(
              selected.map((column) => [column, durableRow[column as keyof typeof durableRow]]),
            ),
          ],
        };
      }
      if (sql.includes("FROM plan_pocket_keys"))
        return {
          rows: [
            {
              plan_id: "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
              envelope_ref: "eip155:5042002:0xvault:1",
              vault: VAULT,
              plan: { steps: [{ kind: "gateway-nano", stepIndex: 4 }] },
            },
          ],
        };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const slowPath = vi
      .spyOn(pullback, "executeSlowPullbackFallback")
      .mockResolvedValue({ state: "waiting-return" });
    const operations = createPocketRecoveryOperations({
      pool: { query } as never,
      config: loadConfig(),
      logger: createLogger({ service: "server", component: "CZ-15", sink: vi.fn() }),
      signer: { sign: vi.fn() },
      publicClient: {} as never,
      walletClient: {} as never,
      safeFetch: vi.fn() as never,
      indexerUrl: "http://127.0.0.1:42069",
      gatewayMinter: "0x0000000000000000000000000000000000000006",
      gatewayDomain: 26,
      now: () => new Date("2026-10-22T00:00:00Z"),
    });

    await expect(operations.runClosedPocketRecovery()).resolves.toBe(1);
    expect(slowPath).toHaveBeenCalledWith(
      expect.objectContaining({
        pocket: POCKETS[0],
        vault: VAULT,
        stepIndex: 7,
        attempt: 2,
        trigger: "closed-dust",
      }),
      expect.any(Object),
    );
  });
});
