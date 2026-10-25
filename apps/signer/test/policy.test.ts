// CZ-27 §14 policy tests: for every kind one accepted request and one denial per rule, plus the named
// RV tests. Every denial must leave the backend untouched.
import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseTransaction, recoverAddress, slice, type Hex } from "viem";
import {
  derivedNonce,
  KIND_TAGS,
  paymentRefHash,
  usdcTransferWithAuthorizationDigest,
} from "@czar/hashing";
import type { PaymentRef } from "@czar/schemas";
import { K3_NEVER, USDC_ABI, VAULT_ABI, selectorOf } from "../src/index.ts";
import {
  archiveUri,
  ESCROW,
  h,
  harness,
  NETWORK,
  NOW,
  OTHER,
  PAYEE,
  uriHash,
  VAULT,
} from "./helpers.ts";

type H = Awaited<ReturnType<typeof harness>>;

async function expectDenied(t: H, promise: Promise<unknown>, rule: string) {
  const before = t.calls.length;
  await expect(promise).rejects.toMatchObject({ name: "Denied", rule });
  expect(t.calls.length).toBe(before);
  expect(t.audit.rows.at(-1)).toMatchObject({ outcome: "kms_denied", rule });
}

const usdcPayload = (overrides: Record<string, string> = {}) => ({
  vault: VAULT,
  reservationId: "12",
  index: "1",
  to: PAYEE,
  value: "100000",
  validBefore: "1760800600",
  ...overrides,
});

const openEnvelopeArgs = (overrides: Record<string, string> = {}) => ({
  p: {
    cap: "1000000",
    maxStepAmount: "500000",
    pocketCapBps: "2500",
    expiresAt: "1760900000",
    categoryId: h("d"),
    objectiveHash: h("c"),
    planHash: h("a"),
    payeeRoot: h("b"),
    ...overrides,
  },
});

const reserveArgs = (overrides: Record<string, unknown> = {}) => ({
  envelopeId: "1",
  stepIndex: "0",
  payee: PAYEE,
  stepCap: "500000",
  proof: [h("1")],
  unitAmount: "100000",
  count: "3",
  validBefore: "1760800600",
  ...overrides,
});

const vaultCall = (selector: string, args: unknown) => ({
  keyId: "K3",
  kind: "vault-call",
  payload: { vault: VAULT, selector, args },
});

describe("usdc-3009 (K3)", () => {
  it("signs the rebuilt digest and returns the 02 §6.3.1 envelope", async () => {
    const t = await harness();
    const result = (await t.signer.sign("cz-15", {
      keyId: "K3",
      kind: "usdc-3009",
      payload: usdcPayload(),
    })) as {
      signature: Hex;
      digest: Hex;
    };
    const nonce = derivedNonce(VAULT, 12n, 1);
    const expected = usdcTransferWithAuthorizationDigest(5042002, {
      from: VAULT,
      to: PAYEE,
      value: 100000n,
      validAfter: 0n,
      validBefore: 1760800600n,
      nonce,
    });
    expect(result.digest).toBe(expected);
    expect((result.signature.length - 2) / 2).toBe(416);
    expect(slice(result.signature, 0, 32)).toBe(KIND_TAGS.USDC_3009);
    const agentSig = slice(result.signature, 320, 385);
    expect(await recoverAddress({ hash: expected, signature: agentSig })).toBe(
      (await import("viem")).getAddress(t.address("K3")),
    );
  });

  it("signer_usdc3009_toOutsideReservation_denied", async () => {
    const t = await harness();
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "usdc-3009",
        payload: usdcPayload({ to: OTHER }),
      }),
      "payee-mismatch",
    );
  });

  it("denies value above unitAmount, index ≥ count, validBefore drift, unknown reservation", async () => {
    const t = await harness();
    const sign = (o: Record<string, string>) =>
      t.signer.sign("cz-15", { keyId: "K3", kind: "usdc-3009", payload: usdcPayload(o) });
    await expectDenied(t, sign({ value: "100001" }), "amount-mismatch");
    await expectDenied(t, sign({ index: "3" }), "index-out-of-range");
    await expectDenied(t, sign({ validBefore: "1760800601" }), "valid-before-mismatch");
    t.state.reservation = undefined;
    await expectDenied(t, sign({}), "unknown-reservation");
  });

  it("denies while frozen, paused or when the freeze view is stale (D72)", async () => {
    const t = await harness();
    const sign = () =>
      t.signer.sign("cz-15", { keyId: "K3", kind: "usdc-3009", payload: usdcPayload() });
    t.state.frozen = true;
    await expectDenied(t, sign(), "frozen");
    t.state.frozen = false;
    t.state.guardianPaused = true;
    await expectDenied(t, sign(), "frozen");
    t.state.guardianPaused = false;
    t.state.observedAt = NOW - 31;
    await expectDenied(t, sign(), "frozen");
  });

  it("refuses unknown fields and malformed values before any read", async () => {
    const t = await harness();
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "usdc-3009",
        payload: { ...usdcPayload(), digest: h("1") },
      }),
      "shape",
    );
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "usdc-3009",
        payload: usdcPayload({ value: "1e5" }),
      }),
      "shape",
    );
  });
});

