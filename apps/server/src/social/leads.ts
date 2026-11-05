import { createHash, randomBytes } from "node:crypto";
import type { Config } from "@czar/config";
import {
  createSafeFetchFromConfig,
  readPaymentRequired,
  SafeFetchError,
  type SafeFetch,
} from "@czar/x402";
import type { Pool, PoolClient } from "pg";
import { randomId } from "#src/http/ids";
import { isPublicContentSafe } from "#src/social/projection/denylist";

type LeadState = "probed-ok" | "rejected";
type RejectReason = "not-402" | "wrong-network" | "unsafe-origin" | "probe-failed";

interface LeadRow {
  lead_id: string;
  post_id: string;
  network: string;
  origin: string;
  path_hint: string | null;
  capability_tag: string;
  thread_id: string;
}

export interface ProbedLead {
  readonly leadId: string;
  readonly origin: string;
  readonly pathHint: string | null;
  readonly capabilityTag: string;
}

/** Discovery seam: successful unpaid probes are not yet buyable candidates. */
export async function probedLeads(
  pool: Pool,
  network: string,
  capabilityTag: string,
): Promise<ProbedLead[]> {
  const result = await pool.query<LeadRow>(
    `SELECT lead_id,origin,path_hint,capability_tag FROM social_leads
     WHERE state='probed-ok' AND network=$1 AND capability_tag=$2
     ORDER BY created_at DESC,lead_id DESC`,
    [network, capabilityTag],
  );
  return result.rows.map((row) => ({
    leadId: row.lead_id,
    origin: row.origin,
    pathHint: row.path_hint,
    capabilityTag: row.capability_tag,
  }));
}

const UNSAFE_RULES = new Set([
  "url",
  "scheme",
  "port",
  "credentials",
  "blocked-address",
  "max-redirects",
]);

async function resultFor(
  lead: LeadRow,
  fetch: SafeFetch,
  timeoutMs: number,
): Promise<{ state: LeadState; reason: RejectReason | null }> {
  const url = `${lead.origin}${lead.path_hint || "/"}`;
  let response: Awaited<ReturnType<SafeFetch>>;
  try {
    response = await fetch(url, { method: "GET", timeoutMs });
  } catch (error) {
    if (error instanceof SafeFetchError)
      return {
        state: "rejected",
        reason: UNSAFE_RULES.has(error.rule) ? "unsafe-origin" : "probe-failed",
      };
    throw error;
  }
  if (new URL(response.url).origin !== lead.origin)
    return { state: "rejected", reason: "unsafe-origin" };
  if (response.status !== 402) return { state: "rejected", reason: "not-402" };
  const parsed = readPaymentRequired({
    status: response.status,
    headers: response.headers,
    body: Buffer.from(response.body).toString("utf8"),
  });
  if (!parsed.ok) return { state: "rejected", reason: "probe-failed" };
  if (!parsed.paymentRequired.accepts.some((offer) => offer.network === lead.network))
    return { state: "rejected", reason: "wrong-network" };
  return { state: "probed-ok", reason: null };
}

async function claimLead(client: PoolClient, now: Date): Promise<LeadRow | null> {
  const result = await client.query<LeadRow>(
    `UPDATE social_leads SET state='probing',attempts=attempts+1,updated_at=$1
     WHERE lead_id=(SELECT lead_id FROM social_leads
       WHERE state='queued' OR (state='probing' AND updated_at<$2)
       ORDER BY created_at,lead_id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING lead_id,post_id,network,origin,path_hint,capability_tag,
       (SELECT thread_id FROM social_posts WHERE post_id=social_leads.post_id) AS thread_id`,
    [now, new Date(now.getTime() - 120_000)],
  );
  return result.rows[0] ?? null;
}

async function saveResult(
  pool: Pool,
  lead: LeadRow,
  outcome: { state: LeadState; reason: RejectReason | null },
  now: Date,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE social_leads SET state=$2,reject_reason=$3,updated_at=$4
       WHERE lead_id=$1 AND state='probing' RETURNING lead_id`,
      [lead.lead_id, outcome.state, outcome.reason, now],
    );
    if (updated.rowCount) {
      const postId = randomId("pst_", { bytes: randomBytes });
      const card = {
        template: "system.lead.probed",
        values: {
          origin: lead.origin,
          probeResult:
            outcome.state === "probed-ok"
              ? `it answers with a valid x402 payment request on ${lead.network}`
              : `rejected (${outcome.reason})`,
        },
      };
      if (isPublicContentSafe(card, [], lead.origin)) {
        const actionId = createHash("sha256")
          .update("system")
          .update("system.lead.probed")
          .update(lead.lead_id)
          .update("probed")
          .digest("hex");
        await client.query(
          `INSERT INTO social_posts(post_id,thread_id,author_id,kind,card,action_id,created_at)
           VALUES($1,$2,NULL,'system',$3::jsonb,$4,$5)
           ON CONFLICT(action_id) DO NOTHING`,
          [postId, lead.thread_id, JSON.stringify(card), actionId, now],
        );
        await client.query("UPDATE social_threads SET revision=revision+1 WHERE thread_id=$1", [
          lead.thread_id,
        ]);
        await client.query(
          `INSERT INTO outbox_events(name,payload,delivered_at)
           VALUES('social.post.published',$1::jsonb,now())`,
          [JSON.stringify({ postId, threadId: lead.thread_id })],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Probe at most the configured number of queued leads; never send a payment. */
export async function probeLeads(
  pool: Pool,
  config: Config,
  now: Date,
  fetch: SafeFetch = createSafeFetchFromConfig(config, "czar-server/social"),
): Promise<void> {
  const limit = Number(config.get("social.leadsPerPass"));
  for (let index = 0; index < limit; index += 1) {
    const client = await pool.connect();
    let lead: LeadRow | null;
    try {
      lead = await claimLead(client, now);
    } finally {
      client.release();
    }
    if (!lead) return;
    const outcome = await resultFor(lead, fetch, Number(config.get("planner.probeTimeoutMs")));
    await saveResult(pool, lead, outcome, now);
  }
}
