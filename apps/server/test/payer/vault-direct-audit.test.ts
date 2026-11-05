// BR-03 / SCR-182 §5, test 10: the payer sends a `code-review` step's contract to the audit merchant
// exactly as planned, pays exactly the 402 price, and pays nothing when the probe fails or the 402 terms
// differ from the plan. Tests only: the payer is unchanged.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import {
  buildTree,
  NO_RESPONSE_COMMIT,
  PAYEE_KIND,
  payeeLeaf,
  paymentRefHash,
} from "@czar/hashing";
import type { StepResult } from "@czar/schemas";
import type { SignRequest, SignResult } from "@czar/signer";
import {
  buildPaymentRequired,
  encodeBase64Json,
  encodePaymentRequired,
  SafeFetchError,
} from "@czar/x402";
import {
  executeVaultDirectStep,
  type BoundaryInput,
  type VaultDirectChain,
  type VaultDirectDependencies,
  type VaultDirectInput,
} from "#src/payer/vault-direct";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const ENVELOPE_REF = "eip155:5042002:0x0000000000000000000000000000000000000001:1";
const VAULT = "0x0000000000000000000000000000000000000001" as const;
const PAYEE = "0x0000000000000000000000000000000000000002" as const;
const OTHER_PAYEE = "0x0000000000000000000000000000000000000003" as const;
const HASH = `0x${"01".repeat(32)}`;
const AUDIT_URL = "http://127.0.0.1:4021/v1/audit/quick";
const RESERVATION_ID = 9n;
const PRICE = 500_000n; // czar-audit-quick, SCR-182 §1
const STEP_CAP = PRICE;
const OFFER_TIMEOUT_SECONDS = 30;
const HTTP_OK = 200;
const HTTP_SERVER_ERROR = 500;
const MS_PER_SECOND = 1000;
const TREE = buildTree([payeeLeaf(PAYEE, PAYEE_KIND.X402_PAY_TO, 0, STEP_CAP)]);
// Quotes, a newline, non-ASCII text, replacement patterns and a template marker: nothing may be
// altered, escaped differently or expanded on the way to the merchant.
const CONTRACT = 'contract Vault {\n  string s = "$& $1 {{subject}}"; // Ünï ✓\n}';

/** What the merchant answers to the unpaid probe. */
type ProbeMode = "402" | "server-error" | "no-payment-required" | "transport-failure";

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly contentType: string | undefined;
  readonly body: string;
  readonly paid: boolean;
}

beforeAll(async () => seedDevice(getPool()));
beforeEach(async () => {
  for (const table of [
    "ranking_decisions",
    "results",
    "outbox_events",
    "executor_leases",
    "step_executions",
    "steps",
    "supplier_health",
    "observations",
    "plans",
    "objectives",
  ])
    await getPool().query(`DELETE FROM ${table}`);
  const submission = makeObjectiveSubmission(OBJECTIVE);
  await getPool().query(
    `INSERT INTO objectives
     (objective_id,user_id,device_id,submission,objective_hash,state,plan_id,envelope_ref)
     VALUES ($1,$2,$3,$4::jsonb,$5,'executing',$6,$7)`,
    [
      OBJECTIVE,
      TEST_USER_ID,
      submission.deviceId,
      JSON.stringify(submission),
      submission.objectiveHash,
      PLAN_ID,
      ENVELOPE_REF,
    ],
  );
  await getPool().query(
    `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES ($1,$2,'{}',$3,$4,'approved')`,
    [PLAN_ID, OBJECTIVE, HASH, HASH],
  );
  await getPool().query(
    "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,$2::jsonb,'queued')",
    [PLAN_ID, JSON.stringify({ payee: PAYEE })],
  );
});