describe("vault-call (K3)", () => {
  it("signer_k3_neverSignableSelectors_denied for every selector in the never list", async () => {
    const t = await harness();
    for (const name of K3_NEVER) {
      await expectDenied(t, t.signer.sign("cz-15", vaultCall(name, {})), "never-signable");
      await expectDenied(
        t,
        t.signer.sign("cz-15", vaultCall(selectorOf(VAULT_ABI, name), {})),
        "never-signable",
      );
    }
    // Factory selectors (pause) and unknown selectors.
    await expectDenied(t, t.signer.sign("cz-15", vaultCall("0x8456cb59", {})), "never-signable");
    await expectDenied(
      t,
      t.signer.sign("cz-15", vaultCall("0xdeadbeef", {})),
      "selector-not-allowed",
    );
    await expectDenied(t, t.signer.sign("cz-15", vaultCall("approve", {})), "selector-not-allowed");
  });

  it("signs an openEnvelope that equals the stored plan, encoding the args itself", async () => {
    const t = await harness();
    const { signedTransaction } = (await t.signer.sign(
      "cz-15",
      vaultCall("openEnvelope", openEnvelopeArgs()),
    )) as { signedTransaction: Hex };
    const tx = parseTransaction(signedTransaction);
    expect(tx.to).toBe(VAULT);
    expect(decodeFunctionData({ abi: VAULT_ABI, data: tx.data as Hex }).functionName).toBe(
      "openEnvelope",
    );
  });

  it("signer_openEnvelope_argsNotMatchingStoredPlan_denied", async () => {
    const t = await harness();
    await expectDenied(
      t,
      t.signer.sign("cz-15", vaultCall("openEnvelope", openEnvelopeArgs({ cap: "1000001" }))),
      "plan-mismatch",
    );
    await expectDenied(
      t,
      t.signer.sign("cz-15", vaultCall("openEnvelope", openEnvelopeArgs({ planHash: h("e") }))),
      "plan-mismatch",
    );
    t.state.plan = {
      ...(t.state.plan as NonNullable<typeof t.state.plan>),
      approval: "needs-approval",
    };
    await expectDenied(
      t,
      t.signer.sign("cz-15", vaultCall("openEnvelope", openEnvelopeArgs())),
      "plan-not-auto-approvable",
    );
  });

  it("signer_reserve_leafNotInPlan_denied", async () => {
    const t = await harness();
    await t.signer.sign("cz-15", vaultCall("reserve", reserveArgs()));
    await expectDenied(
      t,
      t.signer.sign("cz-15", vaultCall("reserve", reserveArgs({ payee: OTHER }))),
      "leaf-not-in-plan",
    );
    await expectDenied(
      t,
      t.signer.sign("cz-15", vaultCall("reserve", reserveArgs({ stepCap: "500001" }))),
      "leaf-not-in-plan",
    );
    t.state.leaves[0] = {
      ...(t.state.leaves[0] as NonNullable<(typeof t.state.leaves)[0]>),
      usedCalls: 2,
    };
    await expectDenied(
      t,
      t.signer.sign("cz-15", vaultCall("reserve", reserveArgs())),
      "expected-calls-used",
    );
  });

  it("checks openJob and registerPocket against plan leaves", async () => {
    const t = await harness();
    const job = {
      envelopeId: "1",
      stepIndex: "1",
      provider: OTHER,
      stepCap: "300000",
      proof: [],
      expiredAt: "1760900000",
      descriptionHash: h("f"),
    };
    await t.signer.sign("cz-15", vaultCall("openJob", job));
    await expectDenied(
      t,
      t.signer.sign("cz-15", vaultCall("openJob", { ...job, provider: PAYEE })),
      "leaf-not-in-plan",
    );
    await t.signer.sign(
      "cz-15",
      vaultCall("registerPocket", { envelopeId: "1", pocket: t.pocket, proof: [] }),
    );
    await expectDenied(
      t,
      t.signer.sign(
        "cz-15",
        vaultCall("registerPocket", { envelopeId: "1", pocket: OTHER, proof: [] }),
      ),
      "leaf-not-in-plan",
    );
  });

  it("signer_writeOff_duringSlowWithdraw_denied", async () => {
    const t = await harness();
    t.state.pocket = {
      ...(t.state.pocket as NonNullable<typeof t.state.pocket>),
      slowWithdrawalOpen: true,
    };
    await expectDenied(
      t,
      t.signer.sign("cz-15", vaultCall("writeOffPocket", { pocket: t.pocket })),
      "slow-withdrawal-open",
    );
  });

  it("requires a fresh Gateway balance and only writes off dust with no open pullback", async () => {
    const stale = await harness();
    stale.state.balances = { ...stale.state.balances, gatewayApiFresh: false };
    await expectDenied(
      stale,
      stale.signer.sign("cz-15", vaultCall("writeOffPocket", { pocket: stale.pocket })),
      "gateway-balance-stale",
    );

    const dusty = await harness();
    dusty.state.balances = {
      ...dusty.state.balances,
      gatewayApi: 10_000n,
      gatewayAvailable: 10_000n,
    };
    await dusty.signer.sign("cz-15", vaultCall("writeOffPocket", { pocket: dusty.pocket }));
    dusty.state.balances = { ...dusty.state.balances, gatewayAvailable: 10_001n };
    await expectDenied(
      dusty,
      dusty.signer.sign("cz-15", vaultCall("writeOffPocket", { pocket: dusty.pocket })),
      "gateway-balance-not-dust",
    );
    dusty.state.pocket = {
      ...(dusty.state.pocket as NonNullable<typeof dusty.state.pocket>),
      pendingPullback: 1n,
    };
    await expectDenied(
      dusty,
      dusty.signer.sign("cz-15", vaultCall("writeOffPocket", { pocket: dusty.pocket })),
      "pending-pullback",
    );
  });

  it("applies the freeze check to spending selectors only (freeze itself stays signable)", async () => {
    const t = await harness();
    t.state.frozen = true;
    await expectDenied(t, t.signer.sign("cz-15", vaultCall("reserve", reserveArgs())), "frozen");
    await t.signer.sign("cz-15", vaultCall("freeze", {}));
    await t.signer.sign(
      "cz-15",
      vaultCall("requestPullback", {
        pocket: t.pocket,
        value: "1",
        maxFee: "1",
        maxBlockHeight: "1",
      }),
    );
  });

  it("denies an unknown vault and malformed args", async () => {
    const t = await harness();
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "vault-call",
        payload: { vault: OTHER, selector: "freeze", args: {} },
      }),
      "unknown-vault",
    );
    await expectDenied(
      t,
      t.signer.sign("cz-15", vaultCall("settle", { reservationId: "1", indices: ["x"] })),
      "shape",
    );
    await expectDenied(
      t,
      t.signer.sign("cz-15", vaultCall("settle", { reservationId: "1", indices: [], extra: "1" })),
      "shape",
    );
  });
});

