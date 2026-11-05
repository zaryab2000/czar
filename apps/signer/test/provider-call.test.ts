// PM-058: the K21a/K21b test-provider keys and the `provider-call` kind, exactly as CZ-27 §5.1 (key row
// "K21a, K21b test-provider keys") and §5.2 (policy row `provider-call`) say:
//   - request `{escrow, jobId, action: setBudget | submit | brief-request | deliverable-upload, args}`
//   - `escrow` is the configured instance
//   - the job's `provider` is this key
//   - `submit` only with a `contentHash` already accepted by `uploadJobDeliverable`
//   - never signs for a job whose evaluator is not K7
//   - testnet only; never a vault role
// Every denial leaves the backend untouched and writes one `kms_denied` audit row naming its rule. The
// whole file is re-run against the Cloud KMS backend by `service-kms.test.ts`.
import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  parseAbi,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerializedEIP1559,
} from "viem";
import { loadConfig } from "@czar/config";
import {
  briefRequestDigest,
  deliverableUploadDigest,
  jobKey,
  type Address,
  type Hash32,
} from "@czar/hashing";
import { decide, KINDS, KEY_IDS, KEY_KINDS, type KeyId, type PolicyContext } from "../src/index.ts";
import { createPostgresProjection } from "../src/postgres-projection.ts";
import type { AuditQueryExecutor } from "../src/postgres-audit.ts";
import type { Projection } from "../src/projection.ts";
import { ESCROW, h, harness, NETWORK, NOW, OTHER, VAULT } from "./helpers.ts";

type H = Awaited<ReturnType<typeof harness>>;

const JOB_ID = 42n;
const JOB_KEY = jobKey(ESCROW, JOB_ID);
const CONTENT_HASH = h("5");
const ISSUED_AT = BigInt(NOW - 10);
const ESCROW_PROVIDER_ABI = parseAbi([
  "function setBudget(uint256 jobId, address token, uint256 amount, bytes optParams)",
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
]);

const ACTIONS = ["setBudget", "submit", "brief-request", "deliverable-upload"] as const;
type Action = (typeof ACTIONS)[number];

const ARGS: Readonly<Record<Action, Record<string, string>>> = {
  setBudget: { amount: "250000" },
  submit: { contentHash: CONTENT_HASH },
  "brief-request": { issuedAt: ISSUED_AT.toString() },
  "deliverable-upload": { contentHash: CONTENT_HASH, issuedAt: ISSUED_AT.toString() },
};

const payload = (action: Action, overrides: Record<string, unknown> = {}) => ({
  escrow: ESCROW,
  jobId: JOB_ID.toString(),
  action,
  args: ARGS[action],
  ...overrides,
});

