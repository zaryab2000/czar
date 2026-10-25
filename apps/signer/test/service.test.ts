// Service-level checks: caller identity, key/kind table, rate limits, audit rows, pocket-key retirement.
import { describe, expect, it } from "vitest";
import { paymentRefHash } from "@czar/hashing";
import { h, harness, NETWORK, OTHER, PAYEE, VAULT } from "./helpers.ts";
import { postgresAudit } from "../src/postgres-audit.ts";

const usdc = {
  vault: VAULT,
  reservationId: "12",
  index: "0",
  to: PAYEE,
  value: "100000",
  validBefore: "1760800600",
};

describe("signer service", () => {
  it("refuses a caller that does not own the key, unknown keys and kinds", async () => {
    const t = await harness();
    await expect(
      t.signer.sign("cz-17", { keyId: "K3", kind: "usdc-3009", payload: usdc }),
    ).rejects.toMatchObject({ rule: "caller-not-owner" });
    await expect(
      t.signer.sign("cz-15", { keyId: "K99", kind: "usdc-3009", payload: usdc }),
    ).rejects.toMatchObject({ rule: "unknown-key" });
    await expect(
      t.signer.sign("cz-15", { keyId: "K3", kind: "permit", payload: usdc }),
    ).rejects.toMatchObject({ rule: "unknown-kind" });
    expect(t.calls).toEqual([]);
  });

  it("K6 and K20 never sign through the service API (interactive CLI only, D80)", async () => {
    const t = await harness();
    for (const keyId of ["K6", "K20"]) {
      await expect(
        t.signer.sign("ops", { keyId, kind: "relayer-tx", payload: {} }),
      ).rejects.toMatchObject({ rule: "interactive-only" });
    }
  });

  it("enforces kms.maxSignaturesPerMin per key and recovers after the window", async () => {
    const t = await harness({ config: { "kms.maxSignaturesPerMin.K3": 2 } });
    await t.signer.sign("cz-15", { keyId: "K3", kind: "usdc-3009", payload: usdc });
    await t.signer.sign("cz-15", {
      keyId: "K3",
      kind: "usdc-3009",
      payload: { ...usdc, index: "1" },
    });
    await expect(
      t.signer.sign("cz-15", { keyId: "K3", kind: "usdc-3009", payload: { ...usdc, index: "2" } }),
    ).rejects.toMatchObject({ rule: "rate-limit" });
    expect(t.calls).toHaveLength(2);
    t.advance(60_000);
    t.state.observedAt += 60;
    await t.signer.sign("cz-15", {
      keyId: "K3",
      kind: "usdc-3009",
      payload: { ...usdc, index: "2" },
    });
  });

  it("writes one audit row per request with ids and digests only, no raw text", async () => {
    const t = await harness();
    const origin = "https://merchant.example/very-private-path?q=secret-query";
    const paymentRef = {
      schemaVersion: "1.0",
      rail: "x402-exact",
      network: "eip155:5042002",
      asset: NETWORK.usdc,
      payer: VAULT,
      payTo: PAYEE,
      amount: "100000",
      nonce: h("1"),
      validBefore: 1760800600,
    } as const;
    const receipt = {
      paymentRefHash: paymentRefHash(paymentRef),
      requestCommit: h("4"),
      responseCommit: h("5"),
      statusCode: "200",
      originAsserted: origin,
      requirementsHashSeen: h("6"),
      tRequest: "1",
      tPaymentSigned: "2",
      tComplete: "3",
      outcome: "0",
      localChecksCommit: h("0"),
      disclosure: "2",
      createdAt: "4",
    };
    t.state.settled.add(receipt.paymentRefHash);
    await t.signer.sign("cz-15", {
      keyId: "K3",
      kind: "sl-receipt",
      payload: { vault: VAULT, receipt, paymentRef },
    });
    await t.signer.sign("cz-15", { keyId: "K3", kind: "usdc-3009", payload: usdc });
    await t.signer
      .sign("cz-15", {
        keyId: "K3",
        kind: "usdc-3009",
        payload: { ...usdc, to: "0x000000000000000000000000000000000000dead" },
      })
      .catch(() => undefined);
    expect(t.audit.rows.map((row) => row.outcome)).toEqual(["signed", "signed", "kms_denied"]);
    expect(t.audit.rows[1]).toMatchObject({
      keyRef: "K3",
      kind: "usdc-3009",
      purpose: { reservationId: "12" },
      caller: "cz-15",
    });
    const text = JSON.stringify(t.audit.rows, (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(text).not.toContain("merchant.example");
    expect(text).not.toContain("secret-query");
    expect(text).not.toContain(PAYEE.slice(2));
    for (const row of t.audit.rows)
      expect(Object.keys(row).toSorted()).toEqual(
        expect.arrayContaining(["at", "caller", "keyRef", "kind", "outcome", "purpose"]),
      );
  });

  it("writes a denied selector to PostgreSQL audit before any backend sign call", async () => {
    let query: { sql: string; values: unknown[] } | undefined;
    const t = await harness({
      auditSink: postgresAudit({
        async query(sql, values) {
          query = { sql, values };
        },
      }),
    });

    await expect(
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "vault-call",
        payload: { vault: VAULT, selector: "approve", args: { spender: OTHER, value: "1" } },
      }),
    ).rejects.toMatchObject({ rule: "selector-not-allowed" });

    expect(t.calls).toEqual([]);
    expect(query?.sql).toContain("INSERT INTO audit");
    expect(query?.values[3]).toBe("kms_denied");
    expect(JSON.parse(query?.values[2] as string)[0]).toMatchObject({
      keyRef: "K3",
      rule: "selector-not-allowed",
    });
  });

  it("refuses a prepared transaction that differs from the policy's call", async () => {
    const t = await harness();
    const signer = t.signer;
    // A tampering preparer would change the target; the service compares before signing.
    const original = t.prepared.push.bind(t.prepared);
    t.prepared.push = (tx) => {
      (tx as { to: string }).to = "0x000000000000000000000000000000000000dead";
      return original(tx);
    };
    await expect(
      signer.sign("cz-17", {
        keyId: "K8",
        kind: "oel-commit",
        payload: { kind: "0", root: h("7"), prev: h("0"), uriHash: h("1"), uri: "x" },
      }),
    ).rejects.toMatchObject({ name: "Denied" });
  });
});

