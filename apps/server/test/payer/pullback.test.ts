import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { transferSpecBytes, transferSpecHash } from "@czar/hashing";
import { Denied, type SignRequest } from "@czar/signer";
import {
  buildPullbackBurnIntent,
  cancelExpiredPullback,
  calculatePullbackValue,
  executeSlowPullbackFallback,
  pullbackMaxBlockHeight,
  PULLBACK_CANCEL_DELAY_BLOCKS,
} from "#src/payer/pullback";
import { setupDatabase } from "#test/db";
import { appendExecutionPhase, getExecutionTrace } from "#src/payer/executions";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";
import { executePullback } from "#src/payer/pullback";
import { loadConfig } from "@czar/config";

const getPool = setupDatabase();
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";

beforeAll(async () => {
  await seedDevice(getPool());
  const submission = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y");
  await getPool().query(
    `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state)
     VALUES ($1,$2,$3,$4::jsonb,$5,'received') ON CONFLICT (objective_id) DO NOTHING`,
    [
      submission.objectiveId,
      TEST_USER_ID,
      submission.deviceId,
      JSON.stringify(submission),
      submission.objectiveHash,
    ],
  );
  await getPool().query(
    `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES ($1,$2,'{}',$3,$4,'offered') ON CONFLICT (plan_id) DO NOTHING`,
    [PLAN_ID, submission.objectiveId, `0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`],
  );
});

beforeEach(async () => {
  await getPool().query("DELETE FROM step_executions");
  await getPool().query("DELETE FROM payer_pullback_gateway_failures");
  await getPool().query("DELETE FROM steps WHERE plan_id=$1", [PLAN_ID]);
  await getPool().query(
    "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,'{}','queued')",
    [PLAN_ID],
  );
});

