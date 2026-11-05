// PM-024: fail-closed audit of the cloud signer's `Projection` (CZ-27 §5.2, D72, SCR-170 §3, §5).
// Three layers, tests only:
//   1. every `Projection` method, built by `createPostgresProjection`, REJECTS when the RPC or the
//      database it reads is unreachable (the table is missing, the node is down);
//   2. malformed or unrecognised data makes the projection throw, and stale or absent data comes back as
//      the denying value (`gatewayApiFresh: false`, `undefined`, an old `observedAt`);
//   3. through the real signer service, each such failure ends with a refused request, a `backend-error`
//      audit row and an untouched backend.
import type { Address, Hash32 } from "@czar/hashing";
import { paymentRefHash } from "@czar/hashing";
import type { PaymentRef } from "@czar/schemas";
import { loadConfig } from "@czar/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditQueryExecutor } from "../src/postgres-audit.ts";
import { createPostgresProjection } from "../src/postgres-projection.ts";
import type { Projection } from "../src/projection.ts";
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

const factory = "0x00000000000000000000000000000000000000a2" as Address;
const pocketAddress = "0x00000000000000000000000000000000000000b2" as Address;
const planHash = `0x${"ab".repeat(32)}` as Hash32;
const config = loadConfig();
const RPC_DOWN = "rpc unreachable";
const MISSING_TABLE = 'relation "indexer_table" does not exist';

type Row = Record<string, unknown>;
type QueryHandler = (sql: string, values: readonly unknown[]) => readonly Row[];

const deadChain = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error(RPC_DOWN);
    },
  },
) as never;

const deadDatabase: AuditQueryExecutor = {
  async query() {
    throw Object.assign(new Error(MISSING_TABLE), { code: "42P01" });
  },
};

function database(handler: QueryHandler = () => []): AuditQueryExecutor {
  return {
    async query(sql, values = []) {
      return { rows: handler(sql, values) };
    },
  };
}

/** A database that holds a Funded pocket and no other row. */
const pocketDatabase = database((sql) =>
  sql.includes("FROM pockets")
    ? [
        {
          vault: VAULT,
          mirror: { envelopeId: "1", state: "Funded", funded: "5000", pendingPullback: "0" },
        },
      ]
    : [],
);

interface ChainOverrides {
  readonly timestamp?: bigint;
  readonly read?: (functionName: string) => unknown;
  readonly [method: string]: unknown;
}

/** A healthy node: head block at `timestamp`, every contract read answers `read` or a zero value. */
function chain(overrides: ChainOverrides = {}) {
  const { timestamp = BigInt(NOW), read, ...methods } = overrides;
  return {
    async getBlock() {
      return { timestamp };
    },
    async getBlockNumber() {
      return 12n;
    },
    async getBalance() {
      return 100n;
    },
    async getTransactionReceipt() {
      throw new Error("no receipt");
    },
    async readContract({ functionName }: { functionName: string }) {
      if (read !== undefined) return read(functionName);
      if (["withdrawingBalance", "withdrawalBlock", "balanceOf"].includes(functionName)) return 0n;
      return false;
    },
    ...methods,
  } as never;
}

function projectionOver(source: { chain?: never; database?: AuditQueryExecutor }): Projection {
  return createPostgresProjection({
    config,
    database: source.database ?? database(),
    chain: source.chain ?? chain(),
    factory,
  });
}