describe("vault-direct pays an audit merchant (SCR-182 §5, test 10)", () => {
  it("sends the contract as the exact JSON body {contract}, to the merchant URL, on both requests", async () => {
    const run = auditRun();

    const result = await executeVaultDirectStep(stepInput(), run.dependencies);

    expect(result.state).toBe("done");
    expect(run.requests).toHaveLength(2);
    expect(run.requests.map((request) => request.paid)).toEqual([false, true]);
    for (const request of run.requests) {
      expect(request.url).toBe(AUDIT_URL);
      expect(request.method).toBe("POST");
      expect(request.contentType).toBe("application/json");
      expect(request.body).toBe(JSON.stringify({ contract: CONTRACT }));
      expect(Object.keys(JSON.parse(request.body))).toEqual(["contract"]);
    }
  });

  it("never puts the contract in the URL", async () => {
    const run = auditRun();
    await executeVaultDirectStep(stepInput(), run.dependencies);
    for (const request of run.requests) {
      expect(new URL(request.url).search).toBe("");
      expect(request.url).not.toContain(encodeURIComponent("contract Vault"));
    }
  });

  it("reserves and signs exactly the 402 price, to the 402 payee", async () => {
    const run = auditRun();

    await executeVaultDirectStep(stepInput(), run.dependencies);

    expect(run.chain.reserve).toHaveBeenCalledTimes(1);
    expect(run.chain.reserve.mock.calls[0]?.[0]).toMatchObject({
      count: 1,
      payee: PAYEE,
      unitAmount: PRICE,
    });
    const authorizations = run.sign.mock.calls.filter(
      ([, request]) => request.kind === "usdc-3009",
    );
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.[1]).toMatchObject({
      kind: "usdc-3009",
      payload: { to: PAYEE, value: PRICE.toString() },
    });
  });

  it("pays the 402 price when it is lower than the plan's, not the plan's figure", async () => {
    const lower = PRICE - 100_000n;
    const run = auditRun({ price: lower });

    await executeVaultDirectStep(stepInput(), run.dependencies);

    expect(run.chain.reserve.mock.calls[0]?.[0]).toMatchObject({ unitAmount: lower });
    const signed = run.sign.mock.calls.find(([, request]) => request.kind === "usdc-3009");
    expect(signed?.[1]).toMatchObject({ payload: { value: lower.toString() } });
  });

  it("files the observation under the smart-contract-audit task class (SCR-160 §9.1)", async () => {
    const run = auditRun();
    await executeVaultDirectStep(stepInput(), run.dependencies);
    const classes = await getPool().query<{ task_class: string }>(
      "SELECT DISTINCT task_class FROM observations WHERE objective_id=$1",
      [OBJECTIVE],
    );
    expect(classes.rows).toEqual([{ task_class: "smart-contract-audit" }]);
  });
});

describe("vault-direct pays nothing when the audit merchant's terms differ from the plan", () => {
  it("refuses a 402 price above the plan's cap for the call", async () => {
    const run = auditRun({ price: PRICE + 1n });
    const result = await executeVaultDirectStep(stepInput(), run.dependencies);
    expect(result).toMatchObject({ state: "failed", errorCode: "price-or-payee-drift" });
    expectNothingPaid(run);
  });

  it("refuses a 402 that names a different payee than the plan", async () => {
    const run = auditRun({ payTo: OTHER_PAYEE });
    const result = await executeVaultDirectStep(stepInput(), run.dependencies);
    expect(result).toMatchObject({ state: "failed", errorCode: "price-or-payee-drift" });
    expectNothingPaid(run);
  });

  it("refuses a 402 for a network the plan is not on", async () => {
    const run = auditRun({ network: "eip155:8453" });
    const result = await executeVaultDirectStep(stepInput(), run.dependencies);
    expect(result).toMatchObject({ state: "failed" });
    expectNothingPaid(run);
  });
});

describe("vault-direct pays nothing when the probe of the audit merchant fails", () => {
  it.each<[ProbeMode, string]>([
    ["server-error", "unsupported-offer"],
    ["no-payment-required", "unsupported-offer"],
  ])("answers %s -> %s, with no reservation, signature or paid request", async (probe, code) => {
    const run = auditRun({ probe });
    const result = await executeVaultDirectStep(stepInput(), run.dependencies);
    expect(result).toMatchObject({ state: "failed", errorCode: code });
    expect(run.chain.reserve).not.toHaveBeenCalled();
    expect(run.sign).not.toHaveBeenCalled();
    expect(run.requests.some((request) => request.paid)).toBe(false);
  });

  it("does not reserve or sign when the transport to the merchant fails", async () => {
    const run = auditRun({ probe: "transport-failure" });
    await executeVaultDirectStep(stepInput(), run.dependencies).catch(() => undefined);
    expect(run.chain.reserve).not.toHaveBeenCalled();
    expect(run.sign).not.toHaveBeenCalled();
    expect(run.requests.some((request) => request.paid)).toBe(false);
  });
});