describe("gateway-burn (K3)", () => {
  it("rebuilds the burn intent with recipient = vault and is allowed while frozen (D72)", async () => {
    const t = await harness();
    t.state.frozen = true;
    const result = (await t.signer.sign("cz-15", {
      keyId: "K3",
      kind: "gateway-burn",
      payload: { vault: VAULT, pullbackId: "4" },
    })) as { signature: Hex };
    expect(slice(result.signature, 0, 32)).toBe(KIND_TAGS.GATEWAY_BURN);
  });

  it("denies a Cancelled pullback and one past maxBlockHeight", async () => {
    const t = await harness();
    const sign = () =>
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "gateway-burn",
        payload: { vault: VAULT, pullbackId: "4" },
      });
    t.state.block = 68_000_001n;
    await expectDenied(t, sign(), "pullback-expired");
    t.state.pullback = {
      ...(t.state.pullback as NonNullable<typeof t.state.pullback>),
      state: "Cancelled",
    };
    await expectDenied(t, sign(), "pullback-not-pending");
  });
});

const baseReceipt = {
  requestCommit: h("4"),
  responseCommit: h("5"),
  statusCode: "200",
  originAsserted: "https://merchant.example",
  requirementsHashSeen: h("6"),
  tRequest: "1760790000",
  tPaymentSigned: "1760790001",
  tComplete: "1760790003",
  outcome: "0",
  localChecksCommit: h("0"),
  disclosure: "2",
  createdAt: "1760790004",
};

const x402PaymentRef: PaymentRef = {
  schemaVersion: "1.0",
  rail: "x402-exact",
  network: "eip155:5042002",
  asset: NETWORK.usdc,
  payer: VAULT,
  payTo: PAYEE,
  amount: "100000",
  nonce: h("1"),
  validBefore: 1760800600,
};

const receiptFor = (paymentRef: PaymentRef) => ({
  ...baseReceipt,
  paymentRefHash: paymentRefHash(paymentRef),
});

