import type { Address, Hash32 } from "@czar/hashing";
import type { PaymentRef } from "@czar/schemas";
import { loadConfig } from "@czar/config";
import { keccak256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import { createPostgresProjection } from "../src/postgres-projection.ts";
import type { AuditQueryExecutor } from "../src/postgres-audit.ts";

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
          return { rows: [{}] };
        },
      },
      chain: fakeChain(),
      factory,
    });

    await expect(projection.settledPayment(vault, paymentRef)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("FROM authorizations");
    expect(calls[0]?.query).toContain("settled=true");
    expect(calls[0]?.values).toEqual([vault, paymentRef.nonce, paymentRef.amount]);
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
    const projection = createPostgresProjection({
      config: loadConfig(),
      database: {
        async query(query, values) {
          calls.push({ query, values });
          return { rows: values?.[1] === "9" ? [{}] : [] };
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
    expect(calls[0]?.query).toContain("mirror->>'provider'");
    expect(calls[0]?.query).toContain("mirror->>'budget'");
    expect(calls[0]?.values).toEqual([
      paymentRef.contract,
      paymentRef.jobId,
      paymentRef.provider,
      paymentRef.budget,
    ]);
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

  it("never claims Gateway balances when the local projection lacks them", async () => {
    const projection = createPostgresProjection({
      config: loadConfig(),
      database: queryDatabase(() => []),
      chain: fakeChain(),
      factory,
    });

    await expect(projection.pocketBalances(payee)).rejects.toThrow(
      "Gateway balance projection unavailable",
    );
  });

  it("treats an absent slow-withdrawal projection as open", async () => {
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

    await expect(projection.pocket(payee)).resolves.toMatchObject({ slowWithdrawalOpen: true });
  });
});

function queryDatabase(rowsFor: (sql: string) => Record<string, unknown>[]): AuditQueryExecutor {
  return {
    async query(sql) {
      return { rows: rowsFor(sql) };
    },
  };
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
    async readContract() {
      return false;
    },
  } as never;
}
