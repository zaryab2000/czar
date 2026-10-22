import type { Address, Hash32 } from "@czar/hashing";
import { keccak256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import { createPostgresProjection } from "../src/postgres-projection.ts";
import type { AuditQueryExecutor } from "../src/postgres-audit.ts";

const vault = "0x00000000000000000000000000000000000000a1" as Address;
const factory = "0x00000000000000000000000000000000000000a2" as Address;
const planHash = `0x${"ab".repeat(32)}` as Hash32;
const payee = "0x00000000000000000000000000000000000000b1" as Address;

describe("Postgres signer projection", () => {
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
    const projection = createPostgresProjection({ database, chain: fakeChain(), factory });

    await expect(projection.envelope(vault, 4n)).rejects.toThrow("missing stored plan");
  });

  it("never claims Gateway balances when the local projection lacks them", async () => {
    const projection = createPostgresProjection({
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
    const projection = createPostgresProjection({ database, chain: fakeChain(), factory });

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
