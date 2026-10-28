// SCR-146 §3.3 run 2 scenario: one CLEAN pinned arc-anvil chain with the deployed Czar contracts and the SCR-150
// Gateway doubles, the real indexer and server tables in Postgres, and the CZ-27 signer wired to the production
// Postgres projection and audit. The vault, envelope and plan are created the way CZ-13/CZ-15 create them.
import { randomBytes } from "node:crypto";
import {
  createWalletClient,
  http,
  keccak256,
  parseEventLogs,
  toBytes,
  type Address,
  type TransactionReceipt,
  type TransactionSerializableEIP1559,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "@czar/config";
import { buildTree, PAYEE_KIND, payeeLeaf, POCKET_STEP_INDEX, type Hash32 } from "@czar/hashing";
import { czarVaultAbi, czarVaultFactoryAbi, withFeeFloor } from "@czar/vault-client";
import { placeGatewayDoubles } from "../../../../ops/local/gateway-doubles.ts";
import { createPostgresProjection } from "#src/postgres-projection";
import { postgresAudit } from "#src/postgres-audit";
import type { SignRequest, SignResult } from "#src/service";
import { harness, NETWORK } from "#test/helpers";
import {
  chainNow,
  deployCzar,
  startArcNode,
  submitSigned,
  type ArcNode,
  type CzarDeployment,
} from "#test/local-chain/arc-node";
import {
  createTestDatabase,
  startGatewayApi,
  startIndexer,
  type GatewayApi,
  type Indexer,
  type TestDatabase,
} from "#test/local-chain/stack";

/** Ports reserved for this suite (18610-18619); other local suites use 8545-8549 and 18546-18559. */
export const PORTS = { chain: 18610, indexer: 18611, gatewayApi: 18612, k8Chain: 18613 } as const;
export const CHAIN_ID = 5_042_002;
export const PAYEE: Address = "0x000000000000000000000000000000000000bEEF";
export const UNIT_AMOUNT = 100_000n;
export const CALL_COUNT = 3;
export const STEP_CAP = UNIT_AMOUNT * BigInt(CALL_COUNT);
export const ENVELOPE_CAP = 2_000_000n;
export const POCKET_CAP_BPS = 2_500;
export const POCKET_FUNDING = 400_000n;
export const ENVELOPE_ID = 1n;
const ENVELOPE_LIFETIME_SEC = 7n * 86_400n;
/** Native balances for gas: 10 USDC in Arc's 18-decimal native unit. */
const GAS_FUNDING = 10n * 10n ** 18n;
/** Vault USDC: 5 USDC in native units (the ERC-20 at 0x3600… reads native / 1e12). */
const VAULT_FUNDING = 5n * 10n ** 18n;
const USER_ID = "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const DEVICE_ID = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const OBJECTIVE_ID = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
export const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";

export type Run2 = {
  readonly node: ArcNode;
  readonly db: TestDatabase;
  readonly gatewayApi: GatewayApi;
  readonly indexer: Indexer;
  readonly deployment: CzarDeployment;
  readonly t: Awaited<ReturnType<typeof harness>>;
  readonly owner: ReturnType<typeof privateKeyToAccount>;
  readonly vault: Address;
  readonly pocket: Address;
  readonly planHash: Hash32;
  readonly proofs: { readonly payee: Hash32[]; readonly pocket: Hash32[] };
  /** Every transaction the signer was handed to sign, in order (the SCR-146 §1 digest preimages). */
  readonly prepared: TransactionSerializableEIP1559[];
  /** Signs with the signer clock set to the latest block's time. */
  sign(caller: string, request: SignRequest): Promise<SignResult>;
  /** Overrides the signer clock (Unix seconds); `undefined` follows the chain again. */
  pinClock(seconds: number | undefined): void;
  stop(): Promise<void>;
};

export async function startRun2(): Promise<Run2> {
  const stops: (() => Promise<void> | void)[] = [];
  const stop = async () => {
    for (const step of stops.toReversed()) await step();
  };
  try {
    const node = await startArcNode({ port: PORTS.chain, chainId: CHAIN_ID });
    stops.push(() => node.stop());
    const db = await createTestDatabase();
    stops.push(() => db.drop());
    const gatewayApi = await startGatewayApi({ port: PORTS.gatewayApi, rpcUrl: node.rpcUrl });
    stops.push(() => gatewayApi.stop());
    const wired = await wireSigner(node, db);
    const deployment = await deployCzar(node, `signer-run2-${randomBytes(4).toString("hex")}`, {
      K3: wired.t.address("K3"),
      K5: wired.t.address("K5"),
      K6: wired.t.address("K6"),
      K7: wired.t.address("K7"),
      K20: wired.t.address("K20"),
    });
    stops.push(() => deployment.remove());
    wired.setFactory(deployment.CzarVaultFactory);
    await placeGatewayDoubles({ rpcUrl: node.rpcUrl });
    const indexer = await startIndexer({
      database: db,
      rpcUrl: node.rpcUrl,
      manifestPath: deployment.manifestPath,
      gatewayApiBaseUrl: gatewayApi.baseUrl,
      port: PORTS.indexer,
    });
    stops.push(() => indexer.stop());
    const vaultSetup = await openVaultEnvelope(node, deployment, wired.t);
    await seedServerRows(db, vaultSetup);
    return { node, db, gatewayApi, indexer, deployment, ...wired, ...vaultSetup, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function wireSigner(node: ArcNode, db: TestDatabase) {
  let factory: Address | undefined;
  let clockSec: number | undefined;
  let chainSec = 0;
  const prepared: TransactionSerializableEIP1559[] = [];
  const projection = createPostgresProjection({
    config: loadConfig(),
    database: db.pool,
    chain: node.publicClient,
    get factory(): Address {
      if (factory === undefined) throw new Error("factory read before deployment");
      return factory;
    },
  });
  const t = await harness({
    network: NETWORK,
    projection,
    auditSink: postgresAudit(db.pool),
    nowMs: () => (clockSec ?? chainSec) * 1000,
    prepareTransaction: async (from, call) => {
      const tx: TransactionSerializableEIP1559 = {
        type: "eip1559",
        chainId: CHAIN_ID,
        nonce: await node.publicClient.getTransactionCount({ address: from, blockTag: "pending" }),
        gas: await node.publicClient.estimateGas({ account: from, ...call }),
        ...withFeeFloor({ maxFeePerGas: await node.publicClient.getGasPrice() }),
        to: call.to,
        data: call.data,
        value: call.value,
      };
      prepared.push(tx);
      return tx;
    },
  });
  for (const address of [t.address("K3"), t.address("relayer"), t.pocket])
    await node.testClient.setBalance({ address, value: GAS_FUNDING });
  return {
    t,
    prepared,
    setFactory: (address: Address) => {
      factory = address;
    },
    pinClock: (seconds: number | undefined) => {
      clockSec = seconds;
    },
    sign: async (caller: string, request: SignRequest) => {
      chainSec = await chainNow(node);
      return t.signer.sign(caller, request);
    },
  };
}

async function openVaultEnvelope(
  node: ArcNode,
  deployment: CzarDeployment,
  t: Awaited<ReturnType<typeof harness>>,
) {
  const owner = privateKeyToAccount(generatePrivateKey());
  await node.testClient.setBalance({ address: owner.address, value: GAS_FUNDING });
  const wallet = createWalletClient({
    chain: node.chain,
    transport: http(node.rpcUrl),
    account: owner,
  });
  const send = async (
    address: Address,
    abi: typeof czarVaultAbi | typeof czarVaultFactoryAbi,
    functionName: string,
    args: readonly unknown[],
  ) => {
    const hash = await wallet.writeContract({
      address,
      abi,
      functionName,
      args,
      ...withFeeFloor({ maxFeePerGas: await node.publicClient.getGasPrice() }),
    } as never);
    const receipt = await node.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
    return receipt;
  };
  await send(deployment.CzarVaultFactory, czarVaultFactoryAbi, "createVault", [owner.address]);
  const vault = await node.publicClient.readContract({
    address: deployment.CzarVaultFactory,
    abi: czarVaultFactoryAbi,
    functionName: "vaultOf",
    args: [owner.address],
  });
  await node.testClient.setBalance({ address: vault, value: VAULT_FUNDING });
  const pocket = t.pocket;
  const payee = payeeLeaf(PAYEE, PAYEE_KIND.X402_PAY_TO, 0, STEP_CAP);
  const pocketLeaf = payeeLeaf(pocket, PAYEE_KIND.POCKET, POCKET_STEP_INDEX, 0n);
  const tree = buildTree([payee, pocketLeaf]);
  const planHash = keccak256(toBytes(`run2-plan-${vault}`));
  await send(vault, czarVaultAbi, "openEnvelope", [
    {
      cap: ENVELOPE_CAP,
      maxStepAmount: STEP_CAP,
      pocketCapBps: POCKET_CAP_BPS,
      expiresAt: BigInt(await chainNow(node)) + ENVELOPE_LIFETIME_SEC,
      categoryId: keccak256(toBytes("research")),
      objectiveHash: keccak256(toBytes(`run2-objective-${vault}`)),
      planHash,
      payeeRoot: tree.root,
    },
  ]);
  return {
    owner,
    vault,
    pocket,
    planHash,
    payeeRoot: tree.root,
    proofs: { payee: tree.proof(payee), pocket: tree.proof(pocketLeaf) },
  };
}

/** The CZ-12/CZ-13 rows a plan with an x402 step and a pocket leaf has once its envelope is open. */
async function seedServerRows(
  db: TestDatabase,
  setup: { vault: Address; pocket: Address; planHash: Hash32; payeeRoot: Hash32 },
): Promise<void> {
  const plan = {
    planHash: setup.planHash,
    payeeRoot: setup.payeeRoot,
    steps: [{ stepIndex: 0, kind: "x402-exact", expectedCalls: CALL_COUNT }],
    payeeLeaves: [
      { payee: PAYEE, kind: PAYEE_KIND.X402_PAY_TO, stepIndex: 0, stepCap: STEP_CAP.toString() },
      { payee: setup.pocket, kind: PAYEE_KIND.POCKET, stepIndex: POCKET_STEP_INDEX, stepCap: "0" },
    ],
  };
  await db.pool.query("INSERT INTO users (user_id, vault) VALUES ($1, $2)", [
    USER_ID,
    setup.vault.toLowerCase(),
  ]);
  await db.pool.query(
    `INSERT INTO devices (device_id, user_id, device_name, platform, token_hash)
     VALUES ($1, $2, 'run2', 'macos', $3)`,
    [DEVICE_ID, USER_ID, randomBytes(32)],
  );
  await db.pool.query(
    `INSERT INTO objectives (objective_id, user_id, device_id, submission, objective_hash, state)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, 'executing')`,
    [OBJECTIVE_ID, USER_ID, DEVICE_ID, keccak256(toBytes(`run2-objective-${setup.vault}`))],
  );
  await db.pool.query(
    `INSERT INTO plans (plan_id, objective_id, plan, plan_hash, payee_root, state)
     VALUES ($1, $2, $3::jsonb, $4, $5, 'approved')`,
    [PLAN_ID, OBJECTIVE_ID, JSON.stringify(plan), setup.planHash, setup.payeeRoot],
  );
}

/** Asks K3 for a `vault-call`, broadcasts the signed transaction and returns its receipt. */
export async function k3VaultCall(
  run: Run2,
  selector: string,
  args: Readonly<Record<string, unknown>>,
) {
  const signed = await run.sign("cz-15", {
    keyId: "K3",
    kind: "vault-call",
    payload: { vault: run.vault, selector, args },
  });
  if (!("signedTransaction" in signed))
    throw new Error("K3 vault-call did not return a transaction");
  return submitSigned(run.node, signed.signedTransaction);
}

/** Asks K4 (the pocket key) for a transaction kind and broadcasts it. */
export async function k4Transaction(run: Run2, kind: string, payload: Record<string, unknown>) {
  const signed = await run.sign("cz-15", { keyId: "K4", kind, payload });
  if (!("signedTransaction" in signed)) throw new Error(`K4 ${kind} did not return a transaction`);
  return submitSigned(run.node, signed.signedTransaction);
}

/** The reservation id from a `reserve` receipt. */
export function reservationIdOf(receipt: TransactionReceipt): bigint {
  const [event] = parseEventLogs({ abi: czarVaultAbi, eventName: "Reserved", logs: receipt.logs });
  if (event === undefined) throw new Error("reserve receipt has no Reserved event");
  return event.args.reservationId;
}

/** Polls an indexer/server query until `check` passes, mining one block per attempt so block handlers run. */
export async function waitForDb<T extends Record<string, unknown>>(
  run: Run2,
  label: string,
  query: { text: string; values: unknown[] },
  check: (rows: T[]) => boolean,
): Promise<T[]> {
  for (let attempt = 0; attempt < INDEXER_WAIT_ATTEMPTS; attempt += 1) {
    const result = await run.db.pool.query<T>(query.text, query.values).catch(() => undefined);
    if (result !== undefined && check(result.rows)) return result.rows;
    await run.node.testClient.mine({ blocks: 1 });
    await new Promise((resolve) => setTimeout(resolve, INDEXER_WAIT_MS));
  }
  throw new Error(`timed out waiting for ${label}\n${run.indexer.logs().slice(-4000)}`);
}

const INDEXER_WAIT_ATTEMPTS = 200;
const INDEXER_WAIT_MS = 300;
