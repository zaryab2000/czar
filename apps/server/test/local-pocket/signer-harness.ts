// The real CZ-27 signer (`createSigner`) over the real `local-keystore` backend, with its keystore held in
// memory (an in-memory `KeystoreFs`, a generated passphrase that never leaves the process, cheap scrypt
// parameters). Audit rows go to the server `audit` table through `postgresAudit`, as in production.
// The projection reads the local chain and the server tables directly; it mirrors
// `apps/signer/src/postgres-projection.ts`, whose indexer tables are not populated without Ponder.
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { decodeEventLog, parseAbi, type Address, type Hash, type PublicClient } from "viem";
import type { Config } from "@czar/config";
import type { Hash32 } from "@czar/hashing";
import {
  createRpcTransactionPreparer,
  createSigner,
  openLocalKeystore,
  postgresAudit,
  type KeystoreFs,
  type OverdueManualReturnFacts,
  type PlanLeaf,
  type PocketBalances,
  type Projection,
  type Signer,
  type SignerBackend,
} from "@czar/signer";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";
import type { Pool } from "pg";
import {
  ARC_CHAIN_ID,
  ARC_USDC,
  GATEWAY_DOMAIN,
  GATEWAY_MINTER,
  GATEWAY_WALLET,
} from "#test/local-pocket/arc-chain";
import type { IndexerStandin } from "#test/local-pocket/indexer-standin";

const KEYSTORE_PATH = "/czar-local-pocket-keystore";
const TEST_KDF = { N: 1024, r: 8, p: 1 } as const;
const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
/** A live chain mines continuously; an idle anvil does not, so the projection mines before a stale read. */
const IDLE_BLOCK_SECONDS = 5;
const gatewayAbi = parseAbi([
  "function withdrawingBalance(address token, address depositor) view returns (uint256)",
  "function withdrawalBlock(address token, address depositor) view returns (uint256)",
]);
const usdcAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export interface SignerHarness {
  readonly signer: Signer;
  readonly backend: SignerBackend;
  readonly k3: Address;
  readonly relayer: Address;
  /** Envelope leaves the projection serves, keyed `vault:envelopeId` (the planner's stored plan). */
  readonly leaves: Map<string, readonly PlanLeaf[]>;
}

/** The in-memory `local-keystore` with K3 and the relayer key; K4 keys are created per pocket. */
export async function createSignerKeys(): Promise<{
  readonly backend: SignerBackend;
  readonly k3: Address;
  readonly relayer: Address;
}> {
  const passphrase = randomBytes(32).toString("hex");
  const backend = await openLocalKeystore({
    path: KEYSTORE_PATH,
    passphrase: { kind: "prompt", read: async () => passphrase },
    fs: memoryKeystoreFs(),
    git: async () => undefined,
    kdf: TEST_KDF,
  });
  const k3 = (await backend.createKey("K3")).address;
  const relayer = (await backend.createKey("relayer")).address;
  return { backend, k3, relayer };
}

export function createSignerHarness(input: {
  readonly keys: Awaited<ReturnType<typeof createSignerKeys>>;
  readonly pool: Pool;
  readonly config: Config;
  readonly reader: PublicClient;
  readonly factory: Address;
  readonly standin: IndexerStandin;
  readonly mine: () => Promise<void>;
  readonly nowMs: () => number;
}): SignerHarness {
  const leaves = new Map<string, readonly PlanLeaf[]>();
  const projection = chainProjection({ ...input, leaves });
  const signer = createSigner({
    backend: input.keys.backend,
    projection,
    network: {
      chainId: ARC_CHAIN_ID,
      usdc: ARC_USDC,
      gatewayWallet: GATEWAY_WALLET,
      gatewayMinter: GATEWAY_MINTER,
      gatewayDomain: GATEWAY_DOMAIN,
      jobEscrow: "0x0000000000000000000000000000000000000003",
      openEvidenceLog: "0x0000000000000000000000000000000000000004",
      nanoDomain: {
        name: "GatewayWalletBatched",
        version: "1",
        chainId: ARC_CHAIN_ID,
        verifyingContract: GATEWAY_WALLET,
      },
      merchantServices: [],
    },
    config: input.config,
    audit: postgresAudit(input.pool),
    callers: { "cz-15": ["K3", "K4", "relayer"] },
    // The preparer the signer process signs with; CZ-15 derives the SCR-152 returnable value with the same.
    prepareTransaction: createRpcTransactionPreparer({
      chainId: ARC_CHAIN_ID,
      client: input.reader,
    }),
    nowMs: input.nowMs,
    alert: async () => undefined,
  });
  return {
    signer,
    backend: input.keys.backend,
    k3: input.keys.k3,
    relayer: input.keys.relayer,
    leaves,
  };
}

