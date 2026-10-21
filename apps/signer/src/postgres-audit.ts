import type { AuditRow, AuditSink } from "./service.ts";

export interface AuditQueryExecutor {
  query(sql: string, values: unknown[]): Promise<unknown>;
}

/** Write signer decisions to the existing server `audit` table without storing request payloads. */
export function postgresAudit(executor: AuditQueryExecutor): AuditSink {
  return {
    async write(row: AuditRow): Promise<void> {
      const objectIds = JSON.stringify([
        {
          keyRef: row.keyRef,
          purpose: row.purpose,
          ...(row.digest === undefined ? {} : { digest: row.digest }),
          ...(row.rule === undefined ? {} : { rule: row.rule }),
        },
      ]);
      await executor.query(
        `INSERT INTO audit (actor_key_id, action, object_ids, outcome, at)
         VALUES ($1, $2, $3::jsonb, $4, to_timestamp($5 / 1000.0))`,
        [row.caller, `signer:${row.kind}`, objectIds, row.outcome, row.at],
      );
    },
  };
}