describe("pullback values", () => {
  it("waits and records when the Gateway balance observation is stale", async () => {
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      vault: "0x0000000000000000000000000000000000000001" as const,
      pocket: "0x0000000000000000000000000000000000000002" as const,
      gatewayWallet: "0x0000000000000000000000000000000000000003" as const,
      gatewayMinter: "0x0000000000000000000000000000000000000004" as const,
      usdc: "0x0000000000000000000000000000000000000005" as const,
      gatewayDomain: 26,
      outstanding: 900_000n,
      pending: 0n,
      availableBalance: 850_000n,
      availableBalanceObservedAt: new Date("2026-10-21T23:57:00Z"),
      apiConsecutiveFailures: 0,
      head: 6_400n,
    };
    const requestPullback = vi.fn(async () => {
      throw new Error("stale balance must not create pullback");
    });
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: {
        sign: vi.fn(async () => ({ signedTransaction: "0x1234" as const })),
      },
      chain: {
        maxPullbackFee: vi.fn(async () => 20_000n),
        findPendingPullback: vi.fn(async () => undefined),
        requestPullback,
        writeOffPocket: vi.fn(),
      },
      safeFetch: vi.fn(),
      gatewayTransferUrl: "http://127.0.0.1:4999/v1/transfer",
      now: () => new Date("2026-10-22T00:00:00Z"),
    };

    await expect(executePullback(input, dependencies as never)).resolves.toMatchObject({
      state: "waiting",
      reason: "gateway-balance-stale",
    });
    expect(requestPullback).not.toHaveBeenCalled();
    const phases = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
    expect(phases.at(-1)?.phase).toBe("pullback.gateway-balance-stale");
    const outage = await getPool().query(
      "SELECT value,pullback_id FROM payer_pullback_gateway_failures WHERE plan_id=$1",
      [PLAN_ID],
    );
    expect(outage.rows).toEqual([{ value: null, pullback_id: null }]);
  });

  it("waits when a recent Gateway balance has consecutive API failures", async () => {
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      vault: "0x0000000000000000000000000000000000000001" as const,
      pocket: "0x0000000000000000000000000000000000000002" as const,
      gatewayWallet: "0x0000000000000000000000000000000000000003" as const,
      gatewayMinter: "0x0000000000000000000000000000000000000004" as const,
      usdc: "0x0000000000000000000000000000000000000005" as const,
      gatewayDomain: 26,
      outstanding: 900_000n,
      pending: 0n,
      availableBalance: 850_000n,
      availableBalanceObservedAt: new Date("2026-10-22T00:00:00Z"),
      apiConsecutiveFailures: 1,
      head: 6_400n,
    };
    const requestPullback = vi.fn();
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign: vi.fn() },
      chain: {
        maxPullbackFee: vi.fn(async () => 20_000n),
        findPendingPullback: vi.fn(async () => undefined),
        requestPullback,
      },
      safeFetch: vi.fn(),
      gatewayTransferUrl: "http://127.0.0.1:4999/v1/transfer",
      now: () => new Date("2026-10-22T00:00:00Z"),
    };

    await expect(executePullback(input, dependencies as never)).resolves.toMatchObject({
      state: "waiting",
      reason: "gateway-balance-stale",
    });
    expect(requestPullback).not.toHaveBeenCalled();
    const outage = await getPool().query(
      "SELECT value,pullback_id FROM payer_pullback_gateway_failures WHERE plan_id=$1",
      [PLAN_ID],
    );
    expect(outage.rows).toEqual([{ value: null, pullback_id: null }]);
  });

  it("recovers a Closed pocket from fresh Gateway balance without an outstanding bound", async () => {
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      vault: "0x0000000000000000000000000000000000000001" as const,
      pocket: "0x0000000000000000000000000000000000000002" as const,
      gatewayWallet: "0x0000000000000000000000000000000000000003" as const,
      gatewayMinter: "0x0000000000000000000000000000000000000004" as const,
      usdc: "0x0000000000000000000000000000000000000005" as const,
      gatewayDomain: 26,
      outstanding: 0n,
      pending: 0n,
      availableBalance: 80_000n,
      availableBalanceObservedAt: new Date("2026-10-22T00:00:00Z"),
      apiConsecutiveFailures: 0,
      head: 6_400n,
      closedPocket: true,
    };
    const requestPullback = vi.fn(async () => {
      throw new Error("local Gateway unavailable");
    });
    const writeOffPocket = vi.fn();
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: {
        sign: vi.fn(async (_caller: string, request: { kind: string }) =>
          request.kind === "gateway-burn"
            ? { signature: "0xbeef" as const, digest: `0x${"ef".repeat(32)}` as const }
            : { signedTransaction: "0x1234" as const },
        ),
      },
      chain: {
        maxPullbackFee: vi.fn(async () => 20_000n),
        findPendingPullback: vi.fn(async () => undefined),
        requestPullback,
        writeOffPocket,
      },
      safeFetch: vi.fn(),
      gatewayTransferUrl: "http://127.0.0.1:4999/v1/transfer",
      now: () => new Date("2026-10-22T00:00:00Z"),
    };

    await expect(executePullback(input, dependencies as never)).rejects.toThrow(
      "local Gateway unavailable",
    );
    expect(requestPullback).toHaveBeenCalledWith(
      expect.objectContaining({ value: 70_000n, maxFee: 10_000n }),
    );
    expect(writeOffPocket).not.toHaveBeenCalled();
  });

  it("starts a new recovery pullback after a confirmed late-funds cycle", async () => {
    let nextId = 9n;
    let currentPullback:
      | {
          pullbackId: bigint;
          value: bigint;
          maxFee: bigint;
          maxBlockHeight: bigint;
          salt: `0x${string}`;
          transferSpecHash: `0x${string}`;
          state: "Pending" | "Confirmed";
        }
      | undefined;
    let transferUsed = false;
    const requestPullback = vi.fn(
      async (request: { value: bigint; maxFee: bigint; maxBlockHeight: bigint }) => {
        const id = nextId++;
        transferUsed = false;
        currentPullback = {
          pullbackId: id,
          value: request.value,
          maxFee: request.maxFee,
          maxBlockHeight: request.maxBlockHeight,
          salt: `0x${id.toString(16).padStart(64, "0")}`,
          transferSpecHash: `0x${id.toString(16).padStart(64, "0")}`,
          state: "Pending",
        };
        return currentPullback;
      },
    );
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: {
        sign: vi.fn(async (_caller: string, request: { kind: string }) =>
          request.kind === "gateway-burn"
            ? { signature: "0xbeef" as const, digest: `0x${"ef".repeat(32)}` as const }
            : { signedTransaction: "0x1234" as const },
        ),
      },
      chain: {
        maxPullbackFee: vi.fn(async () => 20_000n),
        findPendingPullback: vi.fn(async () => undefined),
        requestPullback,
        isTransferSpecHashUsed: vi.fn(async () => transferUsed),
        mintAttestation: vi.fn(async () => {
          transferUsed = true;
          return "mint-tx";
        }),
        confirmPullback: vi.fn(async ({ pullbackId }: { pullbackId: bigint }) => {
          if (currentPullback?.pullbackId === pullbackId) currentPullback.state = "Confirmed";
          return "confirm-tx";
        }),
        cancelPullback: vi.fn(),
        readPullback: vi.fn(async (pullbackId: bigint) =>
          currentPullback?.pullbackId === pullbackId ? currentPullback : undefined,
        ),
        getBlockNumber: vi.fn(async () => 6_400n),
      },
      safeFetch: vi.fn(async () => ({
        status: 201,
        url: "http://127.0.0.1:4999/v1/transfer",
        headers: {},
        body: new TextEncoder().encode(
          JSON.stringify({ transferId: "late", attestation: "0x12", signature: "0x34" }),
        ),
      })),
      gatewayTransferUrl: "http://127.0.0.1:4999/v1/transfer",
      now: () => new Date("2026-10-22T00:00:00Z"),
    };
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      vault: "0x0000000000000000000000000000000000000001" as const,
      pocket: "0x0000000000000000000000000000000000000002" as const,
      gatewayWallet: "0x0000000000000000000000000000000000000003" as const,
      gatewayMinter: "0x0000000000000000000000000000000000000004" as const,
      usdc: "0x0000000000000000000000000000000000000005" as const,
      gatewayDomain: 26,
      outstanding: 0n,
      pending: 0n,
      availableBalance: 100_000n,
      availableBalanceObservedAt: new Date("2026-10-22T00:00:00Z"),
      apiConsecutiveFailures: 0,
      head: 6_400n,
      closedPocket: true,
    };

    await expect(executePullback(input, dependencies as never)).resolves.toMatchObject({
      state: "confirmed",
      pullbackId: "9",
    });
    await expect(
      executePullback({ ...input, availableBalance: 80_000n }, dependencies as never),
    ).resolves.toMatchObject({ state: "confirmed", pullbackId: "10" });

    expect(requestPullback).toHaveBeenCalledTimes(2);
    expect(requestPullback.mock.calls.map(([request]) => request.value)).toEqual([
      90_000n,
      70_000n,
    ]);
  });

  it("payer_pocketClose_sweepsGasAndRecoversLateBalance", async () => {
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      attempt: 0,
      vault: "0x0000000000000000000000000000000000000001" as const,
      pocket: "0x0000000000000000000000000000000000000002" as const,
    };
    let gateway = 70_000n;
    const recoverLateGatewayBalance = vi.fn(async () => {
      gateway = 0n;
    });
    const dependencies = {
      pool: getPool(),
      signer: {
        sign: vi.fn(async () => ({ signedTransaction: "0x1234" as const })),
        retirePocketKey: vi.fn(async () => ({ destroyAfterMs: 1_900_000_000_000 })),
      },
      chain: {
        isClosed: vi.fn(async () => true),
        hasPendingPullback: vi.fn(async () => false),
        writeOffPocket: vi.fn(),
        sweepableNativeBalance: vi.fn(async () => 2_000n),
        pocketBalances: vi.fn(async () => ({ native: 0n, usdc: 0n, gateway })),
        sendPocketTransaction: vi.fn(async () => "sweep-tx"),
      },
      recoverLateGatewayBalance,
    };

    const { sweepAndRetirePocketKey } = await import("#src/payer/pocket");
    await expect(sweepAndRetirePocketKey(input, dependencies as never)).resolves.toMatchObject({
      state: "retiring",
    });
    expect(recoverLateGatewayBalance).toHaveBeenCalledOnce();
    expect(dependencies.signer.retirePocketKey).toHaveBeenCalledWith("cz-15", input.pocket);
  });

  it("persists the first Gateway API failure time for the scheduler", async () => {
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      vault: "0x0000000000000000000000000000000000000001" as const,
      pocket: "0x0000000000000000000000000000000000000002",
      gatewayWallet: "0x0000000000000000000000000000000000000003",
      gatewayMinter: "0x0000000000000000000000000000000000000004",
      usdc: "0x0000000000000000000000000000000000000005",
      gatewayDomain: 26,
      outstanding: 900_000n,
      pending: 0n,
      availableBalance: 850_000n,
      availableBalanceObservedAt: new Date("2026-10-22T00:00:00Z"),
      apiConsecutiveFailures: 0,
      head: 6_400n,
    } as const;
    const now = new Date("2026-10-22T00:00:00Z");
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: {
        sign: vi.fn(async (_caller: string, request: { kind: string }) =>
          request.kind === "gateway-burn"
            ? { signature: "0xbeef" as const, digest: `0x${"ef".repeat(32)}` as const }
            : { signedTransaction: "0x1234" as const },
        ),
      },
      chain: {
        maxPullbackFee: async () => 20_000n,
        writeOffPocket: async () => "write-off-tx",
        findPendingPullback: async () => undefined,
        requestPullback: async () => ({
          pullbackId: 9n,
          value: 840_000n,
          maxFee: 10_000n,
          maxBlockHeight: 10_000n,
          salt: `0x${"ab".repeat(32)}` as const,
          transferSpecHash: `0x${"cd".repeat(32)}` as const,
          state: "Pending" as const,
        }),
        isTransferSpecHashUsed: async () => false,
        mintAttestation: async () => "mint-tx",
        confirmPullback: async () => "confirm-tx",
        cancelPullback: async () => "cancel-tx",
        sendVaultTransaction: async () => undefined,
        readPullback: async () => undefined,
        getBlockNumber: async () => 6_400n,
      },
      safeFetch: vi.fn(async () => {
        throw new Error("local Gateway unavailable");
      }),
      gatewayTransferUrl: "http://127.0.0.1:4999/v1/transfer",
      now: () => now,
    };
    await expect(executePullback(input, dependencies)).rejects.toThrow("local Gateway unavailable");
    const recorded = await getPool().query(
      "SELECT unavailable_since,state FROM payer_pullback_gateway_failures WHERE plan_id=$1",
      [PLAN_ID],
    );
    expect(recorded.rows).toEqual([{ unavailable_since: now, state: "pending" }]);
  });

  it("persists the effective attempt when a closed-pocket transfer fails", async () => {
    const oldUnavailableSince = new Date("2026-10-20T00:00:00Z");
    const now = new Date("2026-10-22T00:00:00Z");
    await getPool().query(
      `INSERT INTO payer_pullback_gateway_failures
         (plan_id,step_index,envelope_ref,pocket,value,unavailable_since,state,
          pullback_id,vault_address,gateway_minter,attempt,closed_pocket)
       VALUES ($1,0,$2,$3,90000,$4,'returned-to-vault',9,$5,$6,1,true)`,
      [
        PLAN_ID,
        "eip155:5042002:0x0000000000000000000000000000000000000001:1",
        "0x0000000000000000000000000000000000000002",
        oldUnavailableSince,
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000004",
      ],
    );
    await appendExecutionPhase(getPool(), {
      planId: PLAN_ID,
      stepIndex: 0,
      attempt: 1,
      phase: "pullback.slow.returned",
      payload: { amount: "90000", txHash: "prior-return-tx" },
    });
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      vault: "0x0000000000000000000000000000000000000001" as const,
      pocket: "0x0000000000000000000000000000000000000002" as const,
      gatewayWallet: "0x0000000000000000000000000000000000000003" as const,
      gatewayMinter: "0x0000000000000000000000000000000000000004" as const,
      usdc: "0x0000000000000000000000000000000000000005" as const,
      gatewayDomain: 26,
      outstanding: 0n,
      pending: 0n,
      availableBalance: 100_000n,
      availableBalanceObservedAt: new Date("2026-10-22T00:00:00Z"),
      apiConsecutiveFailures: 0,
      head: 6_400n,
      closedPocket: true,
    };
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: {
        sign: vi.fn(async (_caller: string, request: { kind: string }) =>
          request.kind === "gateway-burn"
            ? { signature: "0xbeef" as const, digest: `0x${"ef".repeat(32)}` as const }
            : { signedTransaction: "0x1234" as const },
        ),
      },
      chain: {
        maxPullbackFee: async () => 20_000n,
        writeOffPocket: async () => "write-off-tx",
        findPendingPullback: async () => undefined,
        requestPullback: vi.fn(async () => ({
          pullbackId: 10n,
          value: 90_000n,
          maxFee: 10_000n,
          maxBlockHeight: 10_000n,
          salt: `0x${"bc".repeat(32)}` as const,
          transferSpecHash: `0x${"de".repeat(32)}` as const,
          state: "Pending" as const,
        })),
        isTransferSpecHashUsed: async () => false,
        mintAttestation: async () => "mint-tx",
        confirmPullback: async () => "confirm-tx",
        cancelPullback: async () => "cancel-tx",
        sendVaultTransaction: async () => undefined,
        readPullback: async () => undefined,
        getBlockNumber: async () => 6_400n,
      },
      safeFetch: vi.fn(async () => {
        throw new Error("closed-pocket Gateway unavailable");
      }),
      gatewayTransferUrl: "http://127.0.0.1:4999/v1/transfer",
      now: () => now,
    };

    await expect(executePullback(input, dependencies)).rejects.toThrow(
      "closed-pocket Gateway unavailable",
    );
    const recorded = await getPool().query<{
      attempt: number;
      closed_pocket: boolean;
      state: string;
      unavailable_since: Date;
      pullback_id: string;
    }>(
      `SELECT attempt,closed_pocket,state,unavailable_since,pullback_id
       FROM payer_pullback_gateway_failures WHERE plan_id=$1`,
      [PLAN_ID],
    );
    expect(recorded.rows).toEqual([
      {
        attempt: 2,
        closed_pocket: true,
        state: "pending",
        unavailable_since: now,
        pullback_id: "10",
      },
    ]);
    const priorReturn = await getPool().query(
      `SELECT phase,payload FROM step_executions
       WHERE plan_id=$1 AND step_index=0 AND attempt=1
       ORDER BY execution_id DESC LIMIT 1`,
      [PLAN_ID],
    );
    expect(priorReturn.rows[0]?.phase).toBe("pullback.slow.returned");
    expect(priorReturn.rows[0]?.payload).toMatchObject({ txHash: "prior-return-tx" });
  });

  it("starts a new outage cycle after a prior closed-pocket return", async () => {
    const oldUnavailableSince = new Date("2026-10-20T00:00:00Z");
    const now = new Date("2026-10-22T00:00:00Z");
    await getPool().query(
      `INSERT INTO payer_pullback_gateway_failures
         (plan_id,step_index,envelope_ref,pocket,value,unavailable_since,state,
          pullback_id,vault_address,gateway_minter,attempt,closed_pocket)
       VALUES ($1,0,$2,$3,90000,$4,'returned-to-vault',9,$5,$6,1,true)`,
      [
        PLAN_ID,
        "eip155:5042002:0x0000000000000000000000000000000000000001:1",
        "0x0000000000000000000000000000000000000002",
        oldUnavailableSince,
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000004",
      ],
    );
    await appendExecutionPhase(getPool(), {
      planId: PLAN_ID,
      stepIndex: 0,
      attempt: 1,
      phase: "pullback.slow.returned",
      payload: { amount: "90000", txHash: "prior-return-tx" },
    });
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      vault: "0x0000000000000000000000000000000000000001" as const,
      pocket: "0x0000000000000000000000000000000000000002" as const,
      gatewayWallet: "0x0000000000000000000000000000000000000003" as const,
      gatewayMinter: "0x0000000000000000000000000000000000000004" as const,
      usdc: "0x0000000000000000000000000000000000000005" as const,
      gatewayDomain: 26,
      outstanding: 0n,
      pending: 0n,
      availableBalance: 100_000n,
      availableBalanceObservedAt: now,
      apiConsecutiveFailures: 1,
      head: 6_400n,
      closedPocket: true,
    };

    await expect(
      executePullback(input, {
        pool: getPool(),
        config: loadConfig(),
        signer: { sign: vi.fn() },
        chain: {},
        safeFetch: vi.fn(),
        gatewayTransferUrl: "http://127.0.0.1:4999/v1/transfer",
        now: () => now,
      } as never),
    ).resolves.toMatchObject({ state: "waiting", reason: "gateway-balance-stale" });
    const recorded = await getPool().query(
      `SELECT state,unavailable_since,attempt,closed_pocket,pullback_id
       FROM payer_pullback_gateway_failures WHERE plan_id=$1`,
      [PLAN_ID],
    );
    expect(recorded.rows).toEqual([
      {
        state: "pending",
        unavailable_since: now,
        attempt: 2,
        closed_pocket: true,
        pullback_id: null,
      },
    ]);
    const priorReturn = await getPool().query(
      `SELECT phase,payload FROM step_executions
       WHERE plan_id=$1 AND step_index=0 AND attempt=1
       ORDER BY execution_id DESC LIMIT 1`,
      [PLAN_ID],
    );
    expect(priorReturn.rows[0]?.phase).toBe("pullback.slow.returned");
    expect(priorReturn.rows[0]?.payload).toMatchObject({ txHash: "prior-return-tx" });
  });

  it("keeps the outage row while a slow withdrawal is active", async () => {
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      vault: "0x0000000000000000000000000000000000000001" as const,
      pocket: "0x0000000000000000000000000000000000000002" as const,
      gatewayWallet: "0x0000000000000000000000000000000000000003" as const,
      gatewayMinter: "0x0000000000000000000000000000000000000004" as const,
      usdc: "0x0000000000000000000000000000000000000005" as const,
      gatewayDomain: 26,
      outstanding: 900_000n,
      pending: 0n,
      availableBalance: 0n,
      availableBalanceObservedAt: new Date("2026-10-22T00:00:00Z"),
      apiConsecutiveFailures: 0,
      head: 6_400n,
    };
    const outageAt = new Date("2026-10-21T00:00:00Z");
    await getPool().query(
      `INSERT INTO payer_pullback_gateway_failures
         (plan_id,step_index,envelope_ref,pocket,value,unavailable_since,state,
          pullback_id,vault_address,gateway_minter,attempt)
       VALUES ($1,0,$2,$3,NULL,$4,'pending',NULL,$5,$6,0)`,
      [PLAN_ID, input.envelopeRef, input.pocket, outageAt, input.vault, input.gatewayMinter],
    );
    await appendExecutionPhase(getPool(), {
      planId: PLAN_ID,
      stepIndex: 0,
      attempt: 0,
      phase: "pullback.slow.initiated",
      payload: { txHash: "initiate-tx" },
    });
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign: vi.fn(async () => ({ signedTransaction: "0x1234" as const })) },
      chain: {
        maxPullbackFee: vi.fn(async () => 20_000n),
        findPendingPullback: vi.fn(async () => undefined),
        requestPullback: vi.fn(),
        writeOffPocket: vi.fn(async () => {
          throw new Error("slow-withdrawal-open");
        }),
      },
      safeFetch: vi.fn(),
      gatewayTransferUrl: "http://127.0.0.1:4999/v1/transfer",
      now: () => new Date("2026-10-22T00:00:00Z"),
    };

    await expect(executePullback(input, dependencies as never)).rejects.toThrow(
      "slow-withdrawal-open",
    );
    const recorded = await getPool().query(
      "SELECT unavailable_since FROM payer_pullback_gateway_failures WHERE plan_id=$1",
      [PLAN_ID],
    );
    expect(recorded.rows).toEqual([{ unavailable_since: outageAt }]);
  });

  it("pullback_fullBalanceDrain_valuePlusFeeFitsBalance", () => {
    expect(
      calculatePullbackValue({
        outstanding: 950_000n,
        pending: 100_000n,
        availableBalance: 850_000n,
        maxFee: 20_000n,
        safety: 5_000n,
      }),
    ).toBe(825_000n);
    expect(
      calculatePullbackValue({
        outstanding: 950_000n,
        pending: 0n,
        availableBalance: 850_000n,
        maxFee: 20_000n,
        safety: 0n,
      }),
    ).toBe(830_000n);
  });

  it("adds the configured transfer window to the current head", () => {
    expect(pullbackMaxBlockHeight(20_000n, 3_600n)).toBe(23_600n);
  });

  it("returns zero when pending pullbacks or fees consume the available amount", () => {
    expect(
      calculatePullbackValue({
        outstanding: 50n,
        pending: 50n,
        availableBalance: 10n,
        maxFee: 10n,
        safety: 1n,
      }),
    ).toBe(0n);
  });

  it("writes off a pocket when no value is withdrawable", async () => {
    const writeOffPocket = vi.fn(async () => "write-off-tx");
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      vault: "0x0000000000000000000000000000000000000001" as const,
      pocket: "0x0000000000000000000000000000000000000002" as const,
      gatewayWallet: "0x0000000000000000000000000000000000000003" as const,
      gatewayMinter: "0x0000000000000000000000000000000000000004" as const,
      usdc: "0x0000000000000000000000000000000000000005" as const,
      gatewayDomain: 26,
      outstanding: 100n,
      pending: 0n,
      availableBalance: 0n,
      availableBalanceObservedAt: new Date("2026-10-22T00:00:00Z"),
      apiConsecutiveFailures: 0,
      head: 6_400n,
    } as const;
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign: vi.fn(async () => ({ signedTransaction: "0x1234" as const })) },
      chain: {
        maxPullbackFee: vi.fn(async () => 20_000n),
        findPendingPullback: vi.fn(async () => undefined),
        writeOffPocket,
        requestPullback: vi.fn(),
        isTransferSpecHashUsed: vi.fn(async () => false),
        mintAttestation: vi.fn(),
        confirmPullback: vi.fn(),
        cancelPullback: vi.fn(),
        readPullback: vi.fn(),
        getBlockNumber: vi.fn(async () => 6_400n),
      },
      safeFetch: vi.fn(),
      gatewayTransferUrl: "http://127.0.0.1:4999/v1/transfer",
      now: () => new Date("2026-10-22T00:00:00Z"),
    };

    await expect(executePullback(input, dependencies)).resolves.toMatchObject({
      state: "written-off",
    });
    expect(writeOffPocket).toHaveBeenCalledWith(input.pocket, "0x1234");
    expect(dependencies.safeFetch).not.toHaveBeenCalled();
  });

  it("builds a same-chain burn intent that returns USDC only to the vault", () => {
    const intent = buildPullbackBurnIntent({
      vault: "0x0000000000000000000000000000000000000001" as const,
      pocket: "0x0000000000000000000000000000000000000002",
      gatewayWallet: "0x0000000000000000000000000000000000000003",
      gatewayMinter: "0x0000000000000000000000000000000000000004",
      usdc: "0x0000000000000000000000000000000000000005",
      gatewayDomain: 26,
      value: 800_000n,
      maxFee: 10_000n,
      maxBlockHeight: 5000n,
      salt: `0x${"ab".repeat(32)}`,
    });
    expect(intent.intent.spec.destinationRecipient).toBe(`0x${"0".repeat(63)}1`);
    expect(intent.intent.spec.destinationCaller).toBe(`0x${"0".repeat(64)}`);
    expect(intent.intent.spec.value).toBe(800_000n);
    expect(transferSpecHash(intent.intent.spec)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(transferSpecBytes(intent.intent.spec)).toMatch(/^0x[0-9a-f]+$/);
  });

  it("keeps cancel delay aligned with the contract constant", async () => {
    const filename = fileURLToPath(
      new URL("../../../../contracts/src/libraries/CzarConstants.sol", import.meta.url),
    );
    const constants = await readFile(filename, "utf8");
    const parsed = /PULLBACK_CANCEL_DELAY_BLOCKS\s*=\s*([\d_]+)/.exec(constants)?.[1];
    expect(Number(parsed?.replaceAll("_", ""))).toBe(Number(PULLBACK_CANCEL_DELAY_BLOCKS));
    expect(Number(parsed?.replaceAll("_", ""))).toBe(3000);
  });

  it("uses the signed burn intent, obtains an attestation, mints and confirms", async () => {
    await getPool().query(
      `INSERT INTO payer_pullback_gateway_failures
       (plan_id,step_index,envelope_ref,pocket,value,unavailable_since,state)
       VALUES ($1,0,$2,$3,'1000',$4,'pending')`,
      [
        PLAN_ID,
        "eip155:5042002:0x0000000000000000000000000000000000000001:1",
        "0x0000000000000000000000000000000000000002",
        new Date("2026-10-22T00:00:00Z"),
      ],
    );
    const safeFetch = vi.fn(async (_url: string, options?: { body?: Uint8Array }) => {
      const request = JSON.parse(new TextDecoder().decode(options?.body)) as unknown;
      expect(request).toEqual([
        {
          burnIntent: {
            maxBlockHeight: "10000",
            maxFee: "10000",
            spec: expect.objectContaining({ value: "840000" }),
          },
          signature: "0xbeef",
          contractSigner: true,
        },
      ]);
      return {
        status: 201,
        url: "http://127.0.0.1:4999/v1/transfer",
        headers: {},
        body: new TextEncoder().encode(
          JSON.stringify({
            transferId: "transfer-fixture-1",
            attestation: "0x1234",
            signature: "0xabcd",
          }),
        ),
      };
    });
    const calls: string[] = [];
    let minted = false;
    let mintCalls = 0;
    const chain = {
      maxPullbackFee: vi.fn(async () => 20_000n),
      writeOffPocket: vi.fn(async () => "write-off-tx"),
      findPendingPullback: vi.fn(async () => undefined),
      requestPullback: vi.fn(async (_request: { transaction: `0x${string}` }) => ({
        pullbackId: 9n,
        value: 840_000n,
        maxFee: 10_000n,
        maxBlockHeight: 10_000n,
        salt: `0x${"ab".repeat(32)}` as `0x${string}`,
        transferSpecHash: `0x${"cd".repeat(32)}` as `0x${string}`,
        state: "Pending" as const,
      })),
      isTransferSpecHashUsed: vi.fn(async () => minted),
      mintAttestation: vi.fn(async () => {
        mintCalls += 1;
        if (mintCalls === 1) throw new Error("simulated executor exit before gatewayMint");
        minted = true;
        calls.push("mint");
        return "mint-tx";
      }),
      confirmPullback: vi.fn(async () => {
        calls.push("confirm");
        return "confirm-tx";
      }),
      cancelPullback: vi.fn(),
      sendVaultTransaction: vi.fn(async () => undefined),
      readPullback: vi.fn(async () => undefined),
      getBlockNumber: vi.fn(async () => 6_400n),
    };
    const signer = {
      sign: vi.fn(async (_caller: string, request: { kind: string }) => {
        if (request.kind === "gateway-burn")
          return { signature: "0xbeef" as const, digest: `0x${"ef".repeat(32)}` as const };
        return { signedTransaction: "0x1234" as const };
      }),
    };
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      vault: "0x0000000000000000000000000000000000000001",
      pocket: "0x0000000000000000000000000000000000000002",
      gatewayWallet: "0x0000000000000000000000000000000000000003",
      gatewayMinter: "0x0000000000000000000000000000000000000004",
      usdc: "0x0000000000000000000000000000000000000005",
      gatewayDomain: 26,
      outstanding: 900_000n,
      pending: 0n,
      availableBalance: 850_000n,
      availableBalanceObservedAt: new Date("2026-10-22T00:00:00Z"),
      apiConsecutiveFailures: 0,
      head: 6_400n,
      attempt: 0,
    } as const;
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer,
      chain,
      safeFetch,
      gatewayTransferUrl: "http://127.0.0.1:4999/v1/transfer",
      now: () => new Date("2026-10-22T00:00:00Z"),
    };
    await expect(executePullback(input, dependencies)).rejects.toThrow(
      "simulated executor exit before gatewayMint",
    );
    const result = await executePullback(input, dependencies);
    expect(result).toMatchObject({ state: "confirmed", value: "840000" });
    expect(chain.requestPullback).toHaveBeenCalledOnce();
    expect(safeFetch).toHaveBeenCalledOnce();
    expect(signer.sign).toHaveBeenCalledTimes(4);
    expect(signer.sign.mock.calls.filter((call) => call[1]?.kind === "gateway-burn")).toHaveLength(
      1,
    );
    expect(chain.mintAttestation).toHaveBeenCalledTimes(2);
    const failures = await getPool().query(
      "SELECT 1 FROM payer_pullback_gateway_failures WHERE plan_id=$1",
      [PLAN_ID],
    );
    expect(failures.rowCount).toBe(0);
    expect(chain.requestPullback).toHaveBeenCalledWith(
      expect.objectContaining({ value: 840_000n, maxFee: 10_000n, maxBlockHeight: 10_000n }),
    );
    expect(calls).toEqual(["mint", "confirm"]);
  });

  it("re-broadcasts a stored pullback request transaction after interruption", async () => {
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      vault: "0x0000000000000000000000000000000000000001" as const,
      pocket: "0x0000000000000000000000000000000000000002" as const,
      gatewayWallet: "0x0000000000000000000000000000000000000003" as const,
      gatewayMinter: "0x0000000000000000000000000000000000000004" as const,
      usdc: "0x0000000000000000000000000000000000000005" as const,
      gatewayDomain: 26,
      outstanding: 900_000n,
      pending: 0n,
      availableBalance: 850_000n,
      availableBalanceObservedAt: new Date("2026-10-22T00:00:00Z"),
      apiConsecutiveFailures: 0,
      head: 6_400n,
    } as const;
    let requestCount = 0;
    const transaction = vi.fn(async (_input: { transaction: `0x${string}` }) => {
      requestCount += 1;
      if (requestCount === 1) throw new Error("executor interrupted before request receipt");
      return {
        pullbackId: 9n,
        value: 840_000n,
        maxFee: 10_000n,
        maxBlockHeight: 10_000n,
        salt: `0x${"ab".repeat(32)}` as const,
        transferSpecHash: `0x${"cd".repeat(32)}` as const,
        state: "Pending" as const,
      };
    });
    let minted = false;
    const chain = {
      maxPullbackFee: vi.fn(async () => 20_000n),
      writeOffPocket: vi.fn(async () => "write-off-tx"),
      findPendingPullback: vi.fn(async () => undefined),
      requestPullback: transaction,
      isTransferSpecHashUsed: vi.fn(async () => minted),
      mintAttestation: vi.fn(async () => {
        minted = true;
        return "mint-tx";
      }),
      confirmPullback: vi.fn(async () => "confirm-tx"),
      cancelPullback: vi.fn(async () => "cancel-tx"),
      readPullback: vi.fn(async () => undefined),
      getBlockNumber: vi.fn(async () => 6_400n),
    };
    const signer = {
      sign: vi.fn(async (_caller: string, request: SignRequest) =>
        request.kind === "gateway-burn"
          ? { signature: "0xbeef" as const, digest: `0x${"ef".repeat(32)}` as const }
          : { signedTransaction: "0x1234" as const },
      ),
    };
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer,
      chain,
      safeFetch: vi.fn(async () => ({
        status: 201,
        url: "http://127.0.0.1:4999/v1/transfer",
        headers: {},
        body: new TextEncoder().encode(
          JSON.stringify({ transferId: "new", attestation: "0x12", signature: "0x34" }),
        ),
      })),
      gatewayTransferUrl: "http://127.0.0.1:4999/v1/transfer",
      now: () => new Date("2026-10-22T00:00:00Z"),
    };

    await expect(executePullback(input, dependencies)).rejects.toThrow("executor interrupted");
    await expect(executePullback(input, dependencies)).resolves.toMatchObject({
      state: "confirmed",
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction.mock.calls.map(([args]) => args.transaction)).toEqual(["0x1234", "0x1234"]);
    const requestCalls = signer.sign.mock.calls.filter(([, request]) => {
      const payload = request.payload;
      return (
        request.kind === "vault-call" &&
        typeof payload === "object" &&
        payload !== null &&
        "selector" in payload &&
        payload.selector === "requestPullback"
      );
    });
    expect(requestCalls).toHaveLength(1);
  });

  it("cancels only after the expiry plus contract delay and records the cancellation", async () => {
    const cancelPullback = vi.fn(async () => "cancel-tx");
    let head = 3_999n;
    const chain = {
      maxPullbackFee: vi.fn(async () => 20_000n),
      writeOffPocket: vi.fn(async () => "write-off-tx"),
      findPendingPullback: vi.fn(async () => undefined),
      requestPullback: vi.fn(),
      isTransferSpecHashUsed: vi.fn(async () => false),
      mintAttestation: vi.fn(),
      confirmPullback: vi.fn(),
      cancelPullback,
      getBlockNumber: vi.fn(async () => head),
      readPullback: vi.fn(async () => ({
        pullbackId: 9n,
        value: 100n,
        maxFee: 10n,
        maxBlockHeight: 1_000n,
        salt: `0x${"ab".repeat(32)}` as `0x${string}`,
        transferSpecHash: `0x${"cd".repeat(32)}` as `0x${string}`,
        state: "Pending" as const,
      })),
    };
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      pullbackId: 9n,
      vault: "0x0000000000000000000000000000000000000001" as const,
      gatewayMinter: "0x0000000000000000000000000000000000000004" as const,
    };
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign: vi.fn(async () => ({ signedTransaction: "0x1234" as const })) },
      chain,
      safeFetch: vi.fn(),
      gatewayTransferUrl: "http://127.0.0.1:4999/v1/transfer",
      now: () => new Date("2026-10-22T00:00:00Z"),
    };
    await expect(cancelExpiredPullback(input, dependencies)).rejects.toThrow(
      "Pullback cancellation delay has not elapsed.",
    );
    expect(cancelPullback).not.toHaveBeenCalled();
    head = 4_000n;
    await expect(cancelExpiredPullback(input, dependencies)).resolves.toBe("cancel-tx");
    expect(cancelPullback).toHaveBeenCalledOnce();
  });

  it("requests a fresh pullback after cancelling an expired intent", async () => {
    const old = {
      pullbackId: 9n,
      value: 100n,
      maxFee: 10n,
      maxBlockHeight: 1_000n,
      salt: `0x${"ab".repeat(32)}` as `0x${string}`,
      transferSpecHash: `0x${"cd".repeat(32)}` as `0x${string}`,
      state: "Pending" as const,
    };
    await appendExecutionPhase(getPool(), {
      planId: PLAN_ID,
      stepIndex: 0,
      attempt: 0,
      phase: "pullback.requested",
      payload: {
        pullbackId: "9",
        value: "100",
        maxFee: "10",
        maxBlockHeight: "1000",
        salt: old.salt,
        transferSpecHash: old.transferSpecHash,
        state: old.state,
      },
    });
    await appendExecutionPhase(getPool(), {
      planId: PLAN_ID,
      stepIndex: 0,
      attempt: 0,
      phase: "pullback.transfer.result",
      payload: { pullbackId: "9", attestation: "0xold", signature: "0xold" },
    });
    await appendExecutionPhase(getPool(), {
      planId: PLAN_ID,
      stepIndex: 0,
      attempt: 0,
      phase: "pullback.mint.sent",
      payload: { pullbackId: "9", transaction: "0xoldtx" },
    });
    let newPullbackMinted = false;
    const chain = {
      maxPullbackFee: vi.fn(async () => 20_000n),
      writeOffPocket: vi.fn(async () => "write-off-tx"),
      findPendingPullback: vi.fn(async () => undefined),
      readPullback: vi.fn(async () => old),
      getBlockNumber: vi.fn(async () => 4_000n),
      cancelPullback: vi.fn(async () => "cancel-tx"),
      isTransferSpecHashUsed: vi.fn(
        async (hash: `0x${string}`) => hash === `0x${"12".repeat(32)}` && newPullbackMinted,
      ),
      requestPullback: vi.fn(async (_request: { transaction: `0x${string}` }) => ({
        ...old,
        pullbackId: 10n,
        salt: `0x${"ef".repeat(32)}` as `0x${string}`,
        transferSpecHash: `0x${"12".repeat(32)}` as `0x${string}`,
      })),
      mintAttestation: vi.fn(async () => {
        newPullbackMinted = true;
        return "mint-10";
      }),
      confirmPullback: vi.fn(async () => "confirm-tx"),
    };
    const signer = {
      sign: vi.fn(async (_caller: string, request: { kind: string }) =>
        request.kind === "gateway-burn"
          ? { signature: "0xbeef" as const, digest: `0x${"ef".repeat(32)}` as const }
          : { signedTransaction: "0x1234" as const },
      ),
    };
    const safeFetch = vi.fn(async () => ({
      status: 201,
      url: "http://127.0.0.1:4999/v1/transfer",
      headers: {},
      body: new TextEncoder().encode(
        JSON.stringify({ transferId: "new", attestation: "0x12", signature: "0x34" }),
      ),
    }));
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer,
      chain,
      safeFetch,
      gatewayTransferUrl: "http://127.0.0.1:4999/v1/transfer",
      now: () => new Date("2026-10-22T00:00:00Z"),
    };
    await cancelExpiredPullback(
      {
        planId: PLAN_ID,
        stepIndex: 0,
        envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
        pullbackId: 9n,
        vault: "0x0000000000000000000000000000000000000001" as const,
        gatewayMinter: "0x0000000000000000000000000000000000000004" as const,
      },
      dependencies,
    );
    await expect(
      executePullback(
        {
          planId: PLAN_ID,
          stepIndex: 0,
          envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
          vault: "0x0000000000000000000000000000000000000001",
          pocket: "0x0000000000000000000000000000000000000002",
          gatewayWallet: "0x0000000000000000000000000000000000000003",
          gatewayMinter: "0x0000000000000000000000000000000000000004",
          usdc: "0x0000000000000000000000000000000000000005",
          gatewayDomain: 26,
          outstanding: 900_000n,
          pending: 0n,
          availableBalance: 850_000n,
          availableBalanceObservedAt: new Date("2026-10-22T00:00:00Z"),
          apiConsecutiveFailures: 0,
          head: 6_400n,
          attempt: 0,
        },
        dependencies,
      ),
    ).resolves.toMatchObject({ state: "confirmed", pullbackId: "10" });
    expect(chain.requestPullback).toHaveBeenCalledOnce();
    expect(chain.requestPullback.mock.calls[0]?.[0].transaction).toBe("0x1234");
    expect(safeFetch).toHaveBeenCalledOnce();
    expect(chain.mintAttestation).toHaveBeenCalledOnce();
    const phases = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
    expect(
      phases.findLast((row) => row.phase === "pullback.transfer.result")?.payload["pullbackId"],
    ).toBe("10");
  });

  it("uses the slow withdrawal path after Gateway API downtime and asks for manual credit", async () => {
    let head = 100n;
    let initiated = false;
    let withdrawn = false;
    let usdc = 0n;
    const chain = {
      getBlockNumber: vi.fn(async () => head),
      withdrawalBlock: vi.fn(async () => (initiated ? 200n : 0n)),
      pocketUsdcBalance: vi.fn(async () => usdc),
      sendPocketTransaction: vi.fn(async (_transaction: string, kind: string) => {
        if (kind === "pullback.slow.initiate") initiated = true;
        if (kind === "pullback.slow.withdraw") {
          withdrawn = true;
          usdc = 825_000n;
        }
        if (kind === "pocket-return:usdc") usdc = 0n;
        return `${kind}-tx`;
      }),
    };
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign: vi.fn(async () => ({ signedTransaction: "0x1234" as const })) },
      chain,
      now: () => new Date("2026-10-22T00:00:00Z"),
    };
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      pocket: "0x0000000000000000000000000000000000000002",
      apiUnavailableSince: new Date("2026-10-20T00:00:00Z"),
      value: 825_000n,
    } as const;
    await expect(executeSlowPullbackFallback(input, dependencies)).resolves.toMatchObject({
      state: "waiting-withdrawal",
    });
    expect(initiated).toBe(true);
    head = 200n;
    await expect(executeSlowPullbackFallback(input, dependencies)).resolves.toMatchObject({
      state: "waiting-return",
    });
    expect(withdrawn).toBe(true);
    await expect(executeSlowPullbackFallback(input, dependencies)).resolves.toMatchObject({
      state: "manual-return-required",
      amount: "825000",
    });
    expect(usdc).toBe(0n);
  });

  it("does not initiate another slow withdrawal when the Gateway already has one open", async () => {
    const sendPocketTransaction = vi.fn(async () => "unexpected-tx");
    const sign = vi.fn(async () => ({ signedTransaction: "0x1234" as const }));
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign },
      chain: {
        getBlockNumber: vi.fn(async () => 100n),
        withdrawalBlock: vi.fn(async () => 200n),
        pocketUsdcBalance: vi.fn(async () => 0n),
        sendPocketTransaction,
      },
      now: () => new Date("2026-10-22T00:00:00Z"),
    };
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      pocket: "0x0000000000000000000000000000000000000002",
      apiUnavailableSince: new Date("2026-10-20T00:00:00Z"),
      value: 825_000n,
    } as const;

    await expect(executeSlowPullbackFallback(input, dependencies)).resolves.toMatchObject({
      state: "waiting-withdrawal",
    });
    expect(sign).not.toHaveBeenCalled();
    expect(sendPocketTransaction).not.toHaveBeenCalled();
    const phases = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
    expect(phases.map((phase) => phase.phase)).toContain("pullback.slow.initiated");
  });

  it.each([
    "gateway-figure-missing",
    "pocket-spend-after-observation",
    "slow-withdraw-value-mismatch",
  ])("records %s and waits for the next Gateway observation", async (rule) => {
    const sendPocketTransaction = vi.fn();
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: {
        sign: vi.fn(async () => {
          throw new Denied(rule);
        }),
      },
      chain: {
        getBlockNumber: vi.fn(async () => 100n),
        withdrawalBlock: vi.fn(async () => 0n),
        pocketUsdcBalance: vi.fn(async () => 0n),
        sendPocketTransaction,
      },
      now: () => new Date("2026-10-22T00:00:00Z"),
    };
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      pocket: "0x0000000000000000000000000000000000000002",
      apiUnavailableSince: new Date("2026-10-20T00:00:00Z"),
      value: 825_000n,
    } as const;

    await expect(executeSlowPullbackFallback(input, dependencies)).resolves.toMatchObject({
      state: "waiting-withdrawal",
    });
    expect(sendPocketTransaction).not.toHaveBeenCalled();
    const phases = await getExecutionTrace(getPool(), PLAN_ID, 0, 0);
    expect(phases.map((phase) => phase.phase)).toContain(`pullback.slow.${rule}`);
  });

  it("returns Closed-pocket dust to the vault without an owner manual-return prompt", async () => {
    let head = 100n;
    let withdrawalBlock = 0n;
    let usdc = 0n;
    const sendPocketTransaction = vi.fn(async (_transaction: string, kind: string) => {
      if (kind === "pullback.slow.initiate") withdrawalBlock = 200n;
      if (kind === "pullback.slow.withdraw") {
        usdc = 5_000n;
        head = 200n;
      }
      if (kind === "pocket-return:usdc") usdc = 0n;
      return `${kind}-tx`;
    });
    const dependencies = {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign: vi.fn(async () => ({ signedTransaction: "0x1234" as const })) },
      chain: {
        getBlockNumber: vi.fn(async () => head),
        withdrawalBlock: vi.fn(async () => withdrawalBlock),
        pocketUsdcBalance: vi.fn(async () => usdc),
        sendPocketTransaction,
      },
      now: () => new Date("2026-10-22T00:00:00Z"),
    };
    const input = {
      planId: PLAN_ID,
      stepIndex: 0,
      envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
      pocket: "0x0000000000000000000000000000000000000002",
      apiUnavailableSince: new Date("2026-10-21T23:59:00Z"),
      value: 8_000n,
      trigger: "closed-dust" as const,
    };

    await expect(executeSlowPullbackFallback(input as never, dependencies)).resolves.toMatchObject({
      state: "waiting-withdrawal",
    });
    expect(sendPocketTransaction).toHaveBeenNthCalledWith(1, "0x1234", "pullback.slow.initiate");
    expect(dependencies.signer.sign).toHaveBeenLastCalledWith(
      "cz-15",
      expect.objectContaining({ payload: expect.objectContaining({ value: "8000" }) }),
    );
    head = 200n;
    await expect(executeSlowPullbackFallback(input as never, dependencies)).resolves.toMatchObject({
      state: "waiting-return",
    });
    await expect(executeSlowPullbackFallback(input as never, dependencies)).resolves.toMatchObject({
      state: "returned-to-vault",
      amount: "5000",
    });
    expect(sendPocketTransaction).toHaveBeenLastCalledWith("0x1234", "pocket-return:usdc");
  });
});