function expectNothingPaid(run: ReturnType<typeof auditRun>): void {
  expect(run.chain.reserve).not.toHaveBeenCalled();
  expect(run.sign).not.toHaveBeenCalled();
  expect(run.requests.some((request) => request.paid)).toBe(false);
  expect(run.used.size).toBe(0);
}

function auditRun(
  options: {
    readonly probe?: ProbeMode;
    readonly price?: bigint;
    readonly payTo?: `0x${string}`;
    readonly network?: string;
  } = {},
) {
  let current = new Date("2026-10-21T00:00:00Z");
  const used = new Set<number>();
  const settled = new Set<number>();
  const requests: Recorded[] = [];
  let final = false;
  const sign = vi.fn(async (_caller: string, request: SignRequest): Promise<SignResult> => {
    if (request.kind === "usdc-3009")
      return { signature: `0x${"ab".repeat(65)}`, digest: HASH as `0x${string}` };
    return { signedTransaction: "0x1234" };
  });
  const chain = {
    stepUsed: vi.fn(async () => 0n),
    envelopeCapacity: vi.fn(async () => ({ cap: STEP_CAP, exposure: 0n })),
    latestBlockTimestamp: vi.fn(async () => BigInt(Math.floor(current.getTime() / MS_PER_SECOND))),
    transactionCount: vi.fn(async (_address: `0x${string}`) => 0),
    transactionStatus: vi.fn(
      async (_txHash: `0x${string}`): Promise<"success" | "reverted" | undefined> => undefined,
    ),
    reserve: vi.fn<VaultDirectChain["reserve"]>(async () => ({
      reservationId: RESERVATION_ID,
      txHash: HASH,
    })),
    settle: vi.fn<VaultDirectChain["settle"]>(async ({ indices }) => {
      for (const index of indices) settled.add(index);
      return HASH;
    }),
    authorizationState: vi.fn<VaultDirectChain["authorizationState"]>(async ({ index }) =>
      used.has(index),
    ),
    isSettled: vi.fn<VaultDirectChain["isSettled"]>(async ({ index }) => settled.has(index)),
    finalize: vi.fn<VaultDirectChain["finalize"]>(async () => {
      for (const index of used) settled.add(index);
      final = true;
      return { txHash: HASH, final: true };
    }),
    reservationFinal: vi.fn(async () => final),
  };
  const safeFetch = vi.fn(
    async (
      url: string,
      fetchOptions?: {
        method?: string;
        headers?: Record<string, string>;
        body?: Uint8Array;
      },
    ) => {
      const paid = fetchOptions?.headers?.["payment-signature"] !== undefined;
      requests.push({
        url,
        method: fetchOptions?.method ?? "GET",
        contentType: fetchOptions?.headers?.["content-type"],
        body: fetchOptions?.body ? new TextDecoder().decode(fetchOptions.body) : "",
        paid,
      });
      if (paid) {
        used.add(0);
        return {
          status: HTTP_OK,
          url,
          headers: {
            "content-type": "application/json",
            "payment-response": encodeBase64Json({
              success: true,
              transaction: HASH,
              network: "eip155:5042002",
            }),
          },
          body: new TextEncoder().encode('{"summary":"ok","findings":[]}'),
        };
      }
      const probe = options.probe ?? "402";
      if (probe === "transport-failure")
        throw new SafeFetchError("upstream-unavailable", "transport", "connection-reset");
      if (probe === "server-error")
        return { status: HTTP_SERVER_ERROR, url, headers: {}, body: new Uint8Array() };
      if (probe === "no-payment-required")
        return { status: HTTP_OK, url, headers: {}, body: new TextEncoder().encode("{}") };
      return paymentRequired(url, options);
    },
  );
  const dependencies: VaultDirectDependencies = {
    pool: getPool(),
    config: loadConfig(),
    signer: { sign },
    chain,
    safeFetch,
    now: () => current,
    // The payer polls chain time, so waiting must move the clock it reads.
    sleep: async (milliseconds) => {
      current = new Date(current.getTime() + milliseconds);
    },
    boundary: vi.fn(async (context: BoundaryInput) => boundaryResult(context)),
    noResponseBoundary: async (context) => ({
      schemaVersion: "1.1",
      stepIndex: 0,
      callIndex: context.index,
      obsId: context.obsId,
      status: "no-response",
      source: {
        origin: "http://127.0.0.1:4021",
        payTo: PAYEE,
        paymentRefHash: paymentRefHash(context.paymentRef),
      },
      fields: [],
      flags: [],
      bodyCommit: NO_RESPONSE_COMMIT,
    }),
    recordReceipt: vi.fn(async () => true),
    findExactTransferTx: async () => HASH,
    objects: { put: async () => "body-ref", get: async () => new Uint8Array() },
  };
  return { dependencies, chain, sign, requests, used };
}

