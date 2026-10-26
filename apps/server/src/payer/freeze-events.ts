import { czarVaultAbi } from "@czar/vault-client";
import type { Address, Hex, PublicClient } from "viem";
import type { Pool, PoolClient } from "pg";
import type { VaultHaltEvent } from "#src/payer/runtime";

export interface FrozenEventIdentity {
  readonly blockNumber?: bigint | null;
  readonly logIndex?: number | null;
  readonly transactionHash?: Hex | null;
}

interface PendingFreezeEvent {
  readonly block_number: string;
  readonly log_index: number;
  readonly transaction_hash: Hex;
}

export async function hasPendingFrozenEvent(pool: Pool, vault: Address): Promise<boolean> {
  const result = await pool.query<{ pending: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM payer_freeze_autolimit_events WHERE vault=$1 AND processed_at IS NULL
     ) AS pending`,
    [vault],
  );
  return result.rows[0]?.pending ?? false;
}

export async function freezeHandlingPending(
  client: PublicClient,
  pool: Pool,
  vault: Address,
  maxBlockRange: bigint,
): Promise<boolean> {
  await scanFrozenEvents(client, pool, vault, maxBlockRange);
  return hasPendingFrozenEvent(pool, vault);
}

export async function scanFrozenEvents(
  client: PublicClient,
  pool: Pool,
  vault: Address,
  maxBlockRange: bigint,
): Promise<void> {
  if (maxBlockRange <= 0n) throw new RangeError("Frozen event scan range must be positive.");
  const cursor = await pool.query<{ last_scanned_block: string }>(
    "SELECT last_scanned_block FROM payer_freeze_autolimit_cursors WHERE vault=$1",
    [vault],
  );
  const head = await client.getBlockNumber();
  const nextBlock = cursor.rows[0] ? BigInt(cursor.rows[0].last_scanned_block) + 1n : 0n;
  if (nextBlock > head) return;
  let pageStart = nextBlock;
  let pageRange = maxBlockRange;
  while (pageStart <= head) {
    const page = await getFrozenEventPage(client, vault, pageStart, head, pageRange);
    await persistFrozenEventPage(pool, vault, page.events, page.toBlock);
    pageStart = page.toBlock + 1n;
    pageRange = page.range;
  }
}

export async function processPendingFrozenEvents(
  pool: Pool,
  vault: Address,
  listener: (event: VaultHaltEvent) => Promise<void>,
): Promise<void> {
  const pending = await pool.query<PendingFreezeEvent>(
    `SELECT block_number::text AS block_number,log_index,transaction_hash
     FROM payer_freeze_autolimit_events
     WHERE vault=$1 AND processed_at IS NULL
     ORDER BY block_number,log_index`,
    [vault],
  );
  for (const row of pending.rows) {
    const event = toHaltEvent(vault, row);
    await listener(event);
    await pool.query(
      `UPDATE payer_freeze_autolimit_events SET processed_at=now()
       WHERE vault=$1 AND block_number=$2 AND log_index=$3 AND processed_at IS NULL`,
      [vault, row.block_number, row.log_index],
    );
  }
}

export async function queueFrozenEvent(
  pool: Pool | PoolClient,
  vault: Address,
  event: FrozenEventIdentity,
): Promise<void> {
  if (
    event.blockNumber === undefined ||
    event.blockNumber === null ||
    event.logIndex === undefined ||
    event.logIndex === null ||
    event.transactionHash === undefined ||
    event.transactionHash === null
  )
    throw new Error("Frozen event is missing block, log index, or transaction identity.");
  await pool.query(
    `INSERT INTO payer_freeze_autolimit_events(vault,block_number,log_index,transaction_hash)
     VALUES($1,$2,$3,$4) ON CONFLICT(vault,block_number,log_index) DO NOTHING`,
    [vault, event.blockNumber.toString(), event.logIndex, event.transactionHash],
  );
}

interface FrozenEventPage {
  readonly events: readonly FrozenEventIdentity[];
  readonly toBlock: bigint;
  readonly range: bigint;
}

async function getFrozenEventPage(
  client: PublicClient,
  vault: Address,
  fromBlock: bigint,
  head: bigint,
  initialRange: bigint,
): Promise<FrozenEventPage> {
  let range = initialRange;
  while (true) {
    const toBlock = minBigInt(fromBlock + range - 1n, head);
    try {
      const events = await client.getContractEvents({
        address: vault,
        abi: czarVaultAbi,
        eventName: "Frozen",
        fromBlock,
        toBlock,
      });
      return { events, toBlock, range };
    } catch (error) {
      if (!isLogRangeError(error) || range === 1n) throw error;
      range = range / 2n || 1n;
    }
  }
}

async function persistFrozenEventPage(
  pool: Pool,
  vault: Address,
  events: readonly FrozenEventIdentity[],
  toBlock: bigint,
): Promise<void> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    for (const event of events) await queueFrozenEvent(connection, vault, event);
    await connection.query(
      `INSERT INTO payer_freeze_autolimit_cursors(vault,last_scanned_block) VALUES($1,$2)
       ON CONFLICT(vault) DO UPDATE SET last_scanned_block=
         GREATEST(payer_freeze_autolimit_cursors.last_scanned_block, EXCLUDED.last_scanned_block)`,
      [vault, toBlock.toString()],
    );
    await connection.query("COMMIT");
  } catch (error) {
    try {
      await connection.query("ROLLBACK");
    } catch (rollbackError) {
      const failure = new Error("Frozen event page rollback failed.", { cause: error });
      Object.defineProperty(failure, "rollbackError", { value: rollbackError });
      throw failure;
    }
    throw error;
  } finally {
    connection.release();
  }
}

function isLogRangeError(error: unknown): boolean {
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === -32012 || candidate.code === "-32012") return true;
    current = candidate.cause;
  }
  return false;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function toHaltEvent(vault: Address, row: PendingFreezeEvent): VaultHaltEvent {
  return {
    name: "Frozen",
    vault,
    blockNumber: BigInt(row.block_number),
    logIndex: row.log_index,
    transactionHash: row.transaction_hash,
  };
}