describe("public key address lookup (SCR-129)", () => {
  it("allows only the caller-to-key pairs and excludes pocket keys", async () => {
    const t = await harness();
    expect(await t.signer.keyAddress("cz-15", "K3")).toBe(t.address("K3"));
    expect(await t.signer.keyAddress("cz-16", "K7")).toBe(t.address("K7"));
    expect(await t.signer.keyAddress("cz-17", "K8")).toBe(t.address("K8"));
    expect(await t.signer.keyAddress("cz-24", "K5")).toBe(t.address("K5"));
    expect(await t.signer.keyAddress("cz-20", "K10:czar-search")).toBe(
      t.address("K10:czar-search"),
    );
    const refused: [string, string][] = [
      ["cz-20", "K3"],
      ["cz-15", `K4:${t.pocket}`],
      ["cz-15", "K10:czar-search"],
      ["cz-20", "K10:unknown-service"],
      ["cz-16", "K7:extra"],
    ];
    for (const [caller, keyRef] of refused) {
      await expect(t.signer.keyAddress(caller, keyRef)).rejects.toMatchObject({
        rule: "key-not-allowed",
      });
    }
    expect(t.audit.rows).toEqual([]);
  });

  it("rate-limits address reads per caller without signing audit rows", async () => {
    const t = await harness({ config: { "signer.keyAddressPerMin": 1 } });
    const address = t.address("K10:czar-search");
    expect(await t.signer.keyAddress("cz-20", "K10:czar-search")).toBe(address);
    await expect(t.signer.keyAddress("cz-20", "K10:czar-search")).rejects.toMatchObject({
      rule: "rate-limit",
    });
    expect(t.audit.rows).toEqual([]);
  });
});

describe("pocket keys (K4, RV-004)", () => {
  it("creates a pocket key for CZ-15 only", async () => {
    const t = await harness();
    const pocket = await t.signer.createPocketKey("cz-15");
    expect(t.backend.address(`K4:${pocket}`)).toBe(pocket);
    await expect(t.signer.createPocketKey("cz-16")).rejects.toMatchObject({
      rule: "caller-not-owner",
    });
  });

  it("signer_retirePocketKey_nonZeroBalance_refused", async () => {
    const t = await harness();
    const cases = [
      { gatewayApi: 1n },
      { gatewayAvailable: 1n },
      { gatewayWithdrawing: 1n },
      { usdc: 1n },
      { native: 500n },
      { pendingPullback: true },
    ];
    for (const change of cases) {
      t.state.balances = {
        gatewayApi: 0n,
        gatewayAvailable: 0n,
        gatewayWithdrawing: 0n,
        usdc: 0n,
        native: 0n,
        pendingPullback: false,
        ...change,
      };
      await expect(t.signer.retirePocketKey("cz-15", t.pocket)).rejects.toMatchObject({
        rule: "pocket-balance-not-zero",
      });
    }
    t.state.balances = {
      gatewayApi: 0n,
      gatewayAvailable: 0n,
      gatewayWithdrawing: 0n,
      usdc: 0n,
      native: 499n,
      pendingPullback: false,
    };
    t.state.pocket = {
      ...(t.state.pocket as NonNullable<typeof t.state.pocket>),
      slowWithdrawalOpen: true,
    };
    await expect(t.signer.retirePocketKey("cz-15", t.pocket)).rejects.toMatchObject({
      rule: "pocket-balance-not-zero",
    });
  });

  it("destroys a zero-balance pocket key only after signer.pocketKeyRetainHours", async () => {
    const t = await harness();
    const { destroyAfterMs } = await t.signer.retirePocketKey("cz-15", t.pocket);
    expect(await t.signer.destroyRetiredPocketKeys()).toEqual([]);
    t.advance(24 * 3_600_000);
    expect(destroyAfterMs).toBeGreaterThan(0);
    expect(await t.signer.destroyRetiredPocketKeys()).toEqual([t.pocket]);
    expect(t.backend.address(`K4:${t.pocket}`)).toBeUndefined();
  });

  it("refuses pocket-key signing as soon as retirement begins", async () => {
    const t = await harness();
    await t.signer.retirePocketKey("cz-15", t.pocket);
    await expect(
      t.signer.sign("cz-15", {
        keyId: "K4",
        kind: "gateway-nano",
        payload: {
          pocket: t.pocket,
          payTo: PAYEE,
          amount: "1",
          nonce: `0x${"00".repeat(32)}`,
          validBefore: "1760800600",
        },
      }),
    ).rejects.toMatchObject({ rule: "pocket-key-retiring" });
    expect(t.calls).toEqual([]);
    expect(t.audit.rows.at(-1)?.outcome).toBe("kms_denied");
  });

  it("keeps the key when a balance reappears during the retain window", async () => {
    const t = await harness();
    await t.signer.retirePocketKey("cz-15", t.pocket);
    t.state.balances = { ...t.state.balances, usdc: 5n };
    t.advance(24 * 3_600_000);
    expect(await t.signer.destroyRetiredPocketKeys()).toEqual([]);
    expect(t.backend.address(`K4:${t.pocket}`)).toBe(t.pocket);
  });
});
