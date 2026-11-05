// MR-04 / SCR-182 §7: with the audit merchants' catalog entries from env/local.toml, the registered
// selection probes both and lists both as candidates for code-review. The probes are answered by a fake
// safeFetch with each merchant's 402 offer; nothing leaves the process.
import { loadConfig, loadConfigFile } from "@czar/config";
import { buildPaymentRequired, encodePaymentRequired, type SafeFetch } from "@czar/x402";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RankingQuery } from "#src/planner/ports";
import { createRegisteredSelection } from "#src/selection/registered/index";
import { setupDatabase } from "#test/db";

const getPool = setupDatabase();
const NETWORK = "eip155:5042002";
const QUICK = "svc_501b04bc66f639fd43f4218ede41ad54";
const DEEP = "svc_719288df4c0c19c37f00c98d30dc3d28";
const PRICES: Record<string, string> = { "/v1/audit/quick": "500000", "/v1/audit/deep": "1000000" };

interface Registration {
  readonly serviceName: string;
}

const auditQuery: RankingQuery = {
  taskClass: "smart-contract-audit",
  capability: "code-review",
  taskSpec: {
    kind: "list-fill",
    topic: "Smart contract audit",
    fields: [],
    output: { format: "json", formatSource: "default" },
  },
  networks: [NETWORK],
  rails: ["x402-exact", "gateway-batched", "erc8183-job"],
  max_price_atomic: "1000000",
  unknown_policy: "exclude",
};

/** Each audit merchant's live 402 for an unpaid probe with a `{contract}` body. */
const fakeProbe = vi.fn<SafeFetch>(async (url, options) => {
  const { pathname } = new URL(url);
  const amount = PRICES[pathname];
  const body = new TextDecoder().decode(options?.body ?? new Uint8Array());
  if (options?.method !== "POST" || amount === undefined || !body.includes('"contract"'))
    return { status: 404, url, headers: {}, body: new Uint8Array() };
  const paymentRequired = buildPaymentRequired({
    url,
    description: "Smart contract review. Run by Czar.",
    serviceName: pathname.endsWith("quick") ? "czar-audit-quick" : "czar-audit-deep",
    tags: ["audit", "code-review"],
    network: NETWORK,
    amount,
    payTo: "0x00000000000000000000000000000000000000A4",
    maxTimeoutSeconds: 300,
  });
  return {
    status: 402,
    url,
    headers: { "payment-required": encodePaymentRequired(paymentRequired) },
    body: new Uint8Array(),
  };
});

beforeEach(async () => {
  await getPool().query("DELETE FROM selection_interim_snapshots");
  fakeProbe.mockClear();
});

describe("audit merchants in the registered selection (SCR-182 §7)", () => {
  it("lists both env/local.toml audit entries as code-review candidates, cheapest first, none excluded", async () => {
    const local = await loadConfigFile(new URL("../../../../env/local.toml", import.meta.url));
    const registered = local.get("selection.czarRegisteredServices") as Record<
      string,
      Registration
    >;
    const audits = Object.fromEntries(
      Object.entries(registered).filter(([, entry]) => entry.serviceName.startsWith("czar-audit-")),
    );
    expect(Object.keys(audits).toSorted()).toEqual([QUICK, DEEP].toSorted());

    const selection = createRegisteredSelection({
      config: loadConfig({ envFile: { "selection.czarRegisteredServices": audits } }),
      safeFetch: fakeProbe,
      pool: getPool(),
      now: () => new Date("2026-11-05T14:00:00Z"),
    });
    const decision = await selection.rank.rank(auditQuery);

    expect(fakeProbe).toHaveBeenCalledTimes(2);
    expect(decision.excluded).toEqual([]);
    // No receipts yet: both are unverified candidates and the cheaper one takes the exploration slot.
    expect(decision.ranked).toEqual([]);
    expect(decision.unverified.map((row) => row.service_id).toSorted()).toEqual(
      [QUICK, DEEP].toSorted(),
    );
    expect(decision.exploration_slot?.service_id).toBe(QUICK);
  });
});