function paymentRequired(
  url: string,
  options: { readonly price?: bigint; readonly payTo?: `0x${string}`; readonly network?: string },
) {
  const offer = buildPaymentRequired({
    url: AUDIT_URL,
    description: "Czar Lab Quick Audit. Run by Czar.",
    serviceName: "czar-audit-quick",
    tags: [],
    network: options.network ?? "eip155:5042002",
    amount: (options.price ?? PRICE).toString(),
    payTo: options.payTo ?? PAYEE,
    maxTimeoutSeconds: OFFER_TIMEOUT_SECONDS,
  });
  return {
    status: 402,
    url,
    headers: { "payment-required": encodePaymentRequired(offer) },
    body: new Uint8Array(),
  };
}

function boundaryResult(context: BoundaryInput): StepResult {
  const usable = context.response.status === HTTP_OK && context.response.body.byteLength > 0;
  return {
    schemaVersion: "1.1",
    stepIndex: 0,
    callIndex: context.index,
    obsId: context.obsId,
    status: usable ? "delivered" : "http-error",
    source: { origin: "http://127.0.0.1:4021", payTo: PAYEE, paymentRefHash: HASH },
    fields: usable ? [{ name: "summary", value: "ok", confidence: 1 }] : [],
    flags: [],
    bodyCommit: HASH,
  };
}

function stepInput(): VaultDirectInput {
  return {
    planId: PLAN_ID,
    envelopeRef: ENVELOPE_REF,
    envelopeId: 1n,
    envelopeExpiresAt: new Date("2026-10-22T00:00:00Z"),
    vault: VAULT,
    plan: {
      schemaVersion: "1.4",
      planId: PLAN_ID,
      objectiveId: OBJECTIVE,
      objectiveHash: HASH,
      planHash: HASH,
      network: "eip155:5042002",
      category: "research",
      cap: STEP_CAP.toString(),
      slackBps: 0,
      maxStepAmount: STEP_CAP.toString(),
      pocketCapBps: 0,
      expiresAt: "2026-10-22T00:00:00.000Z",
      steps: [],
      payeeLeaves: [{ payee: PAYEE, kind: 1, stepIndex: 0, stepCap: STEP_CAP.toString() }],
      payeeRoot: TREE.root,
      shadow: false,
      createdAt: "2026-10-21T00:00:00.000Z",
      taskSpec: {} as never,
    } as never,
    step: {
      stepIndex: 0,
      stepId: "stp_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
      kind: "x402-exact",
      capability: "code-review",
      serviceId: "svc_11111111111111111111111111111111",
      resource: { url: AUDIT_URL, method: "POST" },
      payee: PAYEE,
      unitAmount: PRICE.toString(),
      expectedCalls: 1,
      stepCap: STEP_CAP.toString(),
      routingReason: "vault-direct",
      acceptanceProfileId: "prof_11111111111111111111111111111111",
      callInputs: [{ callIndex: 0, input: { contract: CONTRACT } }],
    },
    userId: TEST_USER_ID,
    deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
  };
}
