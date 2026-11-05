// SCR-180 acceptance (§5): the signer counts what it has signed that the indexer has not seen yet.
// Spent = indexed + pending; pending = this signer's `signed` rows whose payment is not indexed and whose
// `validBefore` is still ahead. Read pending, check and record run one at a time per pocket (gateway-nano)
// and per vault (usdc-3009 and the expected-calls check). `service-kms.test.ts` re-runs this file on the
// Cloud KMS backend (§5 test 6).
import { describe, expect, it } from "vitest";
import { derivedNonce } from "@czar/hashing";
import { h, harness, NOW, OTHER, PAYEE, VAULT } from "./helpers.ts";

type H = Awaited<ReturnType<typeof harness>>;

const NANO_VALID_BEFORE = NOW + 3_600;
/** A delay inside a projection read, so two requests in flight would interleave without the lock. */
const READ_DELAY_MS = 20;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function expectDenied(t: H, promise: Promise<unknown>, rule: string) {
  const before = t.calls.length;
  await expect(promise).rejects.toMatchObject({ name: "Denied", rule });
  expect(t.calls.length).toBe(before);
  expect(t.audit.rows.at(-1)).toMatchObject({ outcome: "kms_denied", rule });
}

const nano = (t: H, nonce: string, amount: string, overrides: Record<string, string> = {}) =>
  t.signer.sign("cz-15", {
    keyId: "K4",
    kind: "gateway-nano",
    payload: {
      pocket: t.pocket,
      payTo: PAYEE,
      amount,
      validBefore: String(NANO_VALID_BEFORE),
      nonce: h(nonce),
      ...overrides,
    },
  });

const usdc3009 = (t: H, index: number) =>
  t.signer.sign("cz-15", {
    keyId: "K3",
    kind: "usdc-3009",
    payload: {
      vault: VAULT,
      reservationId: "12",
      index: String(index),
      to: PAYEE,
      value: "100000",
      validBefore: "1760800600",
    },
  });

const reserve = (t: H) =>
  t.signer.sign("cz-15", {
    keyId: "K3",
    kind: "vault-call",
    payload: {
      vault: VAULT,
      selector: "reserve",
      args: {
        envelopeId: "1",
        stepIndex: "0",
        payee: PAYEE,
        stepCap: "500000",
        proof: [h("1")],
        unitAmount: "100000",
        count: "3",
        validBefore: "1760800600",
      },
    },
  });

const elapsed = new WeakMap<H, number>();
const elapsedMs = (t: H) => elapsed.get(t) ?? 0;

/** Moves the clock and keeps the freeze projection fresh, so only `validBefore` decides. */
function advanceTo(t: H, seconds: number) {
  t.advance(seconds * 1000 - (NOW * 1000 + elapsedMs(t)));
  elapsed.set(t, seconds * 1000 - NOW * 1000);
  t.state.observedAt = seconds - 1;
}

/** Simulates the indexer catching up with a nano transfer this signer signed. */
function indexNano(t: H, nonce: string, amount: bigint, payTo = PAYEE) {
  t.state.indexedNanoNonces.add(h(nonce).toLowerCase());
  t.state.nanoSpent = {
    step: t.state.nanoSpent.step + (payTo === PAYEE ? amount : 0n),
    pocket: t.state.nanoSpent.pocket + amount,
  };
}

const nanoLeaf = (t: H) => {
  const leaf = t.state.leaves.find((item) => item.stepKind === "gateway-nano");
  if (leaf === undefined) throw new Error("fixture has no gateway-nano leaf");
  return leaf;
};

