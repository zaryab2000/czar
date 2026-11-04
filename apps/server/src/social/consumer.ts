import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Config } from "@czar/config";
import { randomId } from "#src/http/ids";
import { routeSocialEvent } from "#src/social/router";

interface OutboxEvent {
  event_id: string;
  txid: string;
  name: string;
  objective_id: string | null;
  payload: Record<string, unknown>;
}

interface InboxTarget {
  representativeId: string;
  kind: string;
  refs: Record<string, unknown>;
}

async function ownerTarget(client: PoolClient, event: OutboxEvent): Promise<InboxTarget | null> {
  const objectiveId =
    event.name === "rating.recorded" ? event.payload["objectiveId"] : event.objective_id;
  if (typeof objectiveId !== "string") return null;
  const owner = await client.query<{ user_id: string }>(
    "SELECT user_id FROM social_objective_projection WHERE objective_id=$1",
    [objectiveId],
  );
  const userId = owner.rows[0]?.user_id;
  if (!userId) return null;
  const representativeId = randomId("rep_", { bytes: randomBytes });
  const representative = await client.query<{ representative_id: string }>(
    `INSERT INTO social_representatives(representative_id,user_id,handle,controlled)
     SELECT $1,u.user_id,$2,u.controlled FROM social_user_projection u WHERE u.user_id=$3
     ON CONFLICT(user_id) DO UPDATE SET user_id=EXCLUDED.user_id
     RETURNING representative_id`,
    [representativeId, `Rep-${representativeId.slice(-4)}`, userId],
  );
  const id = representative.rows[0]?.representative_id;
  if (!id) return null;
  if (event.name === "rating.recorded") {
    if (
      typeof event.payload["ratingId"] !== "string" ||
      !Number.isInteger(event.payload["stepIndex"])
    )
      return null;
    return {
      representativeId: id,
      kind: "outcome-updated",
      refs: {
        objectiveId,
        ratingId: event.payload["ratingId"],
        stepIndex: event.payload["stepIndex"],
      },
    };
  }
  return {
    representativeId: id,
    kind: event.name === "objective.no-supplier" ? "need-unmet" : "outcome-ready",
    refs: { objectiveId },
  };
}

function isOwnerEvent(name: string): boolean {
  return (
    name === "objective.delivered" ||
    name === "objective.failed" ||
    name === "objective.no-supplier" ||
    name === "rating.recorded"
  );
}

async function consumeOne(pool: Pool, config?: Config): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO social_consumer_cursor(consumer) VALUES('social') ON CONFLICT DO NOTHING",
    );
    const cursor = await client.query<{ last_txid: string; last_event_id: string }>(
      "SELECT last_txid::text,last_event_id FROM social_consumer_cursor WHERE consumer='social' FOR UPDATE",
    );
    const next = await client.query<OutboxEvent>(
      `SELECT event_id,txid::text,name,objective_id,payload FROM outbox_events
       WHERE (txid,event_id)>($1::xid8,$2::bigint)
         AND txid<pg_snapshot_xmin(pg_current_snapshot())
       ORDER BY txid,event_id LIMIT 1`,
      [cursor.rows[0]?.last_txid, cursor.rows[0]?.last_event_id],
    );
    const event = next.rows[0];
    if (!event) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `INSERT INTO event_deliveries(event_id,consumer,state)
       VALUES($1,'social','done') ON CONFLICT DO NOTHING`,
      [event.event_id],
    );
    if (isOwnerEvent(event.name)) {
      const target = await ownerTarget(client, event);
      if (target) {
        await client.query(
          `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
           VALUES($1,$2,$3,$4) ON CONFLICT(representative_id,event_id) DO NOTHING`,
          [target.representativeId, event.event_id, target.kind, target.refs],
        );
      }
    } else if (event.name.startsWith("social.")) {
      await routeSocialEvent(
        client,
        event.name,
        event.payload,
        event.event_id,
        Number(config?.get("social.maxRecipientsPerPost") ?? 3),
        Number(config?.get("social.maxIncidentRecipients") ?? 20),
        Number(config?.get("social.routingCooldownMinutes") ?? 60),
      );
    }
    await client.query(
      `UPDATE social_consumer_cursor SET last_txid=$1::xid8,last_event_id=$2
       WHERE consumer='social'`,
      [event.txid, event.event_id],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Deliver committed owner events exactly once while preserving late-commit ordering. */
export async function consumeSocialBatch(
  pool: Pool,
  batchSize: number,
  config?: Config,
): Promise<number> {
  let consumed = 0;
  while (consumed < batchSize && (await consumeOne(pool, config))) consumed += 1;
  return consumed;
}