/** A harness with both test-provider keys, a K7-evaluated job owned by `owner`, and an accepted upload. */
async function providerHarness(
  options: { owner?: "K21a" | "K21b"; config?: Record<string, unknown>; chainId?: number } = {},
) {
  const network =
    options.chainId === undefined
      ? NETWORK
      : {
          ...NETWORK,
          chainId: options.chainId,
          nanoDomain: { ...NETWORK.nanoDomain, chainId: options.chainId },
        };
  const t = await harness({
    providerKeys: true,
    network,
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  t.state.job = {
    evaluator: t.address("K7"),
    clientVault: VAULT,
    provider: t.address(options.owner ?? "K21a"),
  };
  t.state.deliverables.add(`${JOB_KEY}:${CONTENT_HASH}`);
  return t;
}

const CALLER: Readonly<Record<"K21a" | "K21b", string>> = {
  K21a: "czar-provider-a",
  K21b: "czar-provider-b",
};

const sign = (t: H, keyId: "K21a" | "K21b", body: unknown, caller = CALLER[keyId]) =>
  t.signer.sign(caller, { keyId, kind: "provider-call", payload: body });

async function expectDenied(t: H, promise: Promise<unknown>, rule: string) {
  const before = t.calls.length;
  await expect(promise).rejects.toMatchObject({ name: "Denied", rule });
  expect(t.calls.length).toBe(before);
  expect(t.audit.rows.at(-1)).toMatchObject({ outcome: "kms_denied", rule });
}

describe("provider-call (K21a, K21b)", () => {
  it("creates both test-provider keys on the harness backend", async () => {
    const t = await providerHarness();
    expect(t.backend.keyRefs()).toEqual(expect.arrayContaining(["K21a", "K21b"]));
    expect(t.address("K21a")).not.toBe(t.address("K21b"));
  });

  it("gives K21a and K21b the provider-call kind only", () => {
    expect(KEY_IDS).toEqual(expect.arrayContaining(["K21a", "K21b"]));
    expect(KINDS).toContain("provider-call");
    expect(KEY_KINDS.K21a).toEqual(["provider-call"]);
    expect(KEY_KINDS.K21b).toEqual(["provider-call"]);
    for (const keyId of KEY_IDS.filter((id) => id !== "K21a" && id !== "K21b"))
      expect(KEY_KINDS[keyId]).not.toContain("provider-call");
  });

  describe("each action signs for the key's own job", () => {
    for (const owner of ["K21a", "K21b"] as const) {
      it(`setBudget: ${owner} signs setBudget(jobId, USDC, amount, "") to the configured escrow`, async () => {
        const t = await providerHarness({ owner });
        const result = await sign(t, owner, payload("setBudget"));
        expect("signedTransaction" in result).toBe(true);
        const signed = (result as { signedTransaction: Hex }).signedTransaction;
        const tx = parseTransaction(signed);
        expect(tx.to?.toLowerCase()).toBe(ESCROW.toLowerCase());
        expect(tx.value ?? 0n).toBe(0n);
        expect(tx.chainId).toBe(NETWORK.chainId);
        const call = decodeFunctionData({ abi: ESCROW_PROVIDER_ABI, data: tx.data as Hex });
        expect(call.functionName).toBe("setBudget");
        expect(call.args).toEqual([JOB_ID, expect.any(String), 250000n, "0x"]);
        expect((call.args[1] as string).toLowerCase()).toBe(NETWORK.usdc.toLowerCase());
        const sender = await recoverTransactionAddress({
          serializedTransaction: signed as TransactionSerializedEIP1559,
        });
        expect(sender.toLowerCase()).toBe(t.address(owner).toLowerCase());
        expect(t.calls).toEqual([`tx:${owner}`]);
        expect(t.audit.rows.at(-1)).toMatchObject({
          outcome: "signed",
          keyRef: owner,
          kind: "provider-call",
          purpose: { jobKey: JOB_KEY },
        });
      });
    }

    it('submit: signs submit(jobId, contentHash, "") for an accepted upload', async () => {
      const t = await providerHarness();
      const result = await sign(t, "K21a", payload("submit"));
      const signed = (result as { signedTransaction: Hex }).signedTransaction;
      const tx = parseTransaction(signed);
      expect(tx.to?.toLowerCase()).toBe(ESCROW.toLowerCase());
      const call = decodeFunctionData({ abi: ESCROW_PROVIDER_ABI, data: tx.data as Hex });
      expect(call.functionName).toBe("submit");
      expect(call.args).toEqual([JOB_ID, CONTENT_HASH, "0x"]);
      const sender = await recoverTransactionAddress({
        serializedTransaction: signed as TransactionSerializedEIP1559,
      });
      expect(sender.toLowerCase()).toBe(t.address("K21a").toLowerCase());
      expect(t.audit.rows.at(-1)).toMatchObject({
        outcome: "signed",
        keyRef: "K21a",
        purpose: { jobKey: JOB_KEY },
      });
    });

    it("brief-request: signs the BriefRequest digest for jobKey(escrow, jobId)", async () => {
      const t = await providerHarness();
      const result = await sign(t, "K21a", payload("brief-request"));
      const expected = briefRequestDigest(NETWORK.chainId, {
        jobKey: JOB_KEY,
        issuedAt: ISSUED_AT,
      });
      expect(result).toMatchObject({ digest: expected });
      const { signature } = result as { signature: Hex; digest: Hash32 };
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
      const signer = await recoverAddress({ hash: expected, signature });
      expect(signer.toLowerCase()).toBe(t.address("K21a").toLowerCase());
      expect(t.calls).toEqual(["digest:K21a"]);
      expect(t.audit.rows.at(-1)).toMatchObject({
        outcome: "signed",
        keyRef: "K21a",
        digest: expected,
        purpose: { jobKey: JOB_KEY },
      });
    });

    it("deliverable-upload: signs the DeliverableUpload digest for jobKey(escrow, jobId)", async () => {
      const t = await providerHarness({ owner: "K21b" });
      const result = await sign(t, "K21b", payload("deliverable-upload"));
      const expected = deliverableUploadDigest(NETWORK.chainId, {
        jobKey: JOB_KEY,
        contentHash: CONTENT_HASH,
        issuedAt: ISSUED_AT,
      });
      expect(result).toMatchObject({ digest: expected });
      const { signature } = result as { signature: Hex; digest: Hash32 };
      const signer = await recoverAddress({ hash: expected, signature });
      expect(signer.toLowerCase()).toBe(t.address("K21b").toLowerCase());
      expect(t.audit.rows.at(-1)).toMatchObject({ outcome: "signed", keyRef: "K21b" });
    });

    it("deliverable-upload signs before the upload exists (the upload is what makes it accepted)", async () => {
      const t = await providerHarness();
      t.state.deliverables.clear();
      await sign(t, "K21a", payload("deliverable-upload"));
      expect(t.audit.rows.at(-1)).toMatchObject({ outcome: "signed" });
    });
  });

  it("wrong escrow → kms_denied unknown-escrow, for every action", async () => {
    const t = await providerHarness();
    for (const action of ACTIONS)
      await expectDenied(t, sign(t, "K21a", payload(action, { escrow: OTHER })), "unknown-escrow");
    expect(t.calls).toEqual([]);
  });

  it("a job the projection does not know → kms_denied unknown-job", async () => {
    const t = await providerHarness();
    t.state.job = undefined;
    for (const action of ACTIONS)
      await expectDenied(t, sign(t, "K21a", payload(action)), "unknown-job");
  });

  it("another provider's job → kms_denied not-job-provider, for every action", async () => {
    const t = await providerHarness();
    t.state.job = { evaluator: t.address("K7"), clientVault: VAULT, provider: OTHER };
    for (const action of ACTIONS)
      await expectDenied(t, sign(t, "K21a", payload(action)), "not-job-provider");
    expect(t.calls).toEqual([]);
  });

  it("K21a signing for a K21b job → kms_denied not-job-provider (and the reverse)", async () => {
    const t = await providerHarness({ owner: "K21b" });
    for (const action of ACTIONS)
      await expectDenied(t, sign(t, "K21a", payload(action)), "not-job-provider");
    t.state.job = { evaluator: t.address("K7"), clientVault: VAULT, provider: t.address("K21a") };
    for (const action of ACTIONS)
      await expectDenied(t, sign(t, "K21b", payload(action)), "not-job-provider");
    expect(t.calls).toEqual([]);
  });

  it("an evaluator other than K7 → kms_denied evaluator-not-k7, for every action", async () => {
    const t = await providerHarness();
    for (const evaluator of [OTHER, t.address("K21a"), t.address("K3")]) {
      t.state.job = { evaluator, clientVault: VAULT, provider: t.address("K21a") };
      for (const action of ACTIONS)
        await expectDenied(t, sign(t, "K21a", payload(action)), "evaluator-not-k7");
    }
    expect(t.calls).toEqual([]);
  });

  it("submit with a content hash not accepted by uploadJobDeliverable → kms_denied deliverable-not-accepted", async () => {
    const t = await providerHarness();
    await expectDenied(
      t,
      sign(t, "K21a", payload("submit", { args: { contentHash: h("6") } })),
      "deliverable-not-accepted",
    );
    // The same hash accepted for another job does not count for this one.
    t.state.deliverables.clear();
    t.state.deliverables.add(`${jobKey(ESCROW, JOB_ID + 1n)}:${CONTENT_HASH}`);
    await expectDenied(t, sign(t, "K21a", payload("submit")), "deliverable-not-accepted");
    // A zero hash is never an accepted upload.
    await expectDenied(
      t,
      sign(t, "K21a", payload("submit", { args: { contentHash: h("0") } })),
      "deliverable-not-accepted",
    );
    expect(t.calls).toEqual([]);
  });

  it("a projection without the accepted-upload read denies every submit (fail closed)", async () => {
    // A projection built before PM-058 has no such method; `undefined` stands in for the missing one.
    const withoutRead = { deliverableAccepted: undefined } as unknown as Partial<Projection>;
    const t = await harness({ providerKeys: true, projection: withoutRead });
    t.state.job = { evaluator: t.address("K7"), clientVault: VAULT, provider: t.address("K21a") };
    t.state.deliverables.add(`${JOB_KEY}:${CONTENT_HASH}`);
    await expectDenied(t, sign(t, "K21a", payload("submit")), "deliverable-not-accepted");
    expect(t.calls).toEqual([]);
  });

  it("the policy refuses provider-call without a K21 signing key (decide called directly)", async () => {
    const t = await providerHarness();
    const ctx = {
      projection: {
        job: async () => ({
          evaluator: t.address("K7"),
          clientVault: VAULT,
          provider: t.address("K21a"),
        }),
      },
      network: NETWORK,
      now: () => NOW,
      keyAddress: (key: string) => t.address(key),
    } as unknown as PolicyContext;
    const req = {
      escrow: ESCROW,
      jobId: JOB_ID,
      action: "brief-request",
      args: { issuedAt: ISSUED_AT },
    };
    await expect(decide(ctx, "provider-call", req)).rejects.toMatchObject({
      rule: "kind-not-allowed",
    });
    await expect(
      decide(ctx, "provider-call", req, { keyId: "K7", address: t.address("K21a") }),
    ).rejects.toMatchObject({ rule: "kind-not-allowed" });
    await expect(
      decide(ctx, "provider-call", req, { keyId: "K21a", address: t.address("K21a") }),
    ).resolves.toMatchObject({ type: "digest", purpose: { jobKey: JOB_KEY } });
  });

  it("any other kind with K21a or K21b → kms_denied kind-not-allowed", async () => {
    const t = await providerHarness();
    for (const keyId of ["K21a", "K21b"] as const)
      for (const kind of KINDS.filter((k) => k !== "provider-call")) {
        await expectDenied(
          t,
          t.signer.sign(CALLER[keyId], { keyId, kind, payload: {} }),
          "kind-not-allowed",
        );
      }
    expect(t.calls).toEqual([]);
  });

  it("provider-call with any other key → kms_denied (never another key's kind)", async () => {
    const t = await providerHarness();
    const owners: Readonly<Record<string, string>> = {
      K3: "cz-15",
      K4: "cz-15",
      K5: "cz-24",
      K7: "cz-16",
      K8: "cz-17",
      K10: "cz-20",
      relayer: "relayer",
    };
    for (const [keyId, caller] of Object.entries(owners))
      await expectDenied(
        t,
        t.signer.sign(caller, {
          keyId: keyId as KeyId,
          kind: "provider-call",
          payload: payload("setBudget"),
        }),
        "kind-not-allowed",
      );
    // K6 and K20 are interactive-only and refused before the kind check.
    await expectDenied(
      t,
      t.signer.sign("ops", { keyId: "K6", kind: "provider-call", payload: payload("setBudget") }),
      "interactive-only",
    );
    expect(t.calls).toEqual([]);
  });

  it("only the owning provider instance may use its key", async () => {
    const t = await providerHarness();
    await expectDenied(
      t,
      sign(t, "K21a", payload("setBudget"), "czar-provider-b"),
      "caller-not-owner",
    );
    await expectDenied(t, sign(t, "K21a", payload("setBudget"), "cz-20"), "caller-not-owner");
    await expectDenied(t, sign(t, "K21a", payload("setBudget"), "cz-16"), "caller-not-owner");
  });

  it("a mainnet chain → kms_denied testnet-only, for every action", async () => {
    for (const chainId of [1, 8453, 5042001]) {
      const t = await providerHarness({ chainId });
      for (const action of ACTIONS)
        await expectDenied(t, sign(t, "K21a", payload(action)), "testnet-only");
      expect(t.calls).toEqual([]);
    }
  });

  it("the local arc-anvil chain (31337) counts as a test chain, as in @czar/config", async () => {
    const t = await providerHarness({ chainId: 31337 });
    await sign(t, "K21a", payload("setBudget"));
    expect(t.audit.rows.at(-1)).toMatchObject({ outcome: "signed" });
  });

  it("refuses malformed requests before any projection read (shape)", async () => {
    const t = await providerHarness();
    let reads = 0;
    const original = t.state.job;
    Object.defineProperty(t.state, "job", {
      get: () => {
        reads += 1;
        return original;
      },
      set: () => undefined,
      configurable: true,
    });
    const bad: unknown[] = [
      { ...payload("setBudget"), extra: "1" },
      { ...payload("setBudget"), action: "complete" },
      { ...payload("setBudget"), action: "setbudget" },
      payload("setBudget", { args: { amount: "1", token: NETWORK.usdc } }),
      payload("setBudget", { args: { amount: "1", optParams: "0x01" } }),
      payload("setBudget", { args: {} }),
      payload("setBudget", { args: { amount: "-1" } }),
      payload("setBudget", { args: { amount: "1.5" } }),
      payload("submit", { args: { contentHash: CONTENT_HASH, optParams: "0x" } }),
      payload("submit", { args: { issuedAt: ISSUED_AT.toString() } }),
      payload("brief-request", { args: { issuedAt: ISSUED_AT.toString(), jobKey: JOB_KEY } }),
      payload("brief-request", { args: { issuedAt: (1n << 64n).toString() } }),
      payload("deliverable-upload", { args: { contentHash: CONTENT_HASH } }),
      payload("deliverable-upload", { args: { contentHash: "0x05", issuedAt: "1" } }),
      payload("submit", { args: "0x" }),
      { escrow: ESCROW, jobId: JOB_ID.toString(), action: "submit" },
      { escrow: ESCROW, action: "submit", args: ARGS.submit },
    ];
    for (const body of bad) await expectDenied(t, sign(t, "K21a", body), "shape");
    expect(reads).toBe(0);
    expect(t.calls).toEqual([]);
  });

  it("enforces the per-key rate limit kms.maxSignaturesPerMin.K21a, separately from K21b", async () => {
    const defaults = loadConfig();
    expect(defaults.get("kms.maxSignaturesPerMin.K21a")).toBe(60);
    expect(defaults.get("kms.maxSignaturesPerMin.K21b")).toBe(60);
    const t = await providerHarness({
      config: { "kms.maxSignaturesPerMin.K21a": 2, "kms.maxSignaturesPerMin.K21b": 1 },
    });
    await sign(t, "K21a", payload("brief-request"));
    await sign(t, "K21a", payload("setBudget"));
    await expectDenied(t, sign(t, "K21a", payload("submit")), "rate-limit");
    expect(t.calls).toEqual(["digest:K21a", "tx:K21a"]);
    // K21b has its own window.
    t.state.job = { evaluator: t.address("K7"), clientVault: VAULT, provider: t.address("K21b") };
    await sign(t, "K21b", payload("brief-request"));
    await expectDenied(t, sign(t, "K21b", payload("brief-request")), "rate-limit");
    t.advance(60_000);
    t.state.job = { evaluator: t.address("K7"), clientVault: VAULT, provider: t.address("K21a") };
    await sign(t, "K21a", payload("submit"));
    expect(t.audit.rows.at(-1)).toMatchObject({ outcome: "signed", keyRef: "K21a" });
  });

  it("a denied request does not use a rate-limit slot", async () => {
    const t = await providerHarness({ config: { "kms.maxSignaturesPerMin.K21a": 1 } });
    await expectDenied(
      t,
      sign(t, "K21a", payload("setBudget", { escrow: OTHER })),
      "unknown-escrow",
    );
    await sign(t, "K21a", payload("setBudget"));
    expect(t.audit.rows.at(-1)).toMatchObject({ outcome: "signed" });
  });

  it("audit rows carry ids only: no amount, no content, no key material", async () => {
    const t = await providerHarness();
    await sign(t, "K21a", payload("setBudget"));
    await expectDenied(
      t,
      sign(t, "K21a", payload("submit", { args: { contentHash: h("6") } })),
      "deliverable-not-accepted",
    );
    for (const row of t.audit.rows) {
      expect(Object.keys(row).toSorted()).toEqual(
        expect.arrayContaining(["at", "caller", "keyRef", "kind", "outcome", "purpose"]),
      );
      expect(Object.keys(row.purpose)).toEqual(row.outcome === "signed" ? ["jobKey"] : []);
      const text = JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      expect(text).not.toContain("250000");
      expect(row.keyRef).toBe("K21a");
    }
  });
});

/** The Postgres projection over a fake query executor that answers with `rows` and records each query. */
function projectionWith(rows: (query: string, values: unknown[]) => Record<string, unknown>[]) {
  const calls: { query: string; values: unknown[] }[] = [];
  const database: AuditQueryExecutor = {
    async query(query: string, values?: unknown[]) {
      calls.push({ query, values: values ?? [] });
      return { rows: rows(query, values ?? []) };
    },
  } as AuditQueryExecutor;
  const projection = createPostgresProjection({
    config: loadConfig(),
    database,
    chain: {} as never,
    factory: "0x00000000000000000000000000000000000000a2",
  });
  return { projection, calls };
}

describe("provider-call projection reads (Postgres)", () => {
  const providerAddress = "0x00000000000000000000000000000000000000c1" as Address;
  const evaluatorAddress = "0x00000000000000000000000000000000000000c7" as Address;

  it("job() returns the provider from the indexer's job mirror", async () => {
    const { projection, calls } = projectionWith(() => [
      {
        mirror: {
          vault: VAULT,
          provider: providerAddress,
          evaluator: evaluatorAddress,
          jobId: "42",
        },
      },
    ]);
    await expect(projection.job(ESCROW, JOB_ID)).resolves.toEqual({
      evaluator: evaluatorAddress,
      clientVault: VAULT,
      provider: providerAddress,
    });
    expect(calls[0]?.query).toContain("FROM jobs");
    expect(calls[0]?.values).toEqual([ESCROW, "42"]);
  });

  it("deliverableAccepted() reads payer_job_deliverables by job key and content hash", async () => {
    const { projection, calls } = projectionWith((_query, values) =>
      values[0] === JOB_KEY && values[1] === CONTENT_HASH ? [{ "?column?": 1 }] : [],
    );
    const accepted = projection.deliverableAccepted;
    expect(accepted).toBeDefined();
    await expect(accepted?.(JOB_KEY, CONTENT_HASH)).resolves.toBe(true);
    await expect(accepted?.(JOB_KEY, h("6"))).resolves.toBe(false);
    expect(calls[0]?.query).toContain("FROM payer_job_deliverables");
    expect(calls[0]?.query).toContain("lower(job_key)=lower($1)");
    expect(calls[0]?.query).toContain("lower(content_hash)=lower($2)");
  });
});
