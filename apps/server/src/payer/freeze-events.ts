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
  readonly auto_limits_lowered: boolean;
}

export async function hasPendingFrozenEvent(pool: Pool, vault: Address): Promise<boolean> {
  const result = await pool.query<{ pending: boolean }>(
    `SELECT (
       NOT EXISTS (
         SELECT 1 FROM payer_freeze_autolimit_cursors WHERE vault=$1
       ) OR EXISTS (
         SELECT 1 FROM payer_freeze_autolimit_cursors
         WHERE vault=$1 AND last_scanned_block < scan_target_block
       ) OR EXISTS (
         SELECT 1 FROM payer_freeze_autolimit_events
         WHERE vault=$1 AND processed_at IS NULL AND auto_limits_lowered_at IS NULL
       )
     ) AS pending`,
    [vault],
  );
  return result.rows[0]?.pending ?? false;
}

export async function hasPendingFrozenEventAtCurrentHead(
  client: PublicClient,
  pool: Pool,
  vault: Address,
): Promise<boolean> {
  const head = await client.getBlockNumber();
  await advanceFrozenScanTarget(pool, [vault], head);
  return hasPendingFrozenEvent(pool, vault);
}

export async function advanceFrozenScanTarget(
  pool: Pool,
  vaults: readonly Address[],
  targetBlock: bigint,
): Promise<ReadonlySet<Address>> {
  if (vaults.length === 0) return new Set();
  const result = await pool.query<{ vault: string; caught_up: boolean }>(
    `UPDATE payer_freeze_autolimit_cursors
     SET scan_target_block=GREATEST(scan_target_block,$1::numeric)
     WHERE vault=ANY($2::text[])
     RETURNING vault,last_scanned_block >= scan_target_block AS caught_up`,
    [targetBlock.toString(), vaults],
  );
  return new Set(result.rows.filter((row) => row.caught_up).map((row) => row.vault as Address));
}

export async function scanFrozenEvents(
  client: PublicClient,
  pool: Pool,
  vault: Address,
  maxBlockRange: bigint,
  targetBlock?: bigint,
): Promise<boolean> {
  if (maxBlockRange <= 0n) throw new RangeError("Frozen event scan range must be positive.");
  const cursor = await pool.query<{ last_scanned_block: string }>(
    "SELECT last_scanned_block FROM payer_freeze_autolimit_cursors WHERE vault=$1",
    [vault],
  );
  const head = targetBlock ?? (await client.getBlockNumber());
  const nextBlock = cursor.rows[0] ? BigInt(cursor.rows[0].last_scanned_block) + 1n : 0n;
  if (nextBlock > head) return true;
  const page = await getFrozenEventPage(client, vault, nextBlock, head, maxBlockRange);
  await persistFrozenEventPage(pool, vault, page.events, page.toBlock, head);
  return page.toBlock >= head;
}

export async function processPendingFrozenEvents(
  pool: Pool,
  vault: Address,
  listener: (event: VaultHaltEvent, markAutoLimitsLowered: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const pending = await pool.query<PendingFreezeEvent>(
    `SELECT block_number::text AS block_number,log_index,transaction_hash,
            auto_limits_lowered_at IS NOT NULL AS auto_limits_lowered
     FROM payer_freeze_autolimit_events
     WHERE vault=$1 AND processed_at IS NULL
     ORDER BY block_number,log_index`,
    [vault],
  );
  const failures: unknown[] = [];
  for (const row of pending.rows) {
    try {
      const event = toHaltEvent(vault, row);
      const markAutoLimitsLowered = async () => {
        await pool.query(
          `UPDATE payer_freeze_autolimit_events
           SET auto_limits_lowered_at=COALESCE(auto_limits_lowered_at,now())
           WHERE vault=$1 AND block_number=$2 AND log_index=$3`,
          [vault, row.block_number, row.log_index],
        );
      };
      await listener(event, markAutoLimitsLowered);
      await pool.query(
        `UPDATE payer_freeze_autolimit_events SET processed_at=now()
         WHERE vault=$1 AND block_number=$2 AND log_index=$3 AND processed_at IS NULL`,
        [vault, row.block_number, row.log_index],
      );
    } catch (error) {
      failures.push(error);
    }
  }
  throwCollectedFailures(failures);
}

function throwCollectedFailures(failures: readonly unknown[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, `Failed to process ${failures.length} Frozen events.`);
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
      return { events, toBlock };
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
  targetBlock: bigint,
): Promise<void> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    for (const event of events) await queueFrozenEvent(connection, vault, event);
    await connection.query(
      `INSERT INTO payer_freeze_autolimit_cursors
       (vault,last_scanned_block,scan_target_block) VALUES($1,$2,$3)
       ON CONFLICT(vault) DO UPDATE SET last_scanned_block=
         GREATEST(payer_freeze_autolimit_cursors.last_scanned_block, EXCLUDED.last_scanned_block),
         scan_target_block=GREATEST(
           payer_freeze_autolimit_cursors.scan_target_block, EXCLUDED.scan_target_block
         )`,
      [vault, toBlock.toString(), targetBlock.toString()],
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
    autoLimitsLowered: row.auto_limits_lowered,
  };
}