describe("sl-receipt (K3, RV-013)", () => {
  it("signs the vault-bound attestation for a settled payment", async () => {
    const t = await harness();
    const receipt = receiptFor(x402PaymentRef);
    t.state.settled.add(receipt.paymentRefHash);
    const result = (await t.signer.sign("cz-15", {
      keyId: "K3",
      kind: "sl-receipt",
      payload: { vault: VAULT, receipt, paymentRef: x402PaymentRef },
    })) as { signature: Hex; digest: Hex };
    expect(result.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(slice(result.signature, 0, 32)).toBe(KIND_TAGS.SL_RECEIPT);
  });

  it("denies an unsettled x402 payment", async () => {
    const t = await harness();
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "sl-receipt",
        payload: { vault: VAULT, receipt: receiptFor(x402PaymentRef), paymentRef: x402PaymentRef },
      }),
      "payment-not-settled",
    );
  });

  it("denies references for another chain or token on every supported rail", async () => {
    const t = await harness();
    const references: PaymentRef[] = [
      { ...x402PaymentRef, network: "eip155:1" },
      { ...x402PaymentRef, asset: OTHER },
      {
        schemaVersion: "1.0",
        rail: "gateway-batched",
        network: "eip155:1",
        payer: PAYEE,
        payTo: VAULT,
        amount: "100000",
        nonce: h("2"),
      },
      {
        schemaVersion: "1.0",
        rail: "erc8183-job",
        network: "eip155:1",
        contract: ESCROW,
        jobId: "9",
        client: VAULT,
        provider: PAYEE,
        evaluator: OTHER,
        budget: "250000",
      },
    ];

    for (const paymentRef of references) {
      t.state.settled.add(paymentRefHash(paymentRef));
      await expectDenied(
        t,
        t.signer.sign("cz-15", {
          keyId: "K3",
          kind: "sl-receipt",
          payload: { vault: VAULT, receipt: receiptFor(paymentRef), paymentRef },
        }),
        "payment-not-settled",
      );
    }
  });

  it("checks the PaymentRef hash before settlement and binds x402 to this vault", async () => {
    const t = await harness();
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "sl-receipt",
        payload: {
          vault: VAULT,
          receipt: { ...receiptFor(x402PaymentRef), paymentRefHash: h("e") },
          paymentRef: x402PaymentRef,
        },
      }),
      "payment-ref-mismatch",
    );
    const otherPayer: PaymentRef = { ...x402PaymentRef, payer: OTHER };
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "sl-receipt",
        payload: { vault: VAULT, receipt: receiptFor(otherPayer), paymentRef: otherPayer },
      }),
      "payment-not-this-vault",
    );
  });

  it("binds Gateway pockets and job clients to the receipt vault", async () => {
    const t = await harness();
    const outsidePocket: PaymentRef = {
      schemaVersion: "1.0",
      rail: "gateway-batched",
      network: "eip155:5042002",
      payer: OTHER,
      payTo: PAYEE,
      amount: "100000",
      nonce: h("2"),
    };
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "sl-receipt",
        payload: {
          vault: VAULT,
          receipt: receiptFor(outsidePocket),
          paymentRef: outsidePocket,
        },
      }),
      "payment-not-this-vault",
    );

    const otherClient: PaymentRef = {
      schemaVersion: "1.0",
      rail: "erc8183-job",
      network: "eip155:5042002",
      contract: ESCROW,
      jobId: "9",
      client: OTHER,
      provider: OTHER,
      evaluator: OTHER,
      budget: "250000",
    };
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "sl-receipt",
        payload: { vault: VAULT, receipt: receiptFor(otherClient), paymentRef: otherClient },
      }),
      "payment-not-this-vault",
    );
  });

  it("requires and schema-validates PaymentRef", async () => {
    const t = await harness();
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "sl-receipt",
        payload: { vault: VAULT, receipt: baseReceipt },
      }),
      "shape",
    );
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "sl-receipt",
        payload: {
          vault: VAULT,
          receipt: receiptFor(x402PaymentRef),
          paymentRef: { ...x402PaymentRef, amount: "1e5" },
        },
      }),
      "shape",
    );
  });

  it("accepts completed Gateway transfers and rejects unsettled or overlarge references", async () => {
    const t = await harness();
    const completed: PaymentRef = {
      schemaVersion: "1.0",
      rail: "gateway-batched",
      network: "eip155:5042002",
      payer: t.pocket,
      payTo: PAYEE,
      amount: "100000",
      nonce: h("2"),
    };
    t.state.settled.add(paymentRefHash(completed));
    await t.signer.sign("cz-15", {
      keyId: "K3",
      kind: "sl-receipt",
      payload: { vault: VAULT, receipt: receiptFor(completed), paymentRef: completed },
    });

    const confirmed = { ...completed, nonce: h("3") };
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "sl-receipt",
        payload: { vault: VAULT, receipt: receiptFor(confirmed), paymentRef: confirmed },
      }),
      "payment-not-settled",
    );

    const overlarge = { ...completed, amount: "100001" };
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "sl-receipt",
        payload: { vault: VAULT, receipt: receiptFor(overlarge), paymentRef: overlarge },
      }),
      "payment-not-settled",
    );
  });

  it("accepts Completed jobs and denies Submitted jobs", async () => {
    const t = await harness();
    const completed: PaymentRef = {
      schemaVersion: "1.0",
      rail: "erc8183-job",
      network: "eip155:5042002",
      contract: ESCROW,
      jobId: "9",
      client: VAULT,
      provider: OTHER,
      evaluator: OTHER,
      budget: "250000",
    };
    t.state.settled.add(paymentRefHash(completed));
    await t.signer.sign("cz-15", {
      keyId: "K3",
      kind: "sl-receipt",
      payload: { vault: VAULT, receipt: receiptFor(completed), paymentRef: completed },
    });
    const submitted = { ...completed, jobId: "10" };
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "sl-receipt",
        payload: { vault: VAULT, receipt: receiptFor(submitted), paymentRef: submitted },
      }),
      "payment-not-settled",
    );
  });

  it("signer_slReceipt_opaqueStructHash_denied", async () => {
    const t = await harness();
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "sl-receipt",
        payload: { vault: VAULT, structHash: h("e") },
      }),
      "shape",
    );
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K3",
        kind: "sl-receipt",
        payload: { vault: VAULT, receipt: { structHash: h("e") } },
      }),
      "shape",
    );
  });
});

