import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { transferSpecBytes, transferSpecHash } from "@czar/hashing";
import {
  buildPullbackBurnIntent,
  cancelExpiredPullback,
  calculatePullbackValue,
  executeSlowPullbackFallback,
  pullbackMaxBlockHeight,
  PULLBACK_CANCEL_DELAY_BLOCKS,
} from "#src/payer/pullback";
import { setupDatabase } from "#test/db";
import { appendExecutionPhase } from "#src/payer/executions";
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
  it("persists the first Gateway API failure time for the scheduler", async () => {
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

  it("builds a same-chain burn intent that returns USDC only to the vault", () => {
    const intent = buildPullbackBurnIntent({
      vault: "0x0000000000000000000000000000000000000001",
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
    const safeFetch = vi.fn(async (_url: string, options?: { body?: Uint8Array }) => {
      const request = JSON.parse(new TextDecoder().decode(options?.body)) as Record<
        string,
        unknown
      >;
      expect(request["contractSigner"]).toBe(true);
      expect(request["transferSpec"]).toMatch(/^0x[0-9a-f]+$/);
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
    expect(chain.requestPullback).toHaveBeenCalledWith(
      expect.objectContaining({ value: 840_000n, maxFee: 10_000n, maxBlockHeight: 10_000n }),
    );
    expect(calls).toEqual(["mint", "confirm"]);
  });

  it("cancels only after the expiry plus contract delay and records the cancellation", async () => {
    const cancelPullback = vi.fn(async () => "cancel-tx");
    let head = 3_999n;
    const chain = {
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
    let transferCheck = 0;
    const chain = {
      findPendingPullback: vi.fn(async () => undefined),
      readPullback: vi.fn(async () => old),
      getBlockNumber: vi.fn(async () => 4_000n),
      cancelPullback: vi.fn(async () => "cancel-tx"),
      isTransferSpecHashUsed: vi.fn(async () => ++transferCheck > 1),
      requestPullback: vi.fn(async (_request: { transaction: `0x${string}` }) => ({
        ...old,
        pullbackId: 10n,
        salt: `0x${"ef".repeat(32)}` as `0x${string}`,
        transferSpecHash: `0x${"12".repeat(32)}` as `0x${string}`,
      })),
      mintAttestation: vi.fn(),
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
          head: 6_400n,
          attempt: 0,
        },
        dependencies,
      ),
    ).resolves.toMatchObject({ state: "confirmed", pullbackId: "10" });
    expect(transferCheck).toBe(3);
    expect(chain.requestPullback).toHaveBeenCalledOnce();
    expect(chain.requestPullback.mock.calls[0]?.[0].transaction).toBe("0x1234");
    expect(safeFetch).toHaveBeenCalledOnce();
  });

  it("uses the slow withdrawal path after Gateway API downtime and asks for manual credit", async () => {
    let head = 100n;
    let initiated = false;
    let withdrawn = false;
    let usdc = 0n;
    const chain = {
      getBlockNumber: vi.fn(async () => head),
      withdrawalBlock: vi.fn(async () => 200n),
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
});