const x402: PaymentRef = {
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
const gatewayBatched: PaymentRef = {
  schemaVersion: "1.0",
  rail: "gateway-batched",
  network: "eip155:5042002",
  payer: pocketAddress,
  payTo: PAYEE,
  amount: "1000",
  nonce: h("2"),
};
const erc8183: PaymentRef = {
  schemaVersion: "1.0",
  rail: "erc8183-job",
  network: "eip155:5042002",
  contract: ESCROW,
  jobId: "9",
  provider: PAYEE,
  client: VAULT,
  budget: "1000",
} as PaymentRef;

interface MethodCase {
  /** The `Projection` method, or a labelled variant of it. */
  readonly label: string;
  readonly method: keyof Projection;
  /** Each source listed here is taken down on its own; the call must reject every time. */
  readonly sources: readonly ("chain" | "database")[];
  readonly call: (projection: Projection) => Promise<unknown>;
  /** The healthy database to use while only the chain is down, when `[]` rows would end the call early. */
  readonly healthyDatabase?: AuditQueryExecutor;
}

const CASES: readonly MethodCase[] = [
  {
    label: "freezeState",
    method: "freezeState",
    sources: ["chain"],
    call: (p) => p.freezeState(VAULT),
  },
  { label: "isVault", method: "isVault", sources: ["chain"], call: (p) => p.isVault(VAULT) },
  {
    label: "reservation",
    method: "reservation",
    sources: ["chain"],
    call: (p) => p.reservation(VAULT, 1n),
  },
  {
    label: "pullback",
    method: "pullback",
    sources: ["chain"],
    call: (p) => p.pullback(VAULT, 1n),
  },
  { label: "blockNumber", method: "blockNumber", sources: ["chain"], call: (p) => p.blockNumber() },
  {
    label: "autonomy",
    method: "autonomy",
    sources: ["chain"],
    call: (p) => p.autonomy(VAULT, planHash),
  },
  {
    label: "nativeBalance",
    method: "nativeBalance",
    sources: ["chain"],
    call: (p) => p.nativeBalance(PAYEE),
  },
  {
    label: "envelope",
    method: "envelope",
    sources: ["database"],
    call: (p) => p.envelope(VAULT, 4n),
  },
  {
    label: "pocket",
    method: "pocket",
    sources: ["database", "chain"],
    call: (p) => p.pocket(pocketAddress),
    healthyDatabase: pocketDatabase,
  },
  {
    label: "pocketBalances",
    method: "pocketBalances",
    sources: ["database", "chain"],
    call: (p) => p.pocketBalances(pocketAddress),
  },
  {
    label: "nanoSpent",
    method: "nanoSpent",
    sources: ["database"],
    call: (p) => p.nanoSpent(pocketAddress, PAYEE),
  },
  {
    label: "settledPayment (x402-exact)",
    method: "settledPayment",
    sources: ["database"],
    call: (p) => p.settledPayment(VAULT, x402),
  },
  {
    label: "settledPayment (gateway-batched)",
    method: "settledPayment",
    sources: ["database"],
    call: (p) => p.settledPayment(VAULT, gatewayBatched),
  },
  {
    label: "settledPayment (erc8183-job)",
    method: "settledPayment",
    sources: ["database"],
    call: (p) => p.settledPayment(VAULT, erc8183),
  },
  {
    label: "storedPlan",
    method: "storedPlan",
    sources: ["database"],
    call: (p) => p.storedPlan(VAULT, planHash),
  },
  { label: "job", method: "job", sources: ["database"], call: (p) => p.job(ESCROW, 5n) },
  {
    label: "reportExists",
    method: "reportExists",
    sources: ["database"],
    call: (p) => p.reportExists(planHash),
  },
  {
    label: "checksCommitExists",
    method: "checksCommitExists",
    sources: ["database"],
    call: (p) => p.checksCommitExists(planHash),
  },
  {
    label: "latestEvidenceRoot",
    method: "latestEvidenceRoot",
    sources: ["database"],
    call: (p) => p.latestEvidenceRoot(OTHER, 0),
  },
  {
    label: "evidenceBatchExists",
    method: "evidenceBatchExists",
    sources: ["database"],
    call: (p) => p.evidenceBatchExists(planHash),
  },
  {
    label: "slowWithdrawTrigger",
    method: "slowWithdrawTrigger",
    sources: ["database", "chain"],
    call: (p) => p.slowWithdrawTrigger(pocketAddress),
  },
  {
    label: "pocketSpendAfterObservation",
    method: "pocketSpendAfterObservation",
    sources: ["database"],
    call: (p) => p.pocketSpendAfterObservation(pocketAddress, NOW * 1000),
  },
  {
    label: "overdueManualReturnFacts",
    method: "overdueManualReturnFacts",
    sources: ["database", "chain"],
    call: (p) =>
      (p.overdueManualReturnFacts as NonNullable<Projection["overdueManualReturnFacts"]>)(
        pocketAddress,
        VAULT,
        NOW,
      ),
  },
];

const pocketReads = (name: string) => {
  if (name === "getPocket") return { envelopeId: 7n, state: 2, pendingPullback: 0n };
  if (name === "getEnvelope") return { state: 1 };
  return 0n;
};

const withPlan = (plan: unknown) =>
  projectionOver({
    database: database((sql) => {
      if (sql.includes("SELECT mirror FROM envelopes"))
        return [{ mirror: { state: "Open", planHash } }];
      if (sql.includes("SELECT plan FROM plans")) return [{ plan }];
      return [];
    }),
  });

const approvalFor = async (state: string, objectiveState: string) =>
  (
    await projectionOver({
      database: database(() => [
        {
          plan: {
            planHash,
            payeeRoot: planHash,
            objectiveHash: planHash,
            category: "research",
            cap: "1",
            maxStepAmount: "1",
            pocketCapBps: 0,
            expiresAt: "1",
            steps: [],
          },
          state,
          objective_state: objectiveState,
        },
      ]),
    }).storedPlan(VAULT, planHash)
  )?.approval;

const factsWith = (overrides: ChainOverrides, handler: QueryHandler) =>
  (
    projectionOver({
      chain: chain({ read: pocketReads, ...overrides }),
      database: database(handler),
    }).overdueManualReturnFacts as NonNullable<Projection["overdueManualReturnFacts"]>
  )(pocketAddress, VAULT, NOW);

describe("layer 1: every Projection method rejects when its source is unreachable", () => {
  it("covers every method the Postgres projection exposes", () => {
    const exposed = Object.keys(projectionOver({})).toSorted();
    const covered = [...new Set(CASES.map((item) => item.method))].toSorted();
    expect(covered).toEqual(exposed);
  });

  for (const item of CASES) {
    for (const source of item.sources) {
      it(`${item.label}: rejects when the ${source === "chain" ? "RPC" : "database"} is down`, async () => {
        const projection =
          source === "chain"
            ? projectionOver({
                chain: deadChain,
                ...(item.healthyDatabase === undefined ? {} : { database: item.healthyDatabase }),
              })
            : projectionOver({ database: deadDatabase });
        await expect(item.call(projection)).rejects.toThrow(
          source === "chain" ? RPC_DOWN : MISSING_TABLE,
        );
      });
    }
  }

  it("settledPayment: the mpp rail is never settled, with no source read", async () => {
    const projection = projectionOver({ chain: deadChain, database: deadDatabase });
    const mpp = {
      schemaVersion: "1.0",
      rail: "mpp",
      network: "eip155:5042002",
    } as unknown as PaymentRef;
    await expect(projection.settledPayment(VAULT, mpp)).resolves.toBe(false);
  });
});

describe("layer 2: malformed or unrecognised data throws; stale or absent data denies", () => {
  it("throws on an on-chain reservation or pullback state it does not know", async () => {
    const reservation = projectionOver({
      chain: chain({ read: () => ({ state: 9, envelopeId: 1n }) }),
    });
    await expect(reservation.reservation(VAULT, 1n)).rejects.toThrow("unsupported on-chain enum");
    const pullback = projectionOver({ chain: chain({ read: () => ({ state: 9 }) }) });
    await expect(pullback.pullback(VAULT, 1n)).rejects.toThrow("unsupported on-chain enum");
  });

  it("returns undefined for an unused reservation, pullback and a category without a limit", async () => {
    const projection = projectionOver({
      chain: chain({ read: (name) => (name === "getLimits" ? { userMax: 0n } : { state: 0 }) }),
    });
    await expect(projection.reservation(VAULT, 1n)).resolves.toBeUndefined();
    await expect(projection.pullback(VAULT, 1n)).resolves.toBeUndefined();
    await expect(projection.autonomy(VAULT, planHash)).resolves.toBeUndefined();
  });

  it("throws on an indexed pocket state it does not know and on a malformed mirror", async () => {
    const unknownState = projectionOver({
      database: database((sql) =>
        sql.includes("FROM pockets")
          ? [{ vault: VAULT, mirror: { envelopeId: "1", state: "Reopened", funded: "0" } }]
          : [],
      ),
    });
    await expect(unknownState.pocket(pocketAddress)).rejects.toThrow("unsupported indexed pocket");
    const malformed = projectionOver({
      database: database((sql) =>
        sql.includes("FROM pockets") ? [{ vault: VAULT, mirror: "{not json" }] : [],
      ),
    });
    await expect(malformed.pocket(pocketAddress)).rejects.toThrow();
    const notAnObject = projectionOver({
      database: database((sql) =>
        sql.includes("FROM pockets") ? [{ vault: VAULT, mirror: [] }] : [],
      ),
    });
    await expect(notAnObject.pocket(pocketAddress)).rejects.toThrow("malformed JSON");
  });

  it("throws on an indexed envelope whose plan is malformed or names a missing step", async () => {
    await expect(withPlan("{not json").envelope(VAULT, 4n)).rejects.toThrow();
    await expect(
      withPlan({
        steps: [],
        payeeLeaves: [{ stepIndex: 3, payee: PAYEE, kind: 1, stepCap: "5" }],
      }).envelope(VAULT, 4n),
    ).rejects.toThrow("missing step 3");
    await expect(
      withPlan({ steps: [], payeeLeaves: [] }).envelope(VAULT, 4n),
    ).resolves.toMatchObject({ state: "Open", leaves: [] });
  });

  it("returns an envelope as Closed for any state but Open, and undefined for an unindexed one", async () => {
    const closed = projectionOver({
      database: database((sql) => {
        if (sql.includes("SELECT mirror FROM envelopes"))
          return [{ mirror: { state: "Opening", planHash } }];
        if (sql.includes("SELECT plan FROM plans"))
          return [{ plan: { steps: [], payeeLeaves: [] } }];
        return [];
      }),
    });
    await expect(closed.envelope(VAULT, 4n)).resolves.toMatchObject({ state: "Closed" });
    await expect(projectionOver({}).envelope(VAULT, 4n)).resolves.toBeUndefined();
  });

  it("throws on a stored plan whose JSON is malformed", async () => {
    const projection = projectionOver({
      database: database(() => [
        { plan: "{not json", state: "offered", objective_state: "opening" },
      ]),
    });
    await expect(projection.storedPlan(VAULT, planHash)).rejects.toThrow();
  });

  it("never treats a stored plan as auto-approvable unless it is offered while the objective opens", async () => {
    await expect(approvalFor("offered", "opening")).resolves.toBe("auto-approvable");
    await expect(approvalFor("offered", "awaiting-approval")).resolves.toBe("needs-approval");
    await expect(approvalFor("draft", "opening")).resolves.toBe("needs-approval");
    await expect(approvalFor("superseded", "opening")).resolves.toBe("needs-approval");
    await expect(approvalFor("approved", "executing")).resolves.toBe("owner-approved");
  });

  describe("the Gateway API figure is fresh only when recent, error-free and not from the future", () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    const maxAgeMs = Number(config.get("indexer.gatewayBalanceMaxAgeSeconds")) * 1000;
    const now = Date.parse("2026-11-05T12:00:00.000Z");
    const balancesWith = async (row: Row | undefined) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const projection = projectionOver({
        chain: chain(),
        database: database((sql) =>
          sql.includes("FROM pocket_balances") && row !== undefined ? [row] : [],
        ),
      });
      return projection.pocketBalances(pocketAddress);
    };
    const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();

    it("is fresh at exactly the maximum age with no failures", async () => {
      await expect(
        balancesWith({
          gateway_available_atomic: "7",
          api_observed_at: at(-maxAgeMs),
          api_consecutive_failures: 0,
        }),
      ).resolves.toMatchObject({ gatewayApiFresh: true, gatewayAvailable: 7n });
    });

    it.each([
      ["one millisecond past the maximum age", { api_observed_at: at(-maxAgeMs - 1) }],
      ["a failure count above zero", { api_consecutive_failures: 1 }],
      ["an observation time in the future", { api_observed_at: at(1_000) }],
      ["an unparseable observation time", { api_observed_at: "yesterday-ish" }],
      ["no observation time", { api_observed_at: null }],
      ["no failure count", { api_consecutive_failures: undefined }],
    ])("is stale with %s", async (_label, change) => {
      const view = await balancesWith({
        gateway_available_atomic: "7",
        api_observed_at: at(-1_000),
        api_consecutive_failures: 0,
        ...change,
      });
      expect(view.gatewayApiFresh).toBe(false);
    });

    it("is stale with no row at all, and reports no observation time", async () => {
      await expect(balancesWith(undefined)).resolves.toMatchObject({
        gatewayApiFresh: false,
        gatewayApiObservedAt: null,
        gatewayAvailable: 0n,
      });
    });
  });

  it("slowWithdrawTrigger: no failure row and a stale Gateway figure permit nothing", async () => {
    const stale = projectionOver({
      database: database((sql) =>
        sql.includes("FROM pocket_balances")
          ? [
              {
                gateway_available_atomic: "0",
                api_observed_at: "2020-01-01T00:00:00.000Z",
                api_consecutive_failures: 0,
              },
            ]
          : sql.includes("FROM pockets")
            ? [{ vault: VAULT, mirror: { envelopeId: "1", state: "Closed", funded: "0" } }]
            : [],
      ),
    });
    await expect(stale.slowWithdrawTrigger(pocketAddress)).resolves.toBeNull();
    await expect(projectionOver({}).slowWithdrawTrigger(pocketAddress)).resolves.toBeNull();
  });

  it("pocketSpendAfterObservation: reports a signed gateway-nano audit row and no other", async () => {
    await expect(
      projectionOver({}).pocketSpendAfterObservation(pocketAddress, NOW * 1000),
    ).resolves.toBe(false);
    await expect(
      projectionOver({ database: database(() => [{ "?column?": 1 }]) }).pocketSpendAfterObservation(
        pocketAddress,
        NOW * 1000,
      ),
    ).resolves.toBe(true);
  });

  describe("overdueManualReturnFacts never reports a receipt as valid when its sources fail", () => {
    const validRow = {
      state: "manual-return-required",
      closed_pocket: false,
      return_tx: `0x${"11".repeat(32)}`,
      return_block: "50",
      return_log_index: 4,
      returned_amount: "8000",
    };
    const denying = {
      returnReceiptValid: false,
      returnOverdue: false,
      manualReturnRecordedAfter: false,
    };

    it("when the receipt cannot be fetched", async () => {
      await expect(
        factsWith({}, (sql) =>
          sql.includes("FROM payer_pullback_gateway_failures") ? [validRow] : [],
        ),
      ).resolves.toMatchObject({ manualReturnRowValid: true, ...denying });
    });

    it("when the manual_returns table is missing", async () => {
      await expect(
        factsWith(
          {
            async getTransactionReceipt() {
              return { status: "success", blockNumber: 50n, logs: [] };
            },
          },
          (sql) => {
            if (sql.includes("FROM manual_returns"))
              throw Object.assign(new Error(MISSING_TABLE), { code: "42P01" });
            return sql.includes("FROM payer_pullback_gateway_failures") ? [validRow] : [];
          },
        ),
      ).resolves.toMatchObject({ manualReturnRowValid: true, ...denying });
    });

    it("when there is no recorded manual-return row, or it is not in the manual-return state", async () => {
      await expect(factsWith({}, () => [])).resolves.toMatchObject({
        manualReturnRowValid: false,
        ...denying,
      });
      await expect(
        factsWith({}, (sql) =>
          sql.includes("FROM payer_pullback_gateway_failures")
            ? [{ ...validRow, state: "pending" }]
            : [],
        ),
      ).resolves.toMatchObject({ manualReturnRowValid: false, ...denying });
    });

    it("when the audit or pocket reads are empty it reports the unaudited facts as false", async () => {
      await expect(factsWith({}, () => [])).resolves.toMatchObject({
        slowWithdrawAudited: false,
        pocketReturnAudited: false,
      });
    });
  });
});