const raisePayload = (newLimit: string) => ({
  vault: VAULT,
  categoryId: h("9"),
  newLimit,
  periodId: "2963",
  deadline: "1792026000",
});

describe("autonomy-raise (K5)", () => {
  it("signs the 02 §6.2 digest within the D40 step", async () => {
    const t = await harness();
    const result = (await t.signer.sign("cz-24", {
      keyId: "K5",
      kind: "autonomy-raise",
      payload: raisePayload("5000000"),
    })) as { signature: Hex };
    expect((result.signature.length - 2) / 2).toBe(65);
  });

  it("denies a lowering, above userMax, above the step, too soon, and while frozen", async () => {
    const t = await harness();
    const sign = (limit: string) =>
      t.signer.sign("cz-24", { keyId: "K5", kind: "autonomy-raise", payload: raisePayload(limit) });
    await expectDenied(t, sign("2000000"), "not-a-raise");
    await expectDenied(t, sign("5000001"), "above-step");
    t.state.autonomy = {
      ...(t.state.autonomy as NonNullable<typeof t.state.autonomy>),
      userMax: 4_000_000n,
    };
    await expectDenied(t, sign("4500000"), "above-user-max");
    t.state.autonomy = {
      ...(t.state.autonomy as NonNullable<typeof t.state.autonomy>),
      lastRaiseAt: NOW - 10,
    };
    await expectDenied(t, sign("3000000"), "too-soon");
    t.state.frozen = true;
    await expectDenied(t, sign("3000000"), "frozen");
  });

  it("allows exactly the D40 userMax step and denies one atomic unit more", async () => {
    const t = await harness();
    const setLimits = (autoLimit: bigint, userMax: bigint, maxStepTo: bigint) => {
      t.state.autonomy = {
        autoLimit,
        userMax,
        maxStepTo,
        lastRaiseAt: NOW - 700_000,
        periodLength: 604_800,
        nonce: 7n,
      };
    };
    const sign = (newLimit: bigint) =>
      t.signer.sign("cz-24", {
        keyId: "K5",
        kind: "autonomy-raise",
        payload: raisePayload(newLimit.toString()),
      });

    setLimits(0n, 1_000n, 200n);
    await sign(200n);
    await expectDenied(t, sign(201n), "above-step");

    setLimits(200n, 1_000n, 400n);
    await sign(400n);
    await expectDenied(t, sign(401n), "above-step");
  });

  it("signer_k5_sendTransaction_denied", async () => {
    const t = await harness();
    await expectDenied(
      t,
      t.signer.sign("cz-24", { keyId: "K5", kind: "relayer-tx", payload: {} }),
      "kind-not-allowed",
    );
    await expectDenied(
      t,
      t.signer.sign("cz-24", vaultCall("lowerAutoLimit", {}) as never),
      "caller-not-owner",
    );
  });
});

