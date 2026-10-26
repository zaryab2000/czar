import { czarVaultAbi } from "@czar/vault-client";
import type { Address, Hex, PublicClient } from "viem";
import type { Pool } from "pg";
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

export async function scanFrozenEvents(
  client: PublicClient,
  pool: Pool,
  vault: Address,
): Promise<void> {
  const cursor = await pool.query<{ last_scanned_block: string }>(
    "SELECT last_scanned_block FROM payer_freeze_autolimit_cursors WHERE vault=$1",
    [vault],
  );
  const head = await client.getBlockNumber();
  const nextBlock = cursor.rows[0] ? BigInt(cursor.rows[0].last_scanned_block) + 1n : 0n;
  if (nextBlock > head) return;
  const events = await client.getContractEvents({
    address: vault,
    abi: czarVaultAbi,
    eventName: "Frozen",
    fromBlock: nextBlock,
    toBlock: head,
  });
  for (const event of events) await queueFrozenEvent(pool, vault, event);
  await pool.query(
    `INSERT INTO payer_freeze_autolimit_cursors(vault,last_scanned_block) VALUES($1,$2)
     ON CONFLICT(vault) DO UPDATE SET last_scanned_block=EXCLUDED.last_scanned_block`,
    [vault, head.toString()],
  );
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
  pool: Pool,
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

function toHaltEvent(vault: Address, row: PendingFreezeEvent): VaultHaltEvent {
  return {
    name: "Frozen",
    vault,
    blockNumber: BigInt(row.block_number),
    logIndex: row.log_index,
    transactionHash: row.transaction_hash,
  };
}
