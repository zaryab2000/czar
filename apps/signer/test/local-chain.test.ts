// CZAR_LOCAL_CHAIN signer suite (SCR-146 §3.3 run 2, SCR-150 §5): every case spawns its own pinned
// `arc-anvil --network arc` on a loopback port in 18610-18619, so `CZAR_LOCAL_CHAIN=1 vitest run
// test/local-chain.test.ts` is one repeatable command. Needs `arc-anvil`/`arc-forge` on PATH, the Foundry
// artifacts (`cd contracts && FOUNDRY_PROFILE=arc arc-forge build`) and Postgres on 127.0.0.1:15432.
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  toBytes,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
  type TransactionSerializableEIP1559,
} from "viem";
import { loadConfig } from "@czar/config";
import { derivedNonce, paymentRefHash, slReceiptDigest, type SlReceipt } from "@czar/hashing";
import type { PaymentRef } from "@czar/schemas";
import { czarVaultAbi, withFeeFloor } from "@czar/vault-client";
import { CANONICAL_GATEWAY_WALLET } from "../../../ops/local/gateway-doubles.ts";
import { runGasRefill, startGasRefillJob } from "#src/gas-refill";
import { returnableAtomic, type Denied } from "#src/policy";
import { createRpcGasRefillAdapters, createRpcTransactionPreparer } from "#src/runtime-adapters";
import { pocketReturnGasReserve } from "#src/service";
import { harness, NETWORK } from "#test/helpers";
import {
  chainNow,
  deployCzar,
  REPO_ROOT,
  startArcNode,
  submitSigned,
  type ArcNode,
} from "#test/local-chain/arc-node";
import {
  CALL_COUNT,
  CHAIN_ID,
  ENVELOPE_ID,
  k3VaultCall,
  k4Transaction,
  PAYEE,
  PLAN_ID,
  POCKET_FUNDING,
  PORTS,
  reservationIdOf,
  startRun2,
  STEP_CAP,
  UNIT_AMOUNT,
  waitForDb,
  type Run2,
} from "#test/local-chain/scenario";
import { setField } from "#test/local-chain/storage";

const enabled = process.env["CZAR_LOCAL_CHAIN"] === "1";
const config = loadConfig();
const USDC = NETWORK.usdc;
const GATEWAY_WALLET = CANONICAL_GATEWAY_WALLET as Address;
const ERC1271_MAGIC = "0x1626ba7e";
const RESERVATION_TTL_SEC = BigInt(config.get("payer.reservationTtlSeconds") as number);
/** Circle's ERC-8183 job escrow, the deployment's `jobEscrow` (contracts/script/Deploy.s.sol:23, A4-01). */
const CIRCLE_JOB_ESCROW = "0x0747eef0706327138c69792bf28cd525089e4583";
const SECONDS_PER_HOUR = 3_600;
const HOLD_SEC = Number(config.get("payer.manualReturnHoldHours")) * SECONDS_PER_HOUR;
const API_DOWN_HOURS = Number(config.get("payer.pullbackApiDownHours"));
const WRITE_OFF_DUST =
  BigInt(config.get("payer.pullbackMaxFeeAtomic") as number) +
  BigInt(config.get("payer.pullbackSafetyAtomic") as number);
/** One USDC in Arc's 18-decimal native balance. */
const ONE_USDC_NATIVE = 10n ** 18n;
/** Returns CZ-15 may need when the fee falls between them; each round can only shrink the remainder. */
const MAX_RETURN_ROUNDS = 5;
const RULE = "writeoff-manual-return-overdue";
const RETURN_VAULT: Address = "0x00000000000000000000000000000000000c2a21";
const POCKET_START_NATIVE = 1_234_567_891_234_567_891n;
const ARC_USDC_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
]);
const USDC_ABI = parseAbi([
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
  "function approve(address spender,uint256 value) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const GATEWAY_ABI = parseAbi([
  "function depositFor(address token,address depositor,uint256 value)",
  "function testBurn(address token,address depositor,uint256 value,address recipient)",
  "function withdrawalBlock(address token,address depositor) view returns (uint256)",
]);

describe.skipIf(!enabled)("K8 local arc-anvil acceptance", () => {
  let node: ArcNode | undefined;
  afterAll(() => node?.stop());

  it("deploys locally, commits a zero test root, and pays gas from K8", async () => {
    node = await startArcNode({ port: PORTS.k8Chain });
    const t = await createK8Signer(node);
    const deployment = await deployCzar(node, "signer-k8-local", {
      K3: t.address("K3"),
      K5: t.address("K5"),
      K6: t.address("K6"),
      K7: t.address("K7"),
      K20: t.address("K20"),
    });
    try {
      t.network.openEvidenceLog = deployment.OpenEvidenceLog;
      expect(deployment.chainId).toBe(31337);
      expect({
        usdc: deployment.usdc.toLowerCase(),
        gatewayWallet: deployment.gatewayWallet.toLowerCase(),
        gatewayMinter: deployment.gatewayMinter.toLowerCase(),
        gatewayDomain: deployment.gatewayDomain,
        jobEscrow: deployment.jobEscrow.toLowerCase(),
      }).toEqual({
        usdc: NETWORK.usdc,
        gatewayWallet: NETWORK.gatewayWallet,
        gatewayMinter: NETWORK.gatewayMinter,
        gatewayDomain: NETWORK.gatewayDomain,
        jobEscrow: CIRCLE_JOB_ESCROW,
      });
      await assertK8Commit(t, node, deployment.OpenEvidenceLog);
      await assertGasRefill(t, node);
      await assertGasRefillAtStart(t, node);
    } finally {
      await deployment.remove();
    }
  }, 180_000);
});

