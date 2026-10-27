import type { Address, Hash32 } from "@czar/hashing";
import type { PaymentRef } from "@czar/schemas";
import { loadConfig } from "@czar/config";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import { createPostgresProjection } from "../src/postgres-projection.ts";
import type { AuditQueryExecutor } from "../src/postgres-audit.ts";
import type { Projection } from "../src/projection.ts";

const vault = "0x00000000000000000000000000000000000000a1" as Address;
const factory = "0x00000000000000000000000000000000000000a2" as Address;
const planHash = `0x${"ab".repeat(32)}` as Hash32;
const payee = "0x00000000000000000000000000000000000000b1" as Address;

describe("Postgres signer projection", () => {
  it("projects the D40 raise step from userMax with zero and nonzero autoLimit", async () => {
    for (const autoLimit of [0n, 100n]) {
      const projection = createPostgresProjection({
        config: loadConfig(),
        database: queryDatabase(() => []),
        chain: {
          async getBlock() {
            return { timestamp: 1_800_000_000n };
          },
          async getBlockNumber() {
            return 12n;
          },
          async getBalance() {
            return 100n;
          },
          async readContract({ functionName }: { functionName: string }) {
            if (functionName === "getLimits")
              return { autoLimit, userMax: 500n, lastRaiseAt: 1_800_000_000n };
            if (functionName === "autonomyNonce") return 7n;
            throw new Error(`unexpected contract read: ${functionName}`);
          },
        } as never,
        factory,
      });

      await expect(projection.autonomy(vault, planHash)).resolves.toMatchObject({
        maxStepTo: autoLimit + 100n,
        periodLength: 604800,
        nonce: 7n,
      });
    }
  });

  it("matches x402 settlement facts and does not query evidence_receipts", async () => {
    const paymentRef: PaymentRef = {
      schemaVersion: "1.0",
      rail: "x402-exact",
      network: "eip155:5042002",
      asset: "0x00000000000000000000000000000000000000b2",
      payer: vault,
      payTo: payee,
      amount: "100000",
      nonce: `0x${"11".repeat(32)}`,
      validBefore: 1_800_000_000,
    };
    const calls: { query: string; values: unknown[] | undefined }[] = [];
    const projection = createPostgresProjection({
      config: loadConfig(),
      database: {
        async query(query, values) {
          calls.push({ query, values });
          return { rows: values?.[3] === payee ? [{}] : [] };
        },
      },
      chain: fakeChain(),
      factory,
    });

    await expect(projection.settledPayment(vault, paymentRef)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("FROM authorizations");
    expect(calls[0]?.query).toContain("settled=true");
    expect(calls[0]?.query).toContain("reservations");
    expect(calls[0]?.query).toContain("lower(r.mirror->>'payee')=lower($4)");
    expect(calls[0]?.values).toEqual([vault, paymentRef.nonce, paymentRef.amount, payee]);
    await expect(projection.settledPayment(vault, { ...paymentRef, payTo: factory })).resolves.toBe(
      false,
    );
    expect(calls[0]?.query).not.toContain("evidence_receipts");
  });

  it("matches only completed Gateway transfers with the same amount and payee", async () => {
    const paymentRef: PaymentRef = {
      schemaVersion: "1.0",
      rail: "gateway-batched",
      network: "eip155:5042002",
      payer: payee,
      payTo: vault,
      amount: "100000",
      nonce: `0x${"22".repeat(32)}`,
    };
    const calls: { query: string; values: unknown[] | undefined }[] = [];
    const projection = createPostgresProjection({
      config: loadConfig(),
      database: {
        async query(query, values) {
          calls.push({ query, values });
          return { rows: values?.[3] === "100000" ? [{}] : [] };
        },
      },
      chain: fakeChain(),
      factory,
    });

    await expect(projection.settledPayment(vault, paymentRef)).resolves.toBe(true);
    await expect(
      projection.settledPayment(vault, { ...paymentRef, amount: "100001" }),
    ).resolves.toBe(false);
    expect(calls[0]?.query).toContain("status='completed'");
    expect(calls[0]?.query).toContain("lower(to_address)=lower($3)");
    expect(calls[0]?.values).toEqual([payee, paymentRef.nonce, vault, paymentRef.amount]);
  });

  it("matches Completed job facts by escrow, job id, provider and budget", async () => {
    const paymentRef: PaymentRef = {
      schemaVersion: "1.0",
      rail: "erc8183-job",
      network: "eip155:5042002",
      contract: "0x00000000000000000000000000000000000000c3",
      jobId: "9",
      client: vault,
      provider: payee,
      evaluator: factory,
      budget: "250000",
    };
    const calls: { query: string; values: unknown[] | undefined }[] = [];
    let indexedJobVault = vault;
    const projection = createPostgresProjection({
      config: loadConfig(),
      database: {
        async query(query, values) {
          calls.push({ query, values });
          return {
            rows: values?.[1] === "9" && values?.[4] === indexedJobVault ? [{}] : [],
          };
        },
      },
      chain: fakeChain(),
      factory,
    });

    await expect(projection.settledPayment(vault, paymentRef)).resolves.toBe(true);
    await expect(projection.settledPayment(vault, { ...paymentRef, jobId: "10" })).resolves.toBe(
      false,
    );
    expect(calls[0]?.query).toContain("state='Completed'");
    expect(calls[0]?.query).toContain("lower(vault)=lower($5)");
    expect(calls[0]?.query).toContain("mirror->>'provider'");
    expect(calls[0]?.query).toContain("mirror->>'budget'");
    expect(calls[0]?.values).toEqual([
      paymentRef.contract,
      paymentRef.jobId,
      paymentRef.provider,
      paymentRef.budget,
      vault,
    ]);
    indexedJobVault = factory;
    await expect(projection.settledPayment(vault, paymentRef)).resolves.toBe(false);
  });

  it("rebuilds stored plan leaves and used calls from server and indexer rows", async () => {
    const plan = {
      planHash,
      payeeRoot: `0x${"cd".repeat(32)}`,
      objectiveHash: `0x${"ef".repeat(32)}`,
      category: "research",
      cap: "1000",
      maxStepAmount: "500",
      pocketCapBps: 0,
      expiresAt: "2000000000",
      steps: [{ stepIndex: 0, kind: "x402-exact", expectedCalls: 2 }],
      payeeLeaves: [{ stepIndex: 0, payee, kind: 1, stepCap: "500" }],
    };
    const database = queryDatabase((sql) => {
      if (sql.includes("FROM plans p JOIN objectives"))
        return [{ plan, state: "offered", objective_state: "opening" }];
      if (sql.includes("SELECT mirror FROM envelopes"))
        return [{ mirror: { state: "Open", planHash } }];
      if (sql.includes("SELECT r.step_index")) return [{ step_index: 0, used_calls: 1 }];
      if (sql.includes("SELECT plan FROM plans")) return [{ plan }];
      return [];
    });
    const projection = createPostgresProjection({
      config: loadConfig(),
      database,
      chain: fakeChain(),
      factory,
    });

    await expect(projection.storedPlan(vault, planHash)).resolves.toMatchObject({
      approval: "auto-approvable",
      categoryId: keccak256(stringToHex("research")),
    });
    await expect(projection.envelope(vault, 4n)).resolves.toMatchObject({
      state: "Open",
      leaves: [{ stepIndex: 0, payee, expectedCalls: 2, usedCalls: 1 }],
    });
  });

  it("fails closed when the indexed envelope has no corresponding server plan", async () => {
    const database = queryDatabase((sql) =>
      sql.includes("SELECT mirror FROM envelopes") ? [{ mirror: { state: "Open", planHash } }] : [],
    );
    const projection = createPostgresProjection({
      config: loadConfig(),
      database,
      chain: fakeChain(),
      factory,
    });

    await expect(projection.envelope(vault, 4n)).rejects.toThrow("missing stored plan");
  });

  it("keeps pocket returns available without an API row while reading live wallet balances", async () => {
    const projection = createPostgresProjection({
      config: loadConfig(),
      database: queryDatabase(() => []),
      chain: fakeChain(),
      factory,
    });

    await expect(projection.pocketBalances(payee)).resolves.toMatchObject({
      gatewayAvailable: 0n,
      gatewayApiFresh: false,
      gatewayWithdrawing: 0n,
      withdrawalBlock: 0n,
      usdc: 0n,
      native: 100n,
    });
  });

  it("marks an old API figure stale while reading chain balances and withdrawalBlock live", async () => {
    const readFunctions: string[] = [];
    const projection = createPostgresProjection({
      config: loadConfig(),
      database: queryDatabase((sql) =>
        sql.includes("FROM pocket_balances")
          ? [{ gateway_available_atomic: "5000", api_observed_at: "2026-10-24T00:00:00.000Z" }]
          : [],
      ),
      chain: {
        async getBlock() {
          return { timestamp: 1_800_000_000n };
        },
        async getBlockNumber() {
          return 12n;
        },
        async getBalance() {
          return 100n;
        },
        async readContract({ functionName }: { functionName: string }) {
          readFunctions.push(functionName);
          if (functionName === "withdrawingBalance") return 9n;
          if (functionName === "withdrawalBlock") return 777n;
          if (functionName === "balanceOf") return 11n;
          return false;
        },
      } as never,
      factory,
    });

    await expect(projection.pocketBalances(payee)).resolves.toMatchObject({
      gatewayApi: 5000n,
      gatewayAvailable: 5000n,
      gatewayApiFresh: false,
      gatewayApiObservedAt: Date.parse("2026-10-24T00:00:00.000Z"),
      gatewayWithdrawing: 9n,
      withdrawalBlock: 777n,
      currentBlock: 12n,
      usdc: 11n,
      native: 100n,
    });
    expect(readFunctions).toEqual(["withdrawingBalance", "withdrawalBlock", "balanceOf"]);
  });

  it("checks K4 gateway-nano audit rows since the observation safety boundary", async () => {
    const queries: { query: string; values: unknown[] | undefined }[] = [];
    const projection = createPostgresProjection({
      config: loadConfig(),
      database: {
        async query(query, values) {
          queries.push({ query, values });
          return { rows: [{}] };
        },
      },
      chain: fakeChain(),
      factory,
    });
    const observedAt = Date.parse("2026-10-25T12:00:00.000Z");

    await expect(projection.pocketSpendAfterObservation(payee, observedAt)).resolves.toBe(true);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.query).toContain("action='signer:gateway-nano'");
    expect(queries[0]?.query).toContain("outcome='signed'");
    expect(queries[0]?.query).toContain("object_ids @>");
    expect(JSON.parse(String(queries[0]?.values?.[0]))).toEqual([{ keyRef: `K4:${payee}` }]);
    expect(queries[0]?.values?.[1]).toEqual(new Date(observedAt - 120_000).toISOString());
  });

  it("counts received, batched, confirmed and completed nanopayments only", async () => {
    const statements: string[] = [];
    const projection = createPostgresProjection({
      config: loadConfig(),
      database: {
        async query(query) {
          statements.push(query);
          return { rows: [{ total: "12" }] };
        },
      },
      chain: fakeChain(),
      factory,
    });

    await expect(projection.nanoSpent(payee, vault)).resolves.toEqual({ step: 12n, pocket: 12n });
    expect(statements).toHaveLength(2);
    expect(
      statements.every((query) => query.includes("'received','batched','confirmed','completed'")),
    ).toBe(true);
    expect(statements.every((query) => !query.includes("status='completed'"))).toBe(true);
  });

  it("allows slow withdrawal only for a fresh long outage or Closed-pocket dust", async () => {
    let apiObservedAt = new Date().toISOString();
    let outage = true;
    const database = queryDatabase((query) => {
      if (query.includes("FROM pocket_balances")) {
        return [
          {
            gateway_available_atomic: "10000",
            api_observed_at: apiObservedAt,
            api_consecutive_failures: 0,
          },
        ];
      }
      if (query.includes("payer_pullback_gateway_failures")) return outage ? [{}] : [];
      if (query.includes("FROM pockets")) {
        return [
          { vault, mirror: { envelopeId: 1, state: "Closed", funded: "1", pendingPullback: "0" } },
        ];
      }
      return [];
    });
    const projection = createPostgresProjection({
      config: loadConfig(),
      database,
      chain: fakeChain(),
      factory,
    });

    await expect(projection.slowWithdrawTrigger(payee)).resolves.toBe("api-down");
    outage = false;
    await expect(projection.slowWithdrawTrigger(payee)).resolves.toBe("closed-dust");
    apiObservedAt = "2020-01-01T00:00:00.000Z";
    await expect(projection.slowWithdrawTrigger(payee)).resolves.toBeNull();
  });

  it("derives slow-withdrawal state from the current on-chain balance", async () => {
    const database = queryDatabase((sql) =>
      sql.includes("SELECT vault, mirror FROM pockets")
        ? [{ vault, mirror: { envelopeId: 7, state: "Funded", funded: "100" } }]
        : [],
    );
    const projection = createPostgresProjection({
      config: loadConfig(),
      database,
      chain: fakeChain(),
      factory,
    });

    await expect(projection.pocket(payee)).resolves.toMatchObject({ slowWithdrawalOpen: false });
  });

  it("checks SCR-145 chain, CZ-15, K4 audit, receipt, hold and event-order facts", async () => {
    const fixture = overdueReturnProjection();
    const now = Number(returnTimestamp) + 72 * 3600 + 1;

    await expect(
      readOverdueManualReturnFacts(fixture.projection, fixture.pocket, vault, now),
    ).resolves.toMatchObject({
      pocketStateValid: true,
      envelopeOpen: true,
      pendingPullbackZero: true,
      gatewayWithdrawingZero: true,
      pocketUsdcZero: true,
      slowWithdrawAudited: true,
      pocketReturnAudited: true,
      manualReturnRowValid: true,
      returnReceiptValid: true,
      returnOverdue: true,
      manualReturnRecordedAfter: false,
    });
    expect(fixture.auditQueries).toEqual([
      { action: "signer:pocket-slow-withdraw", keyRef: `K4:${fixture.pocket}` },
      { action: "signer:pocket-return", keyRef: `K4:${fixture.pocket}` },
    ]);

    fixture.setLaterReturns([{ block: "50", log_index: 6 }]);
    await expect(
      readOverdueManualReturnFacts(fixture.projection, fixture.pocket, vault, now),
    ).resolves.toMatchObject({
      manualReturnRecordedAfter: true,
    });
    fixture.setLaterReturns([{ block: "50", log_index: 4 }]);
    await expect(
      readOverdueManualReturnFacts(fixture.projection, fixture.pocket, vault, now),
    ).resolves.toMatchObject({
      manualReturnRecordedAfter: false,
    });
    fixture.setRow({ ...fixture.row, closed_pocket: true });
    await expect(
      readOverdueManualReturnFacts(fixture.projection, fixture.pocket, vault, now),
    ).resolves.toMatchObject({ manualReturnRowValid: false });
    fixture.setRow({ ...fixture.row, closed_pocket: false });
    fixture.setReceiptStatus("reverted");
    await expect(
      readOverdueManualReturnFacts(fixture.projection, fixture.pocket, vault, now),
    ).resolves.toMatchObject({ returnReceiptValid: false });
    fixture.setReceiptStatus("success");
    await expect(
      readOverdueManualReturnFacts(
        fixture.projection,
        fixture.pocket,
        vault,
        Number(returnTimestamp) + 72 * 3600 - 1,
      ),
    ).resolves.toMatchObject({ returnReceiptValid: true, returnOverdue: false });
  });
});