function memoryKeystoreFs(): KeystoreFs {
  const files = new Map<string, { data: string; mode: number }>();
  const directories = new Set<string>();
  return {
    async stat(path) {
      if (directories.has(path)) return { mode: 0o700, isDirectory: true };
      const file = files.get(path);
      return file ? { mode: file.mode, isDirectory: false } : undefined;
    },
    async mkdir(path) {
      directories.add(path);
    },
    async list(path) {
      return [...files.keys()]
        .filter((name) => dirname(name) === path)
        .map((name) => name.slice(path.length + 1));
    },
    async read(path) {
      const file = files.get(path);
      if (!file) throw new Error("Keystore file is missing.");
      return file.data;
    },
    async create(path, data, mode) {
      if (files.has(path)) throw new Error("Keystore file already exists.");
      files.set(path, { data, mode });
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

interface ProjectionInput {
  readonly pool: Pool;
  readonly config: Config;
  readonly reader: PublicClient;
  readonly factory: Address;
  readonly standin: IndexerStandin;
  readonly mine: () => Promise<void>;
  readonly nowMs: () => number;
  readonly leaves: Map<string, readonly PlanLeaf[]>;
}

function chainProjection(input: ProjectionInput): Projection {
  const nowSeconds = () => Math.floor(input.nowMs() / MS_PER_SECOND);
  return {
    async freezeState(vault) {
      let block = await input.reader.getBlock();
      if (nowSeconds() - Number(block.timestamp) > IDLE_BLOCK_SECONDS) {
        await input.mine();
        block = await input.reader.getBlock();
      }
      const [frozen, guardianPaused] = await Promise.all([
        input.reader.readContract({ address: vault, abi: czarVaultAbi, functionName: "frozen" }),
        input.reader.readContract({
          address: input.factory,
          abi: czarVaultFactoryAbi,
          functionName: "guardianPaused",
        }),
      ]);
      return { frozen, guardianPaused, observedAt: Number(block.timestamp) };
    },
    isVault: (vault) =>
      input.reader.readContract({
        address: input.factory,
        abi: czarVaultFactoryAbi,
        functionName: "isVault",
        args: [vault],
      }),
    reservation: async (vault, reservationId) => {
      const row = await input.reader.readContract({
        address: vault,
        abi: czarVaultAbi,
        functionName: "getReservation",
        args: [reservationId],
      });
      if (row.state === 0) return undefined;
      return {
        envelopeId: row.envelopeId,
        stepIndex: row.stepIndex,
        payee: row.payee,
        unitAmount: row.unitAmount,
        count: row.count,
        validBefore: row.validBefore,
        state: row.state === 3 ? "Final" : row.state === 2 ? "Finalizing" : "Active",
      };
    },
    pullback: async (vault, pullbackId) => {
      const row = await input.reader.readContract({
        address: vault,
        abi: czarVaultAbi,
        functionName: "getPullback",
        args: [pullbackId],
      });
      if (row.state === 0) return undefined;
      return {
        pocket: row.pocket,
        value: row.value,
        maxFee: row.maxFee,
        maxBlockHeight: row.maxBlockHeight,
        salt: row.salt,
        state: row.state === 1 ? "Pending" : row.state === 2 ? "Confirmed" : "Cancelled",
      };
    },
    blockNumber: () => input.reader.getBlockNumber(),
    storedPlan: async () => undefined,
    envelope: async (vault, envelopeId) => {
      const envelope = await input.reader.readContract({
        address: vault,
        abi: czarVaultAbi,
        functionName: "getEnvelope",
        args: [envelopeId],
      });
      if (envelope.state === 0) return undefined;
      return {
        state: envelope.state === 1 ? "Open" : "Closed",
        leaves: input.leaves.get(`${vault.toLowerCase()}:${envelopeId}`) ?? [],
      };
    },
    async pocket(pocket) {
      const vault = input.standin.vaultOf(pocket);
      if (!vault) return undefined;
      const record = await input.standin.pocketState(pocket);
      if (record.state === "None") return undefined;
      return {
        vault,
        envelopeId: record.envelopeId,
        state: record.state,
        funded: record.funded,
        pendingPullback: record.pendingPullback,
        slowWithdrawalOpen: (await input.standin.withdrawing(pocket)) > 0n,
      };
    },
    pocketBalances: (pocket) => pocketBalances(input, pocket),
    nanoSpent: async () => ({ step: 0n, pocket: 0n }),
    settledPayment: async () => false,
    autonomy: async () => undefined,
    job: async () => undefined,
    reportExists: async () => false,
    checksCommitExists: async () => false,
    latestEvidenceRoot: async () => `0x${"00".repeat(32)}` as Hash32,
    evidenceBatchExists: async () => false,
    nativeBalance: (address) => input.reader.getBalance({ address }),
    slowWithdrawTrigger: (pocket) => slowWithdrawTrigger(input, pocket),
    pocketSpendAfterObservation: (pocket, observedAt) =>
      pocketSpendAfterObservation(input, pocket, observedAt),
    overdueManualReturnFacts: (pocket, vault, now) =>
      overdueManualReturnFacts(input, pocket, vault, now),
  };
}

async function pocketBalances(input: ProjectionInput, pocket: Address): Promise<PocketBalances> {
  const observation = await input.standin.observe(pocket);
  const block = await input.reader.getBlockNumber();
  const read = (functionName: "withdrawingBalance" | "withdrawalBlock") =>
    input.reader.readContract({
      address: GATEWAY_WALLET,
      abi: gatewayAbi,
      functionName,
      args: [ARC_USDC, pocket],
      blockNumber: block,
    });
  const [withdrawing, withdrawalBlock, usdc, native, pendingPullback] = await Promise.all([
    read("withdrawingBalance"),
    read("withdrawalBlock"),
    input.reader.readContract({
      address: ARC_USDC,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [pocket],
      blockNumber: block,
    }),
    input.reader.getBalance({ address: pocket }),
    hasPendingPullback(input, pocket),
  ]);
  const maxAgeMs = Number(input.config.get("indexer.gatewayBalanceMaxAgeSeconds")) * MS_PER_SECOND;
  const observedAt = observation.observedAt?.getTime() ?? null;
  const age = observedAt === null ? Number.POSITIVE_INFINITY : input.nowMs() - observedAt;
  return {
    gatewayApi: observation.available,
    gatewayAvailable: observation.available,
    gatewayApiObservedAt: observedAt,
    gatewayWithdrawing: withdrawing,
    withdrawalBlock,
    currentBlock: block,
    usdc,
    native,
    pendingPullback,
    gatewayApiFresh: age >= 0 && age <= maxAgeMs && observation.consecutiveFailures === 0,
  };
}

/** Production reads the indexer `pullbacks` table: any `Pending` pullback for the pocket, recovery included. */
async function hasPendingPullback(input: ProjectionInput, pocket: Address): Promise<boolean> {
  const vault = input.standin.vaultOf(pocket);
  if (!vault) return false;
  const requested = await input.reader.getContractEvents({
    address: vault,
    abi: czarVaultAbi,
    eventName: "PullbackRequested",
    args: { pocket },
    fromBlock: 0n,
  });
  for (const event of requested) {
    if (event.args.pullbackId === undefined) continue;
    const row = await input.reader.readContract({
      address: vault,
      abi: czarVaultAbi,
      functionName: "getPullback",
      args: [event.args.pullbackId],
    });
    if (row.state === 1) return true;
  }
  return false;
}

async function slowWithdrawTrigger(
  input: ProjectionInput,
  pocket: Address,
): Promise<"api-down" | "closed-dust" | null> {
  const downMs = Number(input.config.get("payer.pullbackApiDownHours")) * 3_600_000;
  const failures = await input.pool.query(
    `SELECT 1 FROM payer_pullback_gateway_failures
     WHERE lower(pocket)=lower($1) AND unavailable_since <= $2 LIMIT 1`,
    [pocket, new Date(input.nowMs() - downMs)],
  );
  if (failures.rows.length > 0) return "api-down";
  const balances = await pocketBalances(input, pocket);
  if (!balances.gatewayApiFresh) return null;
  const record = await input.standin.pocketState(pocket);
  const dust =
    BigInt(Number(input.config.get("payer.pullbackMaxFeeAtomic"))) +
    BigInt(Number(input.config.get("payer.pullbackSafetyAtomic")));
  return record.state === "Closed" && balances.gatewayAvailable <= dust ? "closed-dust" : null;
}

async function pocketSpendAfterObservation(
  input: ProjectionInput,
  pocket: Address,
  observedAt: number,
): Promise<boolean> {
  const maxAgeMs = Number(input.config.get("indexer.gatewayBalanceMaxAgeSeconds")) * MS_PER_SECOND;
  const result = await input.pool.query(
    `SELECT 1 FROM audit
     WHERE action='signer:gateway-nano' AND outcome='signed'
       AND at >= $2::timestamptz AND object_ids @> $1::jsonb
     LIMIT 1`,
    [JSON.stringify([{ keyRef: `K4:${pocket.toLowerCase()}` }]), new Date(observedAt - maxAgeMs)],
  );
  return result.rows.length > 0;
}

async function hasPocketAudit(pool: Pool, pocket: Address, kind: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM audit
     WHERE action=$1 AND outcome='signed'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(object_ids) AS ids
         WHERE lower(ids->>'keyRef')=lower($2)
       )
     LIMIT 1`,
    [`signer:${kind}`, `K4:${pocket}`],
  );
  return result.rows.length > 0;
}

async function overdueManualReturnFacts(
  input: ProjectionInput,
  pocket: Address,
  vault: Address,
  now: number,
): Promise<OverdueManualReturnFacts> {
  const record = await input.reader.readContract({
    address: vault,
    abi: czarVaultAbi,
    functionName: "getPocket",
    args: [pocket],
  });
  const envelope = await input.reader.readContract({
    address: vault,
    abi: czarVaultAbi,
    functionName: "getEnvelope",
    args: [record.envelopeId],
  });
  const balances = await pocketBalances(input, pocket);
  const row = (
    await input.pool.query<{
      state: string;
      closed_pocket: boolean;
      return_tx: string | null;
      return_block: string | null;
      return_log_index: number | null;
      returned_amount: string | null;
    }>(
      `SELECT state,closed_pocket,return_tx,return_block::text AS return_block,
              return_log_index,returned_amount::text AS returned_amount
       FROM payer_pullback_gateway_failures
       WHERE lower(pocket)=lower($1) AND lower(vault_address)=lower($2)
       ORDER BY manual_return_required_at DESC NULLS LAST LIMIT 1`,
      [pocket, vault],
    )
  ).rows[0];
  const base = {
    pocketStateValid: record.state === 2 || record.state === 3,
    envelopeOpen: envelope.state === 1,
    pendingPullbackZero: record.pendingPullback === 0n,
    gatewayWithdrawingZero: balances.gatewayWithdrawing === 0n,
    slowWithdrawAudited: await hasPocketAudit(input.pool, pocket, "pocket-slow-withdraw"),
    pocketReturnAudited: await hasPocketAudit(input.pool, pocket, "pocket-return"),
  };
  const rowValid =
    row !== undefined &&
    row.state === "manual-return-required" &&
    !row.closed_pocket &&
    row.return_tx !== null &&
    row.return_block !== null &&
    row.return_log_index !== null &&
    row.returned_amount !== null;
  if (!rowValid)
    return {
      ...base,
      manualReturnRowValid: false,
      returnReceiptValid: false,
      returnOverdue: false,
      manualReturnRecordedAfter: false,
    };
  const receipt = await returnReceiptFacts(input, pocket, vault, row, now);
  return { ...base, manualReturnRowValid: true, ...receipt };
}

async function returnReceiptFacts(
  input: ProjectionInput,
  pocket: Address,
  vault: Address,
  row: {
    return_tx: string | null;
    return_block: string | null;
    return_log_index: number | null;
    returned_amount: string | null;
  },
  now: number,
) {
  const receipt = await input.reader.getTransactionReceipt({ hash: row.return_tx as Hash });
  const transfer = receipt.logs.find((log) => {
    if (log.address.toLowerCase() !== ARC_USDC.toLowerCase()) return false;
    try {
      const event = decodeEventLog({ abi: usdcAbi, data: log.data, topics: log.topics });
      return (
        event.eventName === "Transfer" &&
        event.args.from.toLowerCase() === pocket.toLowerCase() &&
        event.args.to.toLowerCase() === vault.toLowerCase() &&
        event.args.value === BigInt(row.returned_amount ?? "0")
      );
    } catch {
      return false;
    }
  });
  const block = await input.reader.getBlock({ blockNumber: receipt.blockNumber });
  const returnBlock = BigInt(row.return_block ?? "0");
  const logIndex = row.return_log_index ?? -1;
  const valid =
    receipt.status === "success" &&
    receipt.blockNumber === returnBlock &&
    transfer !== undefined &&
    transfer.logIndex === logIndex;
  const holdSeconds = Number(input.config.get("payer.manualReturnHoldHours")) * SECONDS_PER_HOUR;
  const recorded = await input.reader.getContractEvents({
    address: vault,
    abi: czarVaultAbi,
    eventName: "ManualReturnRecorded",
    args: { pocket },
    fromBlock: 0n,
  });
  return {
    returnReceiptValid: valid,
    returnOverdue: valid && Number(block.timestamp) <= now - holdSeconds,
    manualReturnRecordedAfter: recorded.some(
      (event) =>
        event.blockNumber > returnBlock ||
        (event.blockNumber === returnBlock && event.logIndex > logIndex),
    ),
  };
}