const evalPayload = (decision: string, overrides: Record<string, string> = {}) => ({
  escrow: "0x000000000000000000000000000000000000e5c0",
  jobId: "5",
  decision,
  reportHash: h("9"),
  ...overrides,
});

describe("evaluator-call and sl-validation-report (K7)", () => {
  it("signs complete and reject transactions to the configured escrow", async () => {
    const t = await harness();
    await t.signer.sign("cz-16", {
      keyId: "K7",
      kind: "evaluator-call",
      payload: evalPayload("complete"),
    });
    await t.signer.sign("cz-16", {
      keyId: "K7",
      kind: "evaluator-call",
      payload: evalPayload("reject"),
    });
    expect(t.prepared.map((tx) => tx.to)).toEqual([
      "0x000000000000000000000000000000000000e5c0",
      "0x000000000000000000000000000000000000e5c0",
    ]);
  });

  it("denies a job whose evaluator is another address, an unknown report or escrow", async () => {
    const t = await harness();
    await expectDenied(
      t,
      t.signer.sign("cz-16", {
        keyId: "K7",
        kind: "evaluator-call",
        payload: evalPayload("complete", { reportHash: h("e") }),
      }),
      "unknown-report",
    );
    await expectDenied(
      t,
      t.signer.sign("cz-16", {
        keyId: "K7",
        kind: "evaluator-call",
        payload: evalPayload("complete", { escrow: OTHER }),
      }),
      "unknown-escrow",
    );
    t.state.job = { evaluator: OTHER, clientVault: VAULT };
    await expectDenied(
      t,
      t.signer.sign("cz-16", {
        keyId: "K7",
        kind: "evaluator-call",
        payload: evalPayload("reject"),
      }),
      "not-evaluator",
    );
  });

  it("signer_evaluatorComplete_whilePaused_denied", async () => {
    const t = await harness();
    t.state.guardianPaused = true;
    await expectDenied(
      t,
      t.signer.sign("cz-16", {
        keyId: "K7",
        kind: "evaluator-call",
        payload: evalPayload("complete"),
      }),
      "frozen",
    );
  });

  it("signer_evaluatorReject_whileFrozen_allowed", async () => {
    const t = await harness();
    t.state.frozen = true;
    t.state.guardianPaused = true;
    await t.signer.sign("cz-16", {
      keyId: "K7",
      kind: "evaluator-call",
      payload: evalPayload("reject"),
    });
  });

  it("signs a validation report only for a known checksCommit", async () => {
    const t = await harness();
    const report = {
      obsId: h("1"),
      profileId: h("2"),
      methodVersion: h("3"),
      assignmentKind: "1",
      saltCommit: h("4"),
      checksCommit: h("8"),
      createdAt: "1760790004",
    };
    await t.signer.sign("cz-16", {
      keyId: "K7",
      kind: "sl-validation-report",
      payload: { report },
    });
    await expectDenied(
      t,
      t.signer.sign("cz-16", {
        keyId: "K7",
        kind: "sl-validation-report",
        payload: { report: { ...report, checksCommit: h("e") } },
      }),
      "unknown-checks-commit",
    );
  });
});

const oelPayload = (overrides: Record<string, string> = {}) => ({
  kind: "0",
  root: h("7"),
  prev: h("0"),
  uriHash: uriHash(archiveUri(h("7"))),
  uri: archiveUri(h("7")),
  ...overrides,
});

describe("oel-commit (K8)", () => {
  it("signs commit with prev = latest root and the host-free archive uri (D78)", async () => {
    const t = await harness();
    await t.signer.sign("cz-17", { keyId: "K8", kind: "oel-commit", payload: oelPayload() });
    expect(t.prepared[0]?.to).toBe("0x00000000000000000000000000000000000000e1");
  });

  it("denies a wrong prev, unknown batch, localhost uri and a uriHash mismatch", async () => {
    const t = await harness();
    const sign = (o: Record<string, string>) =>
      t.signer.sign("cz-17", { keyId: "K8", kind: "oel-commit", payload: oelPayload(o) });
    await expectDenied(t, sign({ prev: h("1") }), "prev-mismatch");
    await expectDenied(t, sign({ root: h("6") }), "unknown-batch");
    const local = "http://localhost:8080/v1/archives/x.jsonl";
    await expectDenied(t, sign({ uri: local, uriHash: uriHash(local) }), "uri-mismatch");
    await expectDenied(t, sign({ uriHash: h("1") }), "uri-hash-mismatch");
  });
});

const proofPayload = (overrides: Record<string, string> = {}) => ({
  service: "czar-search",
  purpose: "verify",
  method: "POST",
  bodyHash: h("1"),
  network: "eip155:5042002",
  nonce: h("2"),
  expiry: String(NOW + 300),
  ...overrides,
});