const usdc3009 = () =>
  [
    "cz-15",
    {
      keyId: "K3",
      kind: "usdc-3009",
      payload: {
        vault: VAULT,
        reservationId: "12",
        index: "1",
        to: PAYEE,
        value: "100000",
        validBefore: "1760800600",
      },
    },
  ] as never;

const burn = () =>
  [
    "cz-15",
    { keyId: "K3", kind: "gateway-burn", payload: { vault: VAULT, pullbackId: "4" } },
  ] as never;

const evaluator = () =>
  [
    "cz-16",
    {
      keyId: "K7",
      kind: "evaluator-call",
      payload: { escrow: ESCROW, jobId: "5", decision: "complete", reportHash: h("9") },
    },
  ] as never;

const oel = () =>
  [
    "cz-17",
    {
      keyId: "K8",
      kind: "oel-commit",
      payload: {
        kind: "0",
        root: h("7"),
        prev: h("0"),
        uriHash: uriHash(archiveUri(h("7"))),
        uri: archiveUri(h("7")),
      },
    },
  ] as never;

describe("layer 3: through the signer, a failed source refuses the request and signs nothing", () => {
  const dead = projectionOver({ chain: deadChain, database: deadDatabase });
  type Harness = Awaited<ReturnType<typeof harness>>;
  type Sign = (t: Harness) => Promise<unknown>;

  interface Scenario {
    /** The `Projection` method taken down; every other method answers from the healthy test state. */
    readonly method: keyof Projection;
    readonly request: (t: Harness) => readonly [string, never];
    /** State the request needs to reach `method`, applied to the control run and the failing run alike. */
    readonly arrange?: (t: Harness) => void;
  }

  const stalePocketFigure = (t: Harness) => {
    t.state.slowWithdrawTrigger = "api-down";
    t.state.balances = {
      ...t.state.balances,
      gatewayApiFresh: false,
      gatewayApiObservedAt: NOW * 1000 - 600_000,
      gatewayAvailable: 20_000n,
    };
  };
  const slowWithdraw = (t: Harness) =>
    [
      "cz-15",
      {
        keyId: "K4",
        kind: "pocket-slow-withdraw",
        payload: { pocket: t.pocket, step: "initiate", value: "20000" },
      },
    ] as never;
  const nanoRequest = (t: Harness) =>
    [
      "cz-15",
      {
        keyId: "K4",
        kind: "gateway-nano",
        payload: {
          pocket: t.pocket,
          payTo: PAYEE,
          amount: "1000",
          validBefore: "1761404800",
          nonce: h("5"),
        },
      },
    ] as never;

  const SCENARIOS: readonly Scenario[] = [
    { method: "freezeState", request: usdc3009 },
    { method: "reservation", request: usdc3009 },
    { method: "pullback", request: burn },
    { method: "blockNumber", request: burn },
    {
      method: "isVault",
      request: () =>
        [
          "relayer",
          {
            keyId: "relayer",
            kind: "relayer-tx",
            payload: {
              to: VAULT,
              selector: "settle",
              args: { reservationId: "1", indices: ["0"] },
            },
          },
        ] as never,
    },
    {
      method: "autonomy",
      request: () =>
        [
          "cz-24",
          {
            keyId: "K5",
            kind: "autonomy-raise",
            payload: {
              vault: VAULT,
              categoryId: h("9"),
              newLimit: "5000000",
              periodId: "2963",
              deadline: "1792026000",
            },
          },
        ] as never,
    },
    {
      method: "nativeBalance",
      request: (t) =>
        [
          "relayer",
          {
            keyId: "relayer",
            kind: "gas-refill",
            payload: { target: t.address("K3"), amount: "1" },
          },
        ] as never,
    },
    { method: "pocket", request: nanoRequest },
    { method: "envelope", request: nanoRequest },
    { method: "nanoSpent", request: nanoRequest },
    {
      method: "pocketBalances",
      arrange: (t) => {
        t.state.balances = { ...t.state.balances, native: 900n };
      },
      request: (t) =>
        [
          "cz-15",
          {
            keyId: "K4",
            kind: "pocket-return",
            payload: { pocket: t.pocket, kind: "native", amount: "900" },
          },
        ] as never,
    },
    {
      method: "settledPayment",
      arrange: (t) => {
        t.state.settled.add(paymentRefHash(x402));
      },
      request: () =>
        [
          "cz-15",
          {
            keyId: "K3",
            kind: "sl-receipt",
            payload: {
              vault: VAULT,
              paymentRef: x402,
              receipt: {
                paymentRefHash: paymentRefHash(x402),
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
              },
            },
          },
        ] as never,
    },
    {
      method: "storedPlan",
      request: () =>
        [
          "cz-15",
          {
            keyId: "K3",
            kind: "vault-call",
            payload: {
              vault: VAULT,
              selector: "openEnvelope",
              args: {
                p: {
                  cap: "1000000",
                  maxStepAmount: "500000",
                  pocketCapBps: "2500",
                  expiresAt: "1760900000",
                  categoryId: h("d"),
                  objectiveHash: h("c"),
                  planHash: h("a"),
                  payeeRoot: h("b"),
                },
              },
            },
          },
        ] as never,
    },
    { method: "job", request: evaluator },
    { method: "reportExists", request: evaluator },
    {
      method: "checksCommitExists",
      request: () =>
        [
          "cz-16",
          {
            keyId: "K7",
            kind: "sl-validation-report",
            payload: {
              report: {
                obsId: h("1"),
                profileId: h("2"),
                methodVersion: h("3"),
                assignmentKind: "1",
                saltCommit: h("4"),
                checksCommit: h("8"),
                createdAt: "1760790004",
              },
            },
          },
        ] as never,
    },
    { method: "latestEvidenceRoot", request: oel },
    { method: "evidenceBatchExists", request: oel },
    { method: "slowWithdrawTrigger", arrange: stalePocketFigure, request: slowWithdraw },
    { method: "pocketSpendAfterObservation", arrange: stalePocketFigure, request: slowWithdraw },
    {
      method: "overdueManualReturnFacts",
      arrange: (t) => {
        t.state.balances = { ...t.state.balances, gatewayApiFresh: false, usdc: 0n };
        t.state.overdueManualReturnFacts = {
          pocketStateValid: true,
          envelopeOpen: true,
          pendingPullbackZero: true,
          gatewayWithdrawingZero: true,
          slowWithdrawAudited: true,
          pocketReturnAudited: true,
          manualReturnRowValid: true,
          returnReceiptValid: true,
          returnOverdue: true,
          manualReturnRecordedAfter: false,
        };
      },
      request: (t) =>
        [
          "cz-15",
          {
            keyId: "K3",
            kind: "vault-call",
            payload: { vault: VAULT, selector: "writeOffPocket", args: { pocket: t.pocket } },
          },
        ] as never,
    },
  ];

  const send =
    (request: Scenario["request"]): Sign =>
    (t) => {
      const [caller, payload] = request(t);
      return t.signer.sign(caller, payload);
    };

  it("scenarios cover every method of the Projection interface", () => {
    expect(new Set(SCENARIOS.map((item) => item.method))).toEqual(
      new Set(Object.keys(projectionOver({}))),
    );
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.method}: signs when healthy, and refuses with nothing signed when its source is down`, async () => {
      const control = await harness();
      scenario.arrange?.(control);
      await expect(send(scenario.request)(control)).resolves.toBeDefined();
      expect(control.calls.length).toBe(1);

      const failing = await harness({
        projection: { [scenario.method]: dead[scenario.method] } as Partial<Projection>,
      });
      scenario.arrange?.(failing);
      await expect(send(scenario.request)(failing)).rejects.toThrow(
        new RegExp(`${RPC_DOWN}|${MISSING_TABLE}`),
      );
      expect(failing.calls).toEqual([]);
      expect(failing.prepared).toEqual([]);
      expect(failing.audit.rows.some((row) => row.outcome === "signed")).toBe(false);
      expect(failing.audit.rows.at(-1)).toMatchObject({
        outcome: "backend-error",
        rule: "backend",
      });
    });
  }

  it("writeOffPocket: refuses when the optional overdueManualReturnFacts reader is absent", async () => {
    const t = await harness({
      projection: { overdueManualReturnFacts: undefined } as unknown as Partial<Projection>,
    });
    SCENARIOS.find((item) => item.method === "overdueManualReturnFacts")?.arrange?.(t);
    await expect(
      send(
        SCENARIOS.find((item) => item.method === "overdueManualReturnFacts")
          ?.request as Scenario["request"],
      )(t),
    ).rejects.toMatchObject({ name: "Denied", rule: "gateway-balance-stale" });
    expect(t.calls).toEqual([]);
    expect(t.audit.rows.at(-1)).toMatchObject({ outcome: "kms_denied" });
  });

  it("writeOffPocket: refuses when the return receipt cannot be fetched, with the real fact reader", async () => {
    const readFacts = projectionOver({
      chain: chain({
        read: (name) => {
          if (name === "getPocket") return { envelopeId: 7n, state: 2, pendingPullback: 0n };
          if (name === "getEnvelope") return { state: 1 };
          return 0n;
        },
      }),
      database: database((sql) =>
        sql.includes("FROM payer_pullback_gateway_failures")
          ? [
              {
                state: "manual-return-required",
                closed_pocket: false,
                return_tx: `0x${"11".repeat(32)}`,
                return_block: "50",
                return_log_index: 4,
                returned_amount: "8000",
              },
            ]
          : sql.includes("FROM audit")
            ? [{ "?column?": 1 }]
            : [],
      ),
    }).overdueManualReturnFacts;
    const t = await harness({ projection: { overdueManualReturnFacts: readFacts as never } });
    const scenario = SCENARIOS.find((item) => item.method === "overdueManualReturnFacts");
    scenario?.arrange?.(t);
    await expect(send(scenario?.request as Scenario["request"])(t)).rejects.toMatchObject({
      name: "Denied",
      rule: "gateway-balance-stale",
    });
    expect(t.calls).toEqual([]);
  });

  describe("D72: the real freezeState adapter and the freeze age check", () => {
    const maxAge = Number(config.get("signer.freezeStateMaxAgeSec"));
    const reservation = {
      envelopeId: 1n,
      stepIndex: 0,
      payee: PAYEE,
      unitAmount: 100000n,
      count: 3,
      validBefore: 1760800600n,
      state: 1,
    };
    const readsFor =
      (flags: { frozen?: boolean; guardianPaused?: boolean } = {}) =>
      (name: string) => {
        if (name === "frozen") return flags.frozen ?? false;
        if (name === "guardianPaused") return flags.guardianPaused ?? false;
        if (name === "getReservation") return reservation;
        throw new Error(`unexpected contract read: ${name}`);
      };
    const signUsdc = async (headAgeSeconds: number, flags?: Parameters<typeof readsFor>[0]) => {
      const t = await harness({
        projection: projectionOver({
          chain: chain({ timestamp: BigInt(NOW - headAgeSeconds), read: readsFor(flags) }),
        }),
      });
      return { t, result: send(usdc3009)(t) };
    };

    it("signs at exactly the maximum head age", async () => {
      const { t, result } = await signUsdc(maxAge);
      await expect(result).resolves.toBeDefined();
      expect(t.calls.length).toBe(1);
    });

    it("refuses one second past the maximum head age", async () => {
      const { t, result } = await signUsdc(maxAge + 1);
      await expect(result).rejects.toMatchObject({ name: "Denied", rule: "frozen" });
      expect(t.calls).toEqual([]);
    });

    it("refuses when the head block is dated in the far past (a stalled node)", async () => {
      const { t, result } = await signUsdc(86_400);
      await expect(result).rejects.toMatchObject({ name: "Denied", rule: "frozen" });
      expect(t.calls).toEqual([]);
    });

    it("refuses while the vault is frozen or the factory is paused", async () => {
      for (const flags of [{ frozen: true }, { guardianPaused: true }]) {
        const { t, result } = await signUsdc(0, flags);
        await expect(result).rejects.toMatchObject({ name: "Denied", rule: "frozen" });
        expect(t.calls).toEqual([]);
      }
    });
  });
});