function queryDatabase(rowsFor: (sql: string) => Record<string, unknown>[]): AuditQueryExecutor {
  return {
    async query(sql) {
      return { rows: rowsFor(sql) };
    },
  };
}

function readOverdueManualReturnFacts(
  projection: Projection,
  pocket: Address,
  vaultAddress: Address,
  now: number,
) {
  const readFacts = projection.overdueManualReturnFacts;
  if (readFacts === undefined)
    throw new Error("Postgres projection has no SCR-145 evidence reader");
  return readFacts(pocket, vaultAddress, now);
}

const returnTimestamp = 1_800_000_000n;

function overdueReturnProjection() {
  const pocket = "0x00000000000000000000000000000000000000c1" as Address;
  const txHash = `0x${"33".repeat(32)}`;
  const returnLogIndex = 5;
  const transferAbi = parseAbi([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]);
  const topics = encodeEventTopics({
    abi: transferAbi,
    eventName: "Transfer",
    args: { from: pocket, to: vault },
  });
  let laterReturns: Record<string, unknown>[] = [];
  let row: Record<string, unknown> = {
    state: "manual-return-required",
    closed_pocket: false,
    return_tx: txHash,
    return_block: "50",
    return_log_index: returnLogIndex,
    returned_amount: "8000",
  };
  let receiptStatus: "success" | "reverted" = "success";
  const auditQueries: { action: unknown; keyRef: unknown }[] = [];
  const database: AuditQueryExecutor = {
    async query(query, values) {
      if (query.includes("FROM payer_pullback_gateway_failures")) return { rows: [row] };
      if (query.includes("FROM audit")) {
        auditQueries.push({ action: values?.[0], keyRef: values?.[1] });
        return { rows: [{}] };
      }
      if (query.includes("FROM manual_returns")) return { rows: laterReturns };
      if (query.includes("FROM pocket_balances"))
        return {
          rows: [
            {
              gateway_available_atomic: "0",
              api_observed_at: "2026-10-20T00:00:00.000Z",
              api_consecutive_failures: 1,
            },
          ],
        };
      return { rows: [] };
    },
  };
  const projection = createPostgresProjection({
    config: loadConfig(),
    database,
    chain: overdueReturnChain(topics, returnLogIndex, () => receiptStatus),
    factory,
  });
  return {
    pocket,
    projection,
    row,
    auditQueries,
    setRow: (nextRow: Record<string, unknown>) => {
      row = nextRow;
    },
    setLaterReturns: (returns: Record<string, unknown>[]) => {
      laterReturns = returns;
    },
    setReceiptStatus: (status: "success" | "reverted") => {
      receiptStatus = status;
    },
  };
}

