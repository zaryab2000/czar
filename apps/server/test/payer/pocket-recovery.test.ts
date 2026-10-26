import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { createLogger } from "@czar/logging";
import { createPocketRecoveryOperations } from "#src/payer/pocket-recovery";

const VAULT = "0x0000000000000000000000000000000000000001" as const;
const POCKETS = [
  "0x0000000000000000000000000000000000000002",
  "0x0000000000000000000000000000000000000003",
  "0x0000000000000000000000000000000000000004",
  "0x0000000000000000000000000000000000000005",
] as const;

afterEach(() => vi.unstubAllGlobals());

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
});