describe("merchant-seller-proof (K10)", () => {
  it("signs within the 5-minute expiry on the configured network", async () => {
    const t = await harness();
    await t.signer.sign("cz-20", {
      keyId: "K10",
      kind: "merchant-seller-proof",
      payload: proofPayload(),
    });
    expect(t.calls).toEqual(["digest:K10:czar-search"]);
  });

  it("denies another network, a long or past expiry, and an unknown service", async () => {
    const t = await harness();
    const sign = (o: Record<string, string>) =>
      t.signer.sign("cz-20", {
        keyId: "K10",
        kind: "merchant-seller-proof",
        payload: proofPayload(o),
      });
    await expectDenied(t, sign({ network: "eip155:8453" }), "wrong-network");
    await expectDenied(t, sign({ expiry: String(NOW + 301) }), "expiry-out-of-range");
    await expectDenied(t, sign({ expiry: String(NOW) }), "expiry-out-of-range");
    await expectDenied(t, sign({ service: "other" }), "unknown-service");
  });
});

const nano = (pocket: string, overrides: Record<string, string> = {}) => ({
  pocket,
  payTo: PAYEE,
  amount: "1000",
  validBefore: "1761404800",
  nonce: h("5"),
  ...overrides,
});

describe("K4 pocket kinds", () => {
  it("signs a nanopayment to a gateway-nano payee within step and pocket caps", async () => {
    const t = await harness();
    await t.signer.sign("cz-15", { keyId: "K4", kind: "gateway-nano", payload: nano(t.pocket) });
    expect(t.calls).toEqual([`digest:K4:${t.pocket}`]);
  });

  it("signer_gatewayNano_whileFrozen_denied", async () => {
    const t = await harness();
    t.state.frozen = true;
    await expectDenied(
      t,
      t.signer.sign("cz-15", { keyId: "K4", kind: "gateway-nano", payload: nano(t.pocket) }),
      "frozen",
    );
    t.state.frozen = false;
    t.state.guardianPaused = true;
    await expectDenied(
      t,
      t.signer.sign("cz-15", { keyId: "K4", kind: "gateway-nano", payload: nano(t.pocket) }),
      "frozen",
    );
  });

  it("denies a payee outside the plan, the step cap, the funded amount and an inactive pocket", async () => {
    const t = await harness();
    const sign = (o: Record<string, string> = {}) =>
      t.signer.sign("cz-15", { keyId: "K4", kind: "gateway-nano", payload: nano(t.pocket, o) });
    await expectDenied(t, sign({ payTo: OTHER }), "payee-not-in-plan");
    await expectDenied(t, sign({ amount: "2001" }), "step-cap");
    t.state.nanoSpent = { step: 0n, pocket: 4_500n };
    await expectDenied(t, sign(), "pocket-funded");
    t.state.pocket = { ...(t.state.pocket as NonNullable<typeof t.state.pocket>), state: "Closed" };
    await expectDenied(t, sign(), "pocket-not-active");
  });

  it("signer_k4_usdcApproveOrTransferElsewhere_denied", async () => {
    const t = await harness();
    // No K4 kind takes a recipient: a caller-supplied `to` is refused, and vault-call is not a K4 kind.
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K4",
        kind: "pocket-return",
        payload: { pocket: t.pocket, kind: "usdc", amount: "1", to: OTHER },
      }),
      "shape",
    );
    await expectDenied(
      t,
      t.signer.sign("cz-15", { keyId: "K4", kind: "vault-call", payload: {} }),
      "kind-not-allowed",
    );
    await expectDenied(
      t,
      t.signer.sign("cz-15", { keyId: "K4", kind: "usdc-3009", payload: {} }),
      "kind-not-allowed",
    );
  });

  it("signer_k4_returnToOwningVault_allowed", async () => {
    const t = await harness();
    t.state.balances = { ...t.state.balances, usdc: 700n, native: 900n };
    await t.signer.sign("cz-15", {
      keyId: "K4",
      kind: "pocket-return",
      payload: { pocket: t.pocket, kind: "usdc", amount: "700" },
    });
    const call = decodeFunctionData({ abi: USDC_ABI, data: t.prepared[0]?.data as Hex });
    expect(call.args?.[0]?.toLowerCase()).toBe(VAULT);
    await t.signer.sign("cz-15", {
      keyId: "K4",
      kind: "pocket-return",
      payload: { pocket: t.pocket, kind: "native", amount: "900" },
    });
    expect(t.prepared[1]).toMatchObject({ to: VAULT, value: 900n, data: "0x" });
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K4",
        kind: "pocket-return",
        payload: { pocket: t.pocket, kind: "usdc", amount: "701" },
      }),
      "above-balance",
    );
  });

  it("allows a pocket return using live wallet balances when the Gateway figure is stale", async () => {
    const t = await harness();
    t.state.balances = {
      ...t.state.balances,
      usdc: 700n,
      gatewayApiFresh: false,
    };
    await t.signer.sign("cz-15", {
      keyId: "K4",
      kind: "pocket-return",
      payload: { pocket: t.pocket, kind: "usdc", amount: "700" },
    });
    const call = decodeFunctionData({ abi: USDC_ABI, data: t.prepared[0]?.data as Hex });
    expect(call.args?.[0]?.toLowerCase()).toBe(VAULT);
  });

  it("pocket-delegate names only the owning vault; slow withdraw needs the API-down or owner condition", async () => {
    const t = await harness();
    await t.signer.sign("cz-15", {
      keyId: "K4",
      kind: "pocket-delegate",
      payload: { pocket: t.pocket, vault: VAULT },
    });
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K4",
        kind: "pocket-delegate",
        payload: { pocket: t.pocket, vault: OTHER },
      }),
      "wrong-vault",
    );
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K4",
        kind: "pocket-slow-withdraw",
        payload: { pocket: t.pocket, step: "withdraw" },
      }),
      "slow-withdraw-not-allowed",
    );
    t.state.slowWithdrawAllowed = true;
    t.state.balances = { ...t.state.balances, gatewayApiFresh: false };
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K4",
        kind: "pocket-slow-withdraw",
        payload: { pocket: t.pocket, step: "initiate", value: "10" },
      }),
      "gateway-balance-stale",
    );
    t.state.balances = {
      ...t.state.balances,
      gatewayApiFresh: true,
      gatewayApi: 10n,
      gatewayAvailable: 10n,
    };
    await t.signer.sign("cz-15", {
      keyId: "K4",
      kind: "pocket-slow-withdraw",
      payload: { pocket: t.pocket, step: "initiate", value: "10" },
    });
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K4",
        kind: "pocket-slow-withdraw",
        payload: { pocket: t.pocket, step: "initiate" },
      }),
      "shape",
    );
    t.state.pocket = {
      ...(t.state.pocket as NonNullable<typeof t.state.pocket>),
      slowWithdrawalOpen: true,
    };
    await expectDenied(
      t,
      t.signer.sign("cz-15", {
        keyId: "K4",
        kind: "pocket-slow-withdraw",
        payload: { pocket: t.pocket, step: "initiate", value: "10" },
      }),
      "slow-withdrawal-open",
    );
  });
});