describe.skipIf(!enabled)("SCR-146 §3.3 run 2: signer against real chain reads", () => {
  let run: Run2;
  beforeAll(async () => {
    run = await startRun2();
    await waitForDb(
      run,
      "the indexed envelope",
      {
        text: "SELECT 1 FROM envelopes WHERE lower(vault)=lower($1) AND envelope_id=$2",
        values: [run.vault, ENVELOPE_ID.toString()],
      },
      (rows) => rows.length === 1,
    );
  }, 300_000);
  afterAll(async () => {
    await run?.stop();
  }, 60_000);

  describe("TA-01 sl-receipt settled check", () => {
    it("signs only for an x402 authorization the indexer saw settled on chain", async () => {
      const validBefore = BigInt(await chainNow(run.node)) + RESERVATION_TTL_SEC;
      const reserved = await k3VaultCall(run, "reserve", {
        envelopeId: ENVELOPE_ID.toString(),
        stepIndex: "0",
        payee: PAYEE,
        stepCap: STEP_CAP.toString(),
        proof: run.proofs.payee,
        unitAmount: UNIT_AMOUNT.toString(),
        count: String(CALL_COUNT),
        validBefore: validBefore.toString(),
      });
      const reservationId = reservationIdOf(reserved);
      // Index 0 is paid and settled, index 1 is paid (AuthorizationUsed) but not settled, index 2 is unused.
      await payAuthorization(run, reservationId, 0, validBefore);
      await payAuthorization(run, reservationId, 1, validBefore);
      await relayerSettle(run, reservationId, [0]);
      await waitForAuthorizations(
        run,
        reservationId,
        (rows) =>
          rows.some((row) => row.index === 0 && row.settled) &&
          rows.some((row) => row.index === 1 && row.used && !row.settled),
      );

      await expectReceiptSigned(run, x402PaymentRef(run, reservationId, 0, validBefore));
      for (const index of [1, 2]) {
        await expectDenied(
          signReceipt(run, x402PaymentRef(run, reservationId, index, validBefore)),
          "payment-not-settled",
        );
      }
      const denials = await run.db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit WHERE action='signer:sl-receipt'
           AND outcome='kms_denied' AND object_ids->0->>'rule'='payment-not-settled'`,
      );
      expect(denials.rows[0]?.n).toBe("2");

      await relayerSettle(run, reservationId, [1]);
      await waitForAuthorizations(run, reservationId, (rows) =>
        rows.some((row) => row.index === 1 && row.settled),
      );
      await expectReceiptSigned(run, x402PaymentRef(run, reservationId, 1, validBefore));
    }, 180_000);
  });

  describe("SCR-145 overdue manual-return write-off", () => {
    let manualReturn: ManualReturn;
    beforeAll(async () => {
      manualReturn = await runSlowRouteToOverdueReturn(run);
    }, 300_000);

    it("starts from a stale Gateway figure with all eight predicates holding", async () => {
      await expectStaleFigure(run);
      await expectExceptionSigns(run);
    }, 120_000);

    it("predicate 1 failing (fresh figure at or below the fee): the normal rule signs, no exception", async () => {
      run.gatewayApi.setUp(true);
      await waitForFigure(run, (row) => row.failures === 0 && row.available === "0");
      const before = run.t.alerts.length;
      await writeOff(run);
      const row = await lastAudit(run, "signer:vault-call");
      expect(row.outcome).toBe("signed");
      expect(row.rule).toBeUndefined();
      expect(run.t.alerts).toHaveLength(before);
    }, 120_000);

    it("predicate 1 failing (fresh figure above the fee): denied by the normal rule", async () => {
      const extra = WRITE_OFF_DUST * 2n;
      await gatewayDeposit(run, extra);
      await waitForFigure(run, (row) => row.failures === 0 && row.available === extra.toString());
      await expectDenied(writeOff(run), "gateway-balance-not-dust");
      await sendAsController(run, GATEWAY_WALLET, GATEWAY_ABI, "testBurn", [
        USDC,
        run.pocket,
        extra,
        run.node.sender,
      ]);
      run.gatewayApi.setUp(false);
      await expectStaleFigure(run);
      await expectExceptionSigns(run);
    }, 120_000);

    const alone: readonly {
      readonly name: string;
      readonly denial: string;
      readonly breakOnly: (run: Run2, manual: ManualReturn) => Promise<() => Promise<void>>;
    }[] = [
      {
        name: "2: the pocket record is not Funded or Draining",
        denial: "gateway-balance-stale",
        breakOnly: (r) => setPocketField(r, "state", POCKET_STATE_REGISTERED),
      },
      {
        name: "2: the envelope is not Open",
        denial: "gateway-balance-stale",
        breakOnly: (r) =>
          setField(
            r.node,
            {
              address: r.vault,
              contract: "CzarVault",
              path: ["_s", "envelopes", { key: ENVELOPE_ID, type: "uint64" }, "state"],
            },
            ENVELOPE_STATE_CLOSED,
          ),
      },
      {
        name: "3: the on-chain pendingPullback is not zero",
        denial: "gateway-balance-stale",
        breakOnly: (r) => setPocketField(r, "pendingPullback", 1n),
      },
      {
        name: "4: GatewayWallet.withdrawingBalance is not zero (the open-withdrawal check comes first)",
        denial: "slow-withdrawal-open",
        breakOnly: (r) =>
          setField(
            r.node,
            {
              address: GATEWAY_WALLET,
              contract: "MockGatewayWallet",
              path: [
                "_withdrawing",
                { key: USDC, type: "address" },
                { key: r.pocket, type: "address" },
              ],
            },
            1n,
          ),
      },
      {
        name: "5: the pocket EOA is not empty (USDC is returnable)",
        denial: "gateway-balance-stale",
        breakOnly: async (r) => {
          const remainder = await r.node.publicClient.getBalance({ address: r.pocket });
          await r.node.testClient.setBalance({
            address: r.pocket,
            value: remainder + ONE_USDC_NATIVE,
          });
          expect(await r.pocketReturnable()).toBeGreaterThan(0n);
          return () => r.node.testClient.setBalance({ address: r.pocket, value: remainder });
        },
      },
      {
        name: "6: no signed signer:pocket-slow-withdraw audit row",
        denial: "gateway-balance-stale",
        breakOnly: (r) => hideAudit(r, "signer:pocket-slow-withdraw"),
      },
      {
        name: "6: no signed signer:pocket-return audit row",
        denial: "gateway-balance-stale",
        breakOnly: (r) => hideAudit(r, "signer:pocket-return"),
      },
      {
        name: "7: the CZ-15 row is not manual-return-required",
        denial: "gateway-balance-stale",
        breakOnly: (r) => setFailureRow(r, "state", "returned-to-vault"),
      },
      {
        name: "7: the CZ-15 row is a closed-pocket dust row (closed_pocket = true)",
        denial: "gateway-balance-stale",
        breakOnly: (r) => setFailureRow(r, "closed_pocket", true),
      },
      {
        name: "7: return_tx is a transaction without the pocket-to-vault Transfer",
        denial: "gateway-balance-stale",
        breakOnly: (r, manual) => setFailureRow(r, "return_tx", manual.withdrawTx),
      },
      {
        name: "7: returned_amount does not match the Transfer value",
        denial: "gateway-balance-stale",
        breakOnly: (r, manual) =>
          setFailureRow(r, "returned_amount", (manual.returnedAmount + 1n).toString()),
      },
      {
        name: "7: the return is not yet older than payer.manualReturnHoldHours",
        denial: "gateway-balance-stale",
        breakOnly: async (r, manual) => {
          r.pinClock(manual.returnTimestamp + HOLD_SEC - 1);
          return async () => r.pinClock(undefined);
        },
      },
    ];
    for (const predicate of alone) {
      it(`predicate ${predicate.name}: denied ${predicate.denial}, signs again once restored`, async () => {
        await expectStaleFigure(run);
        const restore = await predicate.breakOnly(run, manualReturn);
        try {
          await nextBlockVisible(run);
          await expectDenied(writeOff(run), predicate.denial);
        } finally {
          await restore();
        }
        await nextBlockVisible(run);
        await expectExceptionSigns(run);
      }, 120_000);
    }

    it("signs under the exception with the rule, the SCR-146 §1 digest and the alert", async () => {
      await expectStaleFigure(run);
      const alertsBefore = run.t.alerts.length;
      const signedTransaction = await writeOff(run);
      const prepared = run.prepared.at(-1);
      if (prepared === undefined) throw new Error("no prepared transaction");
      const digest = keccak256(serializeTransaction(prepared));
      const {
        r: _r,
        s: _s,
        v: _v,
        yParity: _yParity,
        ...parsed
      } = parseTransaction(signedTransaction);
      const data = encodeFunctionData({
        abi: czarVaultAbi,
        functionName: "writeOffPocket",
        args: [run.pocket],
      });
      expect(parsed.to?.toLowerCase()).toBe(run.vault.toLowerCase());
      expect(parsed.data).toBe(data);
      expect(parsed.value ?? 0n).toBe(0n);
      expect(parsed.chainId).toBe(run.node.chain.id);
      expect(
        keccak256(
          serializeTransaction({ ...parsed, type: "eip1559" } as TransactionSerializableEIP1559),
        ),
      ).toBe(digest);
      const sender = await recoverTransactionAddress({
        serializedTransaction: signedTransaction as never,
      });
      expect(sender.toLowerCase()).toBe(run.t.address("K3").toLowerCase());
      const audit = await lastAudit(run, "signer:vault-call");
      expect(audit).toMatchObject({ outcome: "signed", rule: RULE, digest, keyRef: "K3" });
      const figure = await pocketFigure(run);
      expect(run.t.alerts.slice(alertsBefore)).toEqual([
        `writeoff-overdue-stale-gateway vault=${run.vault.toLowerCase()} ` +
          `pocket=${run.pocket.toLowerCase()} ` +
          `apiObservedAt=${new Date(Date.parse(figure.observedAt as string)).toISOString()} ` +
          `digest=${digest}`,
      ]);
      // The signed call would succeed on chain: simulated from K3 against the current state.
      await run.node.publicClient.call({ account: run.t.address("K3"), to: run.vault, data });
    }, 120_000);

    it("predicate 8 failing (ManualReturnRecorded after the return): denied gateway-balance-stale", async () => {
      await sendAsOwner(run, "recordManualReturn", [run.pocket, POCKET_FUNDING]);
      await waitForDb(
        run,
        "the indexed ManualReturnRecorded",
        {
          text: "SELECT 1 FROM manual_returns WHERE lower(vault)=lower($1) AND lower(pocket)=lower($2)",
          values: [run.vault, run.pocket],
        },
        (rows) => rows.length === 1,
      );
      const record = await run.node.publicClient.readContract({
        address: run.vault,
        abi: czarVaultAbi,
        functionName: "getPocket",
        args: [run.pocket],
      });
      expect(record.state).toBe(POCKET_STATE_FUNDED);
      await expectStaleFigure(run);
      await expectDenied(writeOff(run), "gateway-balance-stale");
    }, 120_000);
  });
});

describe.skipIf(!enabled)("SCR-152 pocket return on a real arc-anvil", () => {
  let node: ArcNode | undefined;
  afterAll(() => node?.stop());

  it("signs only balance - gasReserve; the return mines and leaves an empty remainder", async () => {
    node = await startArcNode({ port: PORTS.pocketReturnChain, chainId: CHAIN_ID });
    const client = node.publicClient;
    const testClient = node.testClient;
    const usdcOf = (address: Address) =>
      client.readContract({
        address: NETWORK.usdc,
        abi: ARC_USDC_ABI,
        functionName: "balanceOf",
        args: [address],
      });
    const prepare = createRpcTransactionPreparer({
      chainId: CHAIN_ID,
      rpcUrl: node.rpcUrl,
      client,
    });
    const t = await harness({
      prepareTransaction: prepare,
      projection: {
        pocket: async () => ({
          vault: RETURN_VAULT,
          envelopeId: 1n,
          state: "Funded",
          funded: 0n,
          pendingPullback: 0n,
          slowWithdrawalOpen: false,
        }),
        pocketBalances: async (pocket) => ({
          ...t.state.balances,
          usdc: await usdcOf(pocket),
          native: await client.getBalance({ address: pocket }),
        }),
      },
    });
    await testClient.setBalance({ address: t.pocket, value: POCKET_START_NATIVE });
    const sign = (amount: bigint) =>
      t.signer.sign("cz-15", {
        keyId: "K4",
        kind: "pocket-return",
        payload: { pocket: t.pocket, kind: "usdc", amount: amount.toString() },
      });

    // What CZ-15 computes from fresh reads, with the same preparer the signer signs with.
    const reserveFor = (amount: bigint) =>
      pocketReturnGasReserve(prepare, {
        usdc: NETWORK.usdc,
        pocket: t.pocket,
        vault: RETURN_VAULT,
        amount,
      });
    const balance = await usdcOf(t.pocket);
    const first = await returnableAtomic(balance, reserveFor);
    expect(first.returnable).toBeGreaterThan(0n);
    for (const amount of [balance, first.returnable + 1n, first.returnable - 1n]) {
      await expect(sign(amount)).rejects.toMatchObject({ rule: "pocket-return-value-mismatch" });
    }

    // Each signed return mines and leaves at most its gasReserve. The fee can fall after a block, which makes part
    // of that remainder returnable again (SCR-152 §2: "empty" is judged at the current fee), so CZ-15 returns
    // until nothing is returnable.
    let returned = 0n;
    for (let round = 0; round < MAX_RETURN_ROUNDS; round += 1) {
      const before = await usdcOf(t.pocket);
      const { returnable } = await returnableAtomic(before, reserveFor);
      if (returnable <= 0n) break;
      const signed = await sign(returnable);
      if (!("signedTransaction" in signed))
        throw new Error("pocket-return returned no transaction");
      const hash = await client.sendRawTransaction({
        serializedTransaction: signed.signedTransaction,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");
      returned += returnable;
      expect(await usdcOf(RETURN_VAULT)).toBe(returned);
      expect(await usdcOf(t.pocket)).toBeLessThanOrEqual(before - returnable);
    }
    const remainder = await usdcOf(t.pocket);
    expect((await returnableAtomic(remainder, reserveFor)).returnable).toBeLessThanOrEqual(0n);
    expect(remainder + returned).toBeLessThanOrEqual(balance);
    await expect(sign(1n)).rejects.toMatchObject({ rule: "pocket-empty" });
  }, 120_000);
});

const POCKET_STATE_REGISTERED = 1n;
const POCKET_STATE_FUNDED = 2;
const ENVELOPE_STATE_CLOSED = 2n;

type ManualReturn = {
  readonly returnedAmount: bigint;
  readonly returnTx: Hex;
  readonly withdrawTx: Hex;
  readonly returnTimestamp: number;
};

type AuthorizationRow = { index: number; used: boolean; settled: boolean };

async function expectDenied(promise: Promise<unknown>, rule: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "Denied", rule } satisfies Partial<Denied>);
}

function x402PaymentRef(
  run: Run2,
  reservationId: bigint,
  index: number,
  validBefore: bigint,
): PaymentRef {
  return {
    schemaVersion: "1.0",
    rail: "x402-exact",
    network: `eip155:${run.node.chain.id}`,
    asset: USDC,
    payer: run.vault,
    payTo: PAYEE,
    amount: UNIT_AMOUNT.toString(),
    nonce: derivedNonce(run.vault, reservationId, index),
    validBefore: Number(validBefore),
  };
}

function receiptFor(paymentRef: PaymentRef): SlReceipt {
  const at = BigInt(Math.floor(Date.now() / 1000));
  return {
    paymentRefHash: paymentRefHash(paymentRef),
    requestCommit: keccak256(toBytes("run2-request")),
    responseCommit: keccak256(toBytes("run2-response")),
    statusCode: 200,
    originAsserted: "http://127.0.0.1:4029",
    requirementsHashSeen: keccak256(toBytes("run2-requirements")),
    tRequest: at,
    tPaymentSigned: at,
    tComplete: at,
    outcome: 1,
    localChecksCommit: keccak256(toBytes("run2-checks")),
    disclosure: 0,
    createdAt: at,
  };
}

function signReceipt(run: Run2, paymentRef: PaymentRef, receipt = receiptFor(paymentRef)) {
  return run.sign("cz-15", {
    keyId: "K3",
    kind: "sl-receipt",
    payload: {
      vault: run.vault,
      paymentRef,
      receipt: Object.fromEntries(
        Object.entries(receipt).map(([key, value]) => [
          key,
          typeof value === "string" ? value : String(value),
        ]),
      ),
    },
  });
}

/** The vault's ERC-1271 check accepts the wrapped receipt signature for the SL `Receipt` digest. */
async function expectReceiptSigned(run: Run2, paymentRef: PaymentRef): Promise<void> {
  const receipt = receiptFor(paymentRef);
  const signed = await signReceipt(run, paymentRef, receipt);
  if (!("signature" in signed)) throw new Error("sl-receipt returned no signature");
  const result = await run.node.publicClient.readContract({
    address: run.vault,
    abi: czarVaultAbi,
    functionName: "isValidSignature",
    args: [slReceiptDigest(run.node.chain.id, receipt), signed.signature],
  });
  expect(result).toBe(ERC1271_MAGIC);
}

/** K3 signs the EIP-3009 authorization; a relayer submits it to USDC (AuthorizationUsed on chain). */
async function payAuthorization(
  run: Run2,
  reservationId: bigint,
  index: number,
  validBefore: bigint,
): Promise<void> {
  const signed = await run.sign("cz-15", {
    keyId: "K3",
    kind: "usdc-3009",
    payload: {
      vault: run.vault,
      reservationId: reservationId.toString(),
      index: String(index),
      to: PAYEE,
      value: UNIT_AMOUNT.toString(),
      validBefore: validBefore.toString(),
    },
  });
  if (!("signature" in signed)) throw new Error("usdc-3009 returned no signature");
  await sendAsController(run, USDC, USDC_ABI, "transferWithAuthorization", [
    run.vault,
    PAYEE,
    UNIT_AMOUNT,
    0n,
    validBefore,
    derivedNonce(run.vault, reservationId, index),
    signed.signature,
  ]);
}

async function relayerSettle(run: Run2, reservationId: bigint, indices: number[]): Promise<void> {
  const signed = await run.sign("relayer", {
    keyId: "relayer",
    kind: "relayer-tx",
    payload: {
      to: run.vault,
      selector: "settle",
      args: { reservationId: reservationId.toString(), indices: indices.map(String) },
    },
  });
  if (!("signedTransaction" in signed)) throw new Error("relayer-tx returned no transaction");
  await submitSigned(run.node, signed.signedTransaction);
}

async function waitForAuthorizations(
  run: Run2,
  reservationId: bigint,
  check: (rows: AuthorizationRow[]) => boolean,
): Promise<void> {
  await waitForDb<AuthorizationRow>(
    run,
    "the indexed authorizations",
    {
      text: `SELECT index, used, settled FROM authorizations
             WHERE lower(vault)=lower($1) AND reservation_id=$2`,
      values: [run.vault, reservationId.toString()],
    },
    check,
  );
}

/**
 * The CZ-15 slow route under a down Gateway API, signed by the real signer and mined on chain: register, delegate
 * and fund the pocket; a fresh figure, then the API fails for longer than `payer.pullbackApiDownHours`; K4 initiates
 * and completes the slow withdrawal and returns the USDC to the vault; CZ-15 records `manual-return-required`; the
 * chain then moves past `payer.manualReturnHoldHours`.
 */
async function runSlowRouteToOverdueReturn(run: Run2): Promise<ManualReturn> {
  await k3VaultCall(run, "registerPocket", {
    envelopeId: ENVELOPE_ID.toString(),
    pocket: run.pocket,
    proof: run.proofs.pocket,
  });
  await waitForDb(
    run,
    "the indexed pocket",
    {
      text: "SELECT 1 FROM pockets WHERE lower(pocket)=lower($1)",
      values: [run.pocket],
    },
    (rows) => rows.length === 1,
  );
  await k4Transaction(run, "pocket-delegate", { pocket: run.pocket, vault: run.vault });
  await k3VaultCall(run, "fundPocket", { pocket: run.pocket, amount: POCKET_FUNDING.toString() });
  run.gatewayApi.setUp(true);
  await waitForFigure(
    run,
    (row) => row.failures === 0 && row.available === POCKET_FUNDING.toString(),
  );
  await insertFailureRow(run);
  run.gatewayApi.setUp(false);
  await expectStaleFigure(run);

  await k4Transaction(run, "pocket-slow-withdraw", {
    pocket: run.pocket,
    step: "initiate",
    value: POCKET_FUNDING.toString(),
  });
  const ready = await run.node.publicClient.readContract({
    address: GATEWAY_WALLET,
    abi: GATEWAY_ABI,
    functionName: "withdrawalBlock",
    args: [USDC, run.pocket],
  });
  const head = await run.node.publicClient.getBlockNumber({ cacheTime: 0 });
  if (ready > head) await run.node.testClient.mine({ blocks: Number(ready - head) });
  await nextBlockVisible(run);
  const withdrawn = await k4Transaction(run, "pocket-slow-withdraw", {
    pocket: run.pocket,
    step: "withdraw",
  });
  const { receipt: returned, amount: returnedAmount } = await returnUntilEmpty(run);
  const transfer = vaultTransferLog(run, returned, returnedAmount);
  await run.db.pool.query(
    `UPDATE payer_pullback_gateway_failures
     SET state='manual-return-required', initiate_tx=NULL, withdraw_tx=$2, return_tx=$3,
         return_block=$4, return_log_index=$5, returned_amount=$6, manual_return_required_at=now()
     WHERE plan_id=$1`,
    [
      PLAN_ID,
      withdrawn.transactionHash,
      returned.transactionHash,
      returned.blockNumber.toString(),
      transfer.logIndex,
      returnedAmount.toString(),
    ],
  );
  const block = await run.node.publicClient.getBlock({ blockNumber: returned.blockNumber });
  await run.node.testClient.increaseTime({ seconds: HOLD_SEC + SECONDS_PER_HOUR });
  await run.node.testClient.mine({ blocks: 1 });
  return {
    returnTx: returned.transactionHash,
    withdrawTx: withdrawn.transactionHash,
    returnTimestamp: Number(block.timestamp),
    returnedAmount,
  };
}

/**
 * CZ-15's SCR-152 return: K4 returns `balance − gasReserve` until the EOA is empty. The fee can fall after a block,
 * which makes part of the remaining gas reserve returnable again, so more than one return can be needed. The CZ-15
 * row records the last one.
 */
async function returnUntilEmpty(
  run: Run2,
): Promise<{ receipt: TransactionReceipt; amount: bigint }> {
  let last: { receipt: TransactionReceipt; amount: bigint } | undefined;
  for (let round = 0; round < MAX_RETURN_ROUNDS; round += 1) {
    await nextBlockVisible(run);
    const amount = await run.pocketReturnable();
    if (amount <= 0n) break;
    const receipt = await k4Transaction(run, "pocket-return", {
      pocket: run.pocket,
      kind: "usdc",
      amount: amount.toString(),
    });
    last = { receipt, amount };
  }
  if (last === undefined) throw new Error("the pocket had nothing returnable after the withdrawal");
  expect(await run.pocketReturnable()).toBeLessThanOrEqual(0n);
  return last;
}

function vaultTransferLog(run: Run2, receipt: TransactionReceipt, amount: bigint) {
  const transfer = parseEventLogs({
    abi: USDC_ABI,
    eventName: "Transfer",
    logs: receipt.logs,
  }).find(
    (log) =>
      log.address.toLowerCase() === USDC.toLowerCase() &&
      log.args.from.toLowerCase() === run.pocket.toLowerCase() &&
      log.args.to.toLowerCase() === run.vault.toLowerCase(),
  );
  if (transfer === undefined) throw new Error("pocket return has no pocket-to-vault Transfer");
  expect(transfer.args.value).toBe(amount);
  return transfer;
}

/** The CZ-15 Gateway-failure row for the pocket, unavailable for longer than `payer.pullbackApiDownHours`. */
async function insertFailureRow(run: Run2): Promise<void> {
  await run.db.pool.query(
    `INSERT INTO payer_pullback_gateway_failures
       (plan_id, step_index, envelope_ref, pocket, value, unavailable_since, state, attempt,
        closed_pocket, vault_address)
     VALUES ($1, 1, $2, $3, $4, now() - ($5 * interval '1 hour'), 'pending', 0, false, $6)`,
    [
      PLAN_ID,
      `eip155:${run.node.chain.id}:${run.vault.toLowerCase()}:${ENVELOPE_ID}`,
      run.pocket.toLowerCase(),
      POCKET_FUNDING.toString(),
      API_DOWN_HOURS + 1,
      run.vault.toLowerCase(),
    ],
  );
}

async function setFailureRow(
  run: Run2,
  column: "state" | "closed_pocket" | "return_tx" | "returned_amount",
  value: unknown,
): Promise<() => Promise<void>> {
  const before = await run.db.pool.query<Record<string, unknown>>(
    `SELECT ${column}::text AS value FROM payer_pullback_gateway_failures WHERE plan_id=$1`,
    [PLAN_ID],
  );
  const original = before.rows[0]?.["value"];
  await run.db.pool.query(
    `UPDATE payer_pullback_gateway_failures SET ${column}=$2 WHERE plan_id=$1`,
    [PLAN_ID, value],
  );
  return async () => {
    await run.db.pool.query(
      `UPDATE payer_pullback_gateway_failures SET ${column}=$2 WHERE plan_id=$1`,
      [PLAN_ID, original],
    );
  };
}

/** Takes this pocket's signed rows of one action out of the predicate's view, then puts them back. */
async function hideAudit(run: Run2, action: string): Promise<() => Promise<void>> {
  const hidden = await run.db.pool.query<{ audit_id: string }>(
    `UPDATE audit SET action=action || ':hidden'
     WHERE action=$1 AND outcome='signed' AND lower(object_ids->0->>'keyRef')=lower($2)
     RETURNING audit_id::text`,
    [action, `K4:${run.pocket}`],
  );
  expect(hidden.rows.length).toBeGreaterThan(0);
  return async () => {
    await run.db.pool.query("UPDATE audit SET action=$1 WHERE audit_id = ANY($2::bigint[])", [
      action,
      hidden.rows.map((row) => row.audit_id),
    ]);
  };
}

function setPocketField(
  run: Run2,
  field: "state" | "pendingPullback",
  value: bigint,
): Promise<() => Promise<void>> {
  return setField(
    run.node,
    {
      address: run.vault,
      contract: "CzarVault",
      path: ["_s", "pockets", { key: run.pocket, type: "address" }, field],
    },
    value,
  );
}

type Figure = { failures: number; available: string | null; observedAt: string | null };

async function pocketFigure(run: Run2): Promise<Figure> {
  const result = await run.db.pool.query<Figure>(
    `SELECT api_consecutive_failures AS failures, gateway_available_atomic AS available,
            api_observed_at AS "observedAt"
     FROM pocket_balances WHERE lower(pocket)=lower($1)`,
    [run.pocket],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("no indexed pocket balance");
  return row;
}

async function waitForFigure(run: Run2, check: (row: Figure) => boolean): Promise<void> {
  await waitForDb<Figure>(
    run,
    "the indexed Gateway figure",
    {
      text: `SELECT api_consecutive_failures AS failures, gateway_available_atomic AS available,
                    api_observed_at AS "observedAt"
             FROM pocket_balances WHERE lower(pocket)=lower($1)`,
      values: [run.pocket],
    },
    (rows) => rows[0] !== undefined && check(rows[0]),
  );
}

/** Predicate 1 holds: the indexer's last Gateway API poll for the pocket failed. */
async function expectStaleFigure(run: Run2): Promise<void> {
  await waitForFigure(run, (row) => row.failures > 0 && row.observedAt !== null);
}

/**
 * Mines a block so a state edit is part of a mined block, then waits out the projection client's eth_blockNumber
 * cache (one viem polling interval, as in production): the Gateway and USDC reads are pinned to that block number.
 */
async function nextBlockVisible(run: Run2): Promise<void> {
  await run.node.testClient.mine({ blocks: 1 });
  await new Promise((resolve) => setTimeout(resolve, run.node.publicClient.pollingInterval));
}

async function writeOff(run: Run2): Promise<Hex> {
  const signed = await run.sign("cz-15", {
    keyId: "K3",
    kind: "vault-call",
    payload: { vault: run.vault, selector: "writeOffPocket", args: { pocket: run.pocket } },
  });
  if (!("signedTransaction" in signed)) throw new Error("writeOffPocket returned no transaction");
  return signed.signedTransaction;
}

async function expectExceptionSigns(run: Run2): Promise<void> {
  await writeOff(run);
  expect(await lastAudit(run, "signer:vault-call")).toMatchObject({
    outcome: "signed",
    rule: RULE,
  });
}

async function lastAudit(
  run: Run2,
  action: string,
): Promise<{ outcome: string; rule?: string; digest?: string; keyRef?: string }> {
  const result = await run.db.pool.query<{ outcome: string; ids: Record<string, string> }>(
    `SELECT outcome, object_ids->0 AS ids FROM audit WHERE action=$1
     ORDER BY audit_id DESC LIMIT 1`,
    [action],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no ${action} audit row`);
  return {
    outcome: row.outcome,
    ...(row.ids["rule"] === undefined ? {} : { rule: row.ids["rule"] }),
    ...(row.ids["digest"] === undefined ? {} : { digest: row.ids["digest"] }),
    ...(row.ids["keyRef"] === undefined ? {} : { keyRef: row.ids["keyRef"] }),
  };
}

async function gatewayDeposit(run: Run2, value: bigint): Promise<void> {
  await sendAsController(run, USDC, USDC_ABI, "approve", [GATEWAY_WALLET, value]);
  await sendAsController(run, GATEWAY_WALLET, GATEWAY_ABI, "depositFor", [USDC, run.pocket, value]);
}

/** Sends from the node's first unlocked account (the Gateway doubles' controller). */
async function sendAsController(
  run: Run2,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<void> {
  const wallet = createWalletClient({
    chain: run.node.chain,
    transport: http(run.node.rpcUrl),
    account: run.node.sender,
  });
  const hash = await wallet.writeContract({
    address,
    abi,
    functionName,
    args,
    ...withFeeFloor({ maxFeePerGas: await run.node.publicClient.getGasPrice() }),
  } as never);
  const receipt = await run.node.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
}

async function sendAsOwner(run: Run2, functionName: string, args: readonly unknown[]) {
  const wallet = createWalletClient({
    chain: run.node.chain,
    transport: http(run.node.rpcUrl),
    account: run.owner,
  });
  const hash = await wallet.writeContract({
    address: run.vault,
    abi: czarVaultAbi,
    functionName,
    args,
    ...withFeeFloor({ maxFeePerGas: await run.node.publicClient.getGasPrice() }),
  } as never);
  const receipt = await run.node.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
}

// ───────────── K8 (T-105 local mode) ─────────────

type K8Signer = Awaited<ReturnType<typeof harness>> & { network: { openEvidenceLog: Address } };

async function createK8Signer(node: ArcNode): Promise<K8Signer> {
  const network = {
    ...NETWORK,
    chainId: node.chain.id,
    openEvidenceLog: "0x0000000000000000000000000000000000000001" as Address,
    nanoDomain: { ...NETWORK.nanoDomain, chainId: node.chain.id },
  };
  const signer = await harness({
    network,
    prepareTransaction: async (from, call) => ({
      type: "eip1559",
      chainId: node.chain.id,
      nonce: await node.publicClient.getTransactionCount({ address: from }),
      gas: await node.publicClient.estimateGas({
        account: from,
        to: call.to,
        data: call.data,
        value: call.value,
      }),
      maxFeePerGas: (await node.publicClient.getGasPrice()) * 2n,
      maxPriorityFeePerGas: 1_000_000_000n,
      to: call.to,
      data: call.data,
      value: call.value,
    }),
    projection: {
      latestEvidenceRoot: async () => `0x${"0".repeat(64)}`,
      evidenceBatchExists: async (root) => root === `0x${"0".repeat(64)}`,
      nativeBalance: (address) => node.publicClient.getBalance({ address }),
    },
  });
  return Object.assign(signer, { network });
}

async function assertK8Commit(
  signer: K8Signer,
  node: ArcNode,
  openEvidenceLog: Address,
): Promise<void> {
  const address = signer.address("K8");
  await node.testClient.setBalance({ address, value: 1_000_000_000_000_000_000n });
  const before = await node.publicClient.getBalance({ address });
  const uri = `czar-archive:0x${"0".repeat(64)}`;
  const signed = await signer.signer.sign("cz-17", {
    keyId: "K8",
    kind: "oel-commit",
    payload: {
      kind: "1",
      root: `0x${"0".repeat(64)}`,
      prev: `0x${"0".repeat(64)}`,
      uriHash: keccak256(toBytes(uri)),
      uri,
    },
  });
  if (!("signedTransaction" in signed)) throw new Error("K8 did not produce a transaction");
  const receipt = await submitSigned(node, signed.signedTransaction);
  const after = await node.publicClient.getBalance({ address });
  const artifact = JSON.parse(
    await readFile(`${REPO_ROOT}contracts/out/OpenEvidenceLog.sol/OpenEvidenceLog.json`, "utf8"),
  ) as { abi: Abi };
  const count = await node.publicClient.readContract({
    address: openEvidenceLog,
    abi: artifact.abi,
    functionName: "count",
    args: [address, 1],
  });
  expect(receipt.status).toBe("success");
  expect(receipt.from.toLowerCase()).toBe(address.toLowerCase());
  expect(after).toBeLessThan(before);
  expect(count).toBe(1n);
}

/** Arc native balances are 18-decimal wei; `signer.gas.*` targets are USDC 6-decimal atomic. */
const WEI_PER_ATOMIC = 10n ** 12n;
/** One USDC of native gas for the relayer's three refill transactions on arc-anvil. */
const RELAYER_GAS_HEADROOM_WEI = 1_000_000n * WEI_PER_ATOMIC;

async function assertGasRefill(signer: K8Signer, node: ArcNode): Promise<void> {
  const keys = ["K3", "K7", "K8"] as const;
  for (const key of keys)
    await node.testClient.setBalance({ address: signer.address(key), value: 0n });
  const relayer = signer.address("relayer");
  const targetWei = (key: (typeof keys)[number]) =>
    BigInt(config.get(`signer.gas.${key}.targetAtomic` as never) as number) * WEI_PER_ATOMIC;
  const relayerFundingWei =
    keys.reduce((sum, key) => sum + targetWei(key), 0n) + RELAYER_GAS_HEADROOM_WEI;
  await node.testClient.setBalance({ address: relayer, value: relayerFundingWei });
  const alerts: string[] = [];
  const results = await runGasRefill(localGasRefillOptions(signer, node, alerts));
  expect(results.map(({ key, status }) => [key, status])).toEqual(
    keys.map((key) => [key, "refilled"]),
  );
  for (const key of keys) {
    expect(await node.publicClient.getBalance({ address: signer.address(key) })).toBe(
      targetWei(key),
    );
  }
  expect(alerts).toEqual([]);

  await node.testClient.setBalance({ address: signer.address("K3"), value: 0n });
  await node.testClient.setBalance({ address: relayer, value: 0n });
  const failed = await runGasRefill(localGasRefillOptions(signer, node, alerts));
  expect(failed[0]).toMatchObject({ key: "K3", status: "failed" });
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("relayer");
}

/** Well under the five-minute refill interval: the first pass must not wait for it (SCR-155 §3). */
const FIRST_PASS_WAIT_MS = 30_000;

async function assertGasRefillAtStart(signer: K8Signer, node: ArcNode): Promise<void> {
  const k3 = signer.address("K3");
  const targetWei =
    BigInt(config.get("signer.gas.K3.targetAtomic" as never) as number) * WEI_PER_ATOMIC;
  await node.testClient.setBalance({ address: k3, value: 0n });
  await node.testClient.setBalance({
    address: signer.address("relayer"),
    value: targetWei + RELAYER_GAS_HEADROOM_WEI,
  });
  const alerts: string[] = [];
  const jobErrors: unknown[] = [];
  const stop = startGasRefillJob(
    {
      ...localGasRefillOptions(signer, node, alerts),
      ...createRpcGasRefillAdapters({ client: node.publicClient }),
    },
    (error) => jobErrors.push(error),
  );
  try {
    await vi.waitFor(
      async () => expect(await node.publicClient.getBalance({ address: k3 })).toBe(targetWei),
      { timeout: FIRST_PASS_WAIT_MS, interval: 250 },
    );
  } finally {
    stop();
  }
  expect(alerts).toEqual([]);
  expect(jobErrors).toEqual([]);
}

function localGasRefillOptions(signer: K8Signer, node: ArcNode, alerts: string[]) {
  return {
    config: loadConfig(),
    signer: signer.signer,
    keyAddress: (key: "K3" | "K7" | "K8") => signer.address(key),
    getNativeBalance: (address: Address) => node.publicClient.getBalance({ address }),
    submitTransaction: async (transaction: `0x${string}`) => {
      const hash = await node.publicClient.sendRawTransaction({
        serializedTransaction: transaction,
      });
      const receipt = await node.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("gas refill reverted on arc-anvil");
    },
    alert: async (message: string) => {
      alerts.push(message);
    },
  };
}