describe("SCR-180 gateway-nano: the step cap and the funded amount count pending signatures", () => {
  it("§5.1: three signatures in one lag window, each within the step cap alone: the third is refused step-cap", async () => {
    const t = await harness();
    // stepCap 2,000; the indexer has seen nothing (nanoSpent stays 0 throughout).
    await nano(t, "1", "800");
    await nano(t, "2", "800");
    await expectDenied(t, nano(t, "3", "800"), "step-cap");
    // Exactly at the cap still signs: indexed 0 + pending 1,600 + 400 = 2,000.
    await nano(t, "4", "400");
    await expectDenied(t, nano(t, "5", "1"), "step-cap");
    expect(t.calls).toHaveLength(3);
  });

  it("§5.1: the same for the pocket's funded amount, across two payees", async () => {
    const t = await harness();
    t.state.leaves = t.state.leaves.map((leaf) =>
      leaf.stepKind === "gateway-nano" ? { ...leaf, stepCap: 100_000n } : leaf,
    );
    t.state.leaves.push({ ...nanoLeaf(t), payee: OTHER, stepIndex: 3 });
    // funded 5,000: 2,000 + 2,000 pending, then 2,000 more is over the pocket even though each step fits.
    await nano(t, "1", "2000");
    await nano(t, "2", "2000", { payTo: OTHER });
    await expectDenied(t, nano(t, "3", "2000"), "pocket-funded");
    await nano(t, "4", "1000", { payTo: OTHER });
    await expectDenied(t, nano(t, "5", "1"), "pocket-funded");
  });

  it("records pocket, payTo, nonce, validBefore, envelope, step and amount on the signed audit row", async () => {
    const t = await harness();
    await nano(t, "1", "800");
    expect(t.audit.rows.at(-1)).toMatchObject({
      outcome: "signed",
      kind: "gateway-nano",
      keyRef: `K4:${t.pocket}`,
      spend: {
        kind: "gateway-nano",
        pocket: t.pocket.toLowerCase(),
        payTo: PAYEE,
        nonce: h("1"),
        validBefore: BigInt(NANO_VALID_BEFORE),
        envelopeId: 1n,
        stepIndex: nanoLeaf(t).stepIndex,
        amount: 800n,
      },
    });
  });

  it("§5.2: an indexed transfer stops counting as pending and is never counted twice", async () => {
    const t = await harness();
    await nano(t, "1", "800");
    await nano(t, "2", "800");
    indexNano(t, "1", 800n);
    indexNano(t, "2", 800n);
    // Indexed 1,600 + pending 0 + 400 = 2,000 fits; counting them twice (3,200) would refuse it.
    await nano(t, "3", "400");
    await expectDenied(t, nano(t, "4", "1"), "step-cap");
  });

  it("§5.2: one indexed and one still pending: each is counted exactly once", async () => {
    const t = await harness();
    await nano(t, "1", "800");
    await nano(t, "2", "800");
    indexNano(t, "1", 800n);
    // Indexed 800 + pending 800 + 401 = 2,001.
    await expectDenied(t, nano(t, "3", "401"), "step-cap");
    await nano(t, "3", "400");
  });

  it("counts one nonce once, at its largest amount, when it was signed twice", async () => {
    const t = await harness();
    await nano(t, "1", "800");
    await nano(t, "1", "800");
    // Only one authorization with nonce 1 can ever settle: pending is 800, not 1,600.
    await nano(t, "2", "1200");
    await expectDenied(t, nano(t, "3", "1"), "step-cap");
  });

  it("§5.3: a signature past validBefore without settling stops counting", async () => {
    const t = await harness();
    const shortLived = String(NOW + 60);
    await nano(t, "1", "800", { validBefore: shortLived });
    await nano(t, "2", "800", { validBefore: shortLived });
    await expectDenied(t, nano(t, "3", "800"), "step-cap");
    // One second before validBefore both still count.
    advanceTo(t, NOW + 59);
    await expectDenied(t, nano(t, "3", "800"), "step-cap");
    // At validBefore the authorizations are dead on chain (`now < validBefore` no longer holds).
    advanceTo(t, NOW + 60);
    await nano(t, "3", "800");
  });

  it("§5.4: two concurrent requests for one pocket, each fitting alone but not together: exactly one signs", async () => {
    // Delay the indexed read: without serialisation both requests would read the same total.
    const slow: H = await harness({
      projection: {
        nanoSpent: async () => {
          await sleep(READ_DELAY_MS);
          return slow.state.nanoSpent;
        },
      },
    });
    const results = await Promise.allSettled([nano(slow, "1", "1200"), nano(slow, "2", "1200")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected");
    expect(refused).toMatchObject({
      reason: { name: "Denied", rule: "step-cap" },
    });
    expect(slow.calls).toHaveLength(1);
    expect(slow.audit.rows.filter((row) => row.outcome === "signed")).toHaveLength(1);
  });

  it("§5.4: two concurrent requests for different pockets do not wait on each other's spend", async () => {
    const a = await harness();
    const b = await harness();
    const [first, second] = await Promise.all([nano(a, "1", "1200"), nano(b, "1", "1200")]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
  });

  it("§5.5: the pending read failing refuses with backend-error and signs nothing", async () => {
    const t = await harness({
      projection: {
        pendingNanoSpent: async () => {
          throw new Error("audit read failed");
        },
      },
    });
    await expect(nano(t, "1", "800")).rejects.toThrow("audit read failed");
    expect(t.calls).toEqual([]);
    expect(t.audit.rows.some((row) => row.outcome === "signed")).toBe(false);
    expect(t.audit.rows.at(-1)).toMatchObject({
      outcome: "backend-error",
      rule: "backend",
    });
  });

  it("§3: a signature whose audit row cannot be written is never returned", async () => {
    const t = await harness({
      auditSink: {
        write: async (row) => {
          if (row.outcome === "signed") throw new Error("audit write failed");
        },
      },
    });
    await expect(nano(t, "1", "800")).rejects.toThrow("audit write failed");
  });
});

describe("SCR-180 expected calls: indexed used calls plus pending usdc-3009 signatures", () => {
  it("§5.1: authorizations signed but not yet indexed as used use up the step's expected calls", async () => {
    const t = await harness();
    // Step 0: expectedCalls 2, usedCalls 0 (indexed).
    await reserve(t);
    await usdc3009(t, 0);
    await reserve(t);
    await usdc3009(t, 1);
    await expectDenied(t, reserve(t), "expected-calls-used");
  });

  it("records vault, nonce, validBefore, envelope, step and amount (no payee) on the signed usdc-3009 row", async () => {
    const t = await harness();
    await usdc3009(t, 1);
    const text = JSON.stringify(t.audit.rows, (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(text).not.toContain(PAYEE.slice(2));
    expect(t.audit.rows.at(-1)).toMatchObject({
      outcome: "signed",
      kind: "usdc-3009",
      spend: {
        kind: "usdc-3009",
        vault: VAULT,
        nonce: derivedNonce(VAULT, 12n, 1),
        validBefore: 1_760_800_600n,
        envelopeId: 1n,
        stepIndex: 0,
        amount: 100_000n,
      },
    });
  });

  it("§5.2: an authorization indexed as used stops counting as pending and is counted once", async () => {
    const t = await harness();
    await usdc3009(t, 0);
    // The indexer sees it used: usedCalls 1, pending 0. Counting it twice would make 2 and refuse.
    t.state.usedAuthorizationNonces.add(derivedNonce(VAULT, 12n, 0).toLowerCase());
    const leaf = t.state.leaves[0] as NonNullable<(typeof t.state.leaves)[0]>;
    t.state.leaves[0] = { ...leaf, usedCalls: 1 };
    await reserve(t);
    await usdc3009(t, 1);
    await expectDenied(t, reserve(t), "expected-calls-used");
  });

  it("§5.3: an authorization past validBefore stops counting", async () => {
    const t = await harness();
    await usdc3009(t, 0);
    await usdc3009(t, 1);
    await expectDenied(t, reserve(t), "expected-calls-used");
    advanceTo(t, 1_760_800_599);
    await expectDenied(t, reserve(t), "expected-calls-used");
    advanceTo(t, 1_760_800_600);
    await reserve(t);
  });

  it("does not count another step's or another envelope's authorizations", async () => {
    const t = await harness();
    const reservation = t.state.reservation as NonNullable<typeof t.state.reservation>;
    t.state.reservation = { ...reservation, stepIndex: 1 };
    await usdc3009(t, 0);
    t.state.reservation = { ...reservation, envelopeId: 2n };
    await usdc3009(t, 1);
    t.state.reservation = reservation;
    await reserve(t);
  });

  it("§5.4: a reserve that starts while a usdc-3009 for the vault is being signed waits for it and counts it", async () => {
    // The usdc-3009 is slow to read its reservation; a reserve sent meanwhile must not read pending first.
    const t: H = await harness({
      projection: {
        reservation: async () => {
          await sleep(READ_DELAY_MS);
          return t.state.reservation;
        },
      },
    });
    await usdc3009(t, 0);
    const inFlight = usdc3009(t, 1);
    await sleep(1);
    const reserving = reserve(t);
    await inFlight;
    await expect(reserving).rejects.toMatchObject({
      name: "Denied",
      rule: "expected-calls-used",
    });
  });

  it("§5.5: the pending read failing refuses the reserve with backend-error and signs nothing", async () => {
    const t = await harness({
      projection: {
        pendingCalls: async () => {
          throw new Error("audit read failed");
        },
      },
    });
    await expect(reserve(t)).rejects.toThrow("audit read failed");
    expect(t.calls).toEqual([]);
    expect(t.prepared).toEqual([]);
    expect(t.audit.rows.at(-1)).toMatchObject({
      outcome: "backend-error",
      rule: "backend",
    });
  });
});