describe("relayer-tx and gas-refill (relayer)", () => {
  it("allows anyone-callable vault selectors and gatewayMint, nothing else", async () => {
    const t = await harness();
    await t.signer.sign("relayer", {
      keyId: "relayer",
      kind: "relayer-tx",
      payload: { to: VAULT, selector: "settle", args: { reservationId: "1", indices: ["0"] } },
    });
    await t.signer.sign("relayer", {
      keyId: "relayer",
      kind: "relayer-tx",
      payload: {
        to: "0x0022222abe238cc2c7bb1f21003f0a260052475b",
        selector: "gatewayMint",
        args: { attestationPayload: "0x01", signature: "0x02" },
      },
    });
    await expectDenied(
      t,
      t.signer.sign("relayer", {
        keyId: "relayer",
        kind: "relayer-tx",
        payload: { to: VAULT, selector: "reserve", args: {} },
      }),
      "selector-not-allowed",
    );
    await expectDenied(
      t,
      t.signer.sign("relayer", {
        keyId: "relayer",
        kind: "relayer-tx",
        payload: { to: VAULT, selector: "withdraw", args: {} },
      }),
      "selector-not-allowed",
    );
    await expectDenied(
      t,
      t.signer.sign("relayer", {
        keyId: "relayer",
        kind: "relayer-tx",
        payload: { to: OTHER, selector: "settle", args: {} },
      }),
      "target-not-allowed",
    );
  });

  it("signer_gasRefill_aboveMax_denied", async () => {
    const t = await harness();
    const k3 = t.address("K3");
    t.state.native.set(k3, 4_000_000n);
    await t.signer.sign("relayer", {
      keyId: "relayer",
      kind: "gas-refill",
      payload: { target: k3, amount: "1000000" },
    });
    await expectDenied(
      t,
      t.signer.sign("relayer", {
        keyId: "relayer",
        kind: "gas-refill",
        payload: { target: k3, amount: "1000001" },
      }),
      "above-max",
    );
    await expectDenied(
      t,
      t.signer.sign("relayer", {
        keyId: "relayer",
        kind: "gas-refill",
        payload: { target: t.address("K5"), amount: "1" },
      }),
      "target-not-allowed",
    );
  });
});
