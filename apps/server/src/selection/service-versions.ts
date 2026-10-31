import type { Pool } from "pg";

/** Records a verified live probe and clears old H4 facts only on first sight of a new version. */
export async function recordServiceVersion(input: {
  readonly pool: Pool;
  readonly network: string;
  readonly serviceId: string;
  readonly versionId: string;
  readonly now: Date;
}): Promise<void> {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO service_versions(network,service_id,version_id,first_seen_at,last_seen_at)
       VALUES($1,$2,$3,$4,$4)
       ON CONFLICT(network,service_id,version_id) DO NOTHING
       RETURNING version_id`,
      [input.network, input.serviceId, input.versionId, input.now],
    );
    if (inserted.rowCount === 0) {
      await client.query(
        `UPDATE service_versions SET last_seen_at=GREATEST(last_seen_at,$4)
         WHERE network=$1 AND service_id=$2 AND version_id=$3`,
        [input.network, input.serviceId, input.versionId, input.now],
      );
    } else {
      await client.query(
        `UPDATE supplier_health SET cleared_at=$4
         WHERE network=$1 AND service_id=$2 AND version_id<>$3
           AND fact='injection-blocked' AND cleared_at IS NULL`,
        [input.network, input.serviceId, input.versionId, input.now],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