function overdueReturnChain(
  topics: ReturnType<typeof encodeEventTopics>,
  returnLogIndex: number,
  receiptStatus: () => "success" | "reverted",
) {
  return {
    async getBlock() {
      return { timestamp: returnTimestamp };
    },
    async getBlockNumber() {
      return 60n;
    },
    async getBalance() {
      return 0n;
    },
    async getTransactionReceipt() {
      return {
        status: receiptStatus(),
        blockNumber: 50n,
        logs: [
          {
            address: "0x3600000000000000000000000000000000000000",
            data: encodeAbiParameters([{ type: "uint256" }], [8000n]),
            topics,
            logIndex: returnLogIndex,
          },
        ],
      };
    },
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "getPocket") return { envelopeId: 7n, state: 2, pendingPullback: 0n };
      if (functionName === "getEnvelope") return { state: 1 };
      if (["withdrawingBalance", "withdrawalBlock", "balanceOf"].includes(functionName)) return 0n;
      throw new Error(`unexpected contract read: ${functionName}`);
    },
  } as never;
}

function fakeChain() {
  return {
    async getBlock() {
      return { timestamp: 1_800_000_000n };
    },
    async getBlockNumber() {
      return 12n;
    },
    async getBalance() {
      return 100n;
    },
    async readContract({ functionName }: { functionName: string }) {
      if (["withdrawingBalance", "withdrawalBlock", "balanceOf"].includes(functionName)) return 0n;
      return false;
    },
  } as never;
}
