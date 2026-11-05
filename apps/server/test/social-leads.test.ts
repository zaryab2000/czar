import { createHash } from "node:crypto";
import { loadConfig } from "@czar/config";
import { createSafeFetch, encodeBase64Json, type Transport } from "@czar/x402";
import { describe, expect, it } from "vitest";
import { probeLeads, probedLeads } from "#src/social/leads";
import { setupDatabase } from "#test/db";

const getPool = setupDatabase();
const NETWORK = "eip155:5042002";
const ORIGIN = "https://seller.example";
const AT = new Date("2026-11-05T00:00:00.000Z");

function probedActionId(leadId: string): string {
  return createHash("sha256")
    .update("system")
    .update("system.lead.probed")
    .update(leadId)
    .update("probed")
    .digest("hex");
}

async function seedLead(index: number, origin = ORIGIN): Promise<string> {
  const userId = `usr_${String(index).padStart(26, "0")}`;
  const repId = `rep_${String(index).padStart(26, "0")}`;
  const threadId = `thr_${String(index).padStart(26, "0")}`;
  const postId = `pst_${String(index).padStart(26, "0")}`;
  const leadId = `led_${String(index).padStart(26, "0")}`;
  await getPool().query("INSERT INTO users(user_id) VALUES($1)", [userId]);
  await getPool().query(
    `INSERT INTO social_representatives(representative_id,user_id,handle) VALUES($1,$2,$3)`,
    [repId, userId, `Rep-${String(index).padStart(4, "0")}`],
  );
  await getPool().query(
    `INSERT INTO social_threads(thread_id,kind,network,subject_key,opened_by,contributions)
     VALUES($1,'question',$2,$3,$4,1)`,
    [threadId, NETWORK, `question:${threadId}`, repId],
  );
  await getPool().query(
    `INSERT INTO social_posts(post_id,thread_id,author_id,kind,card,action_id)
     VALUES($1,$2,$3,'lead',$4::jsonb,$5)`,
    [postId, threadId, repId, JSON.stringify({ origin }), `lead:${index}`],
  );
  await getPool().query(
    `INSERT INTO social_leads(lead_id,post_id,network,origin,capability_tag)
     VALUES($1,$2,$3,$4,'web-search')`,
    [leadId, postId, NETWORK, origin],
  );
  return leadId;
}

function challenge(network = NETWORK): string {
  return encodeBase64Json({
    x402Version: 2,
    resource: { url: `${ORIGIN}/` },
    accepts: [
      {
        scheme: "exact",
        network,
        amount: "1000",
        asset: "0x3600000000000000000000000000000000000000",
        payTo: `0x${"1".repeat(40)}`,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  });
}

function fetchWith(
  transport: Transport,
  resolve = async () => [{ address: "93.184.216.34", family: 4 }],
) {
  return createSafeFetch({
    localMerchantOrigins: [],
    maxRedirects: 2,
    maxBytes: 65536,
    timeoutMs: 1000,
    version: "test",
    resolve,
    transport,
    interfaceAddresses: () => [],
  });
}

function response(status: number, headers: Record<string, string> = {}) {
  return {
    status,
    headers,
    body: (async function* () {
      yield Buffer.from("");
    })(),
  };
}

const validChallengeTransport: Transport = async (target) => {
  expect(target.method).toBe("GET");
  expect(target.body).toBeUndefined();
  return response(402, { "payment-required": challenge() });
};

async function state(leadId: string) {
  const result = await getPool().query<{ state: string; reject_reason: string | null }>(
    "SELECT state,reject_reason FROM social_leads WHERE lead_id=$1",
    [leadId],
  );
  return result.rows[0];
}

describe("SN-4 unpaid lead probe", () => {
  it("accepts one valid payment-network 402 using an injected transport, without payment", async () => {
    const leadId = await seedLead(1);
    await probeLeads(getPool(), loadConfig(), AT, fetchWith(validChallengeTransport));
    expect(await state(leadId)).toEqual({ state: "probed-ok", reject_reason: null });
    expect(await probedLeads(getPool(), NETWORK, "web-search")).toMatchObject([
      { leadId, origin: ORIGIN },
    ]);
    const posts = await getPool().query("SELECT card FROM social_posts WHERE action_id=$1", [
      probedActionId(leadId),
    ]);
    expect(posts.rows[0]?.card["template"]).toBe("system.lead.probed");
    expect(posts.rows[0]?.card["values"]["probeResult"]).toBe(
      `it answers with a valid x402 payment request on ${NETWORK}`,
    );
    const thread = await getPool().query<{ contributions: number; revision: number }>(
      `SELECT contributions,revision FROM social_threads WHERE thread_id=$1`,
      [`thr_${String(1).padStart(26, "0")}`],
    );
    expect(thread.rows[0]).toEqual({ contributions: 1, revision: 2 });
  });

  it("rejects a wrong-network challenge and an unpaid 200", async () => {
    const wrong = await seedLead(2, "https://wrong.example");
    await probeLeads(
      getPool(),
      loadConfig(),
      AT,
      fetchWith(async () => response(402, { "payment-required": challenge("eip155:1") })),
    );
    expect(await state(wrong)).toEqual({ state: "rejected", reject_reason: "wrong-network" });
    const plain = await seedLead(3, "https://plain.example");
    await probeLeads(
      getPool(),
      loadConfig(),
      AT,
      fetchWith(async () => response(200)),
    );
    expect(await state(plain)).toEqual({ state: "rejected", reject_reason: "not-402" });
    const rejectedPost = await getPool().query<{ card: { values: { probeResult: string } } }>(
      "SELECT card FROM social_posts WHERE action_id=$1",
      [probedActionId(plain)],
    );
    expect(rejectedPost.rows[0]?.card.values.probeResult).toBe("rejected (not-402)");
  });

  it("rejects an unapproved HTTP origin and a DNS failure without posting payment data", async () => {
    const unsafe = await seedLead(4, "http://unsafe.example");
    await probeLeads(
      getPool(),
      loadConfig(),
      AT,
      fetchWith(async () => response(402)),
    );
    expect(await state(unsafe)).toEqual({ state: "rejected", reject_reason: "unsafe-origin" });
    const dns = await seedLead(5, "https://dns.example");
    await probeLeads(
      getPool(),
      loadConfig(),
      AT,
      fetchWith(
        async () => response(402),
        async () => {
          throw new Error("dns failed");
        },
      ),
    );
    expect(await state(dns)).toEqual({ state: "rejected", reject_reason: "probe-failed" });
  });

  it("rejects a cross-host redirect even when the target also answers 402", async () => {
    const leadId = await seedLead(7, "https://redirect.example");
    const connected: string[] = [];
    const transport: Transport = async (target) => {
      connected.push(target.hostname);
      return target.hostname === "redirect.example"
        ? response(302, { location: "https://other.example/" })
        : response(402, { "payment-required": challenge() });
    };
    await probeLeads(getPool(), loadConfig(), AT, fetchWith(transport));
    expect(connected).toEqual(["redirect.example", "other.example"]);
    expect(await state(leadId)).toEqual({ state: "rejected", reject_reason: "unsafe-origin" });
  });

  it("blocks a forbidden HTTPS port and a private address before connecting", async () => {
    const connected: string[] = [];
    const transport: Transport = async (target) => {
      connected.push(target.hostname);
      return response(402, { "payment-required": challenge() });
    };
    const port = await seedLead(8, "https://port.example:8443");
    await probeLeads(getPool(), loadConfig(), AT, fetchWith(transport));
    expect(await state(port)).toEqual({ state: "rejected", reject_reason: "unsafe-origin" });
    const privateAddress = await seedLead(9, "https://169.254.169.254");
    await probeLeads(getPool(), loadConfig(), AT, fetchWith(transport));
    expect(await state(privateAddress)).toEqual({
      state: "rejected",
      reject_reason: "unsafe-origin",
    });
    expect(connected).toEqual([]);
  });

  it("classifies redirect loops and oversized or malformed 402 replies", async () => {
    const loop = await seedLead(10, "https://loop.example");
    await probeLeads(
      getPool(),
      loadConfig(),
      AT,
      fetchWith(async (target) => response(302, { location: `${target.path}next` })),
    );
    expect(await state(loop)).toEqual({ state: "rejected", reject_reason: "unsafe-origin" });
    const oversized = await seedLead(11, "https://large.example");
    await probeLeads(
      getPool(),
      loadConfig(),
      AT,
      fetchWith(async () => ({
        status: 402,
        headers: { "payment-required": challenge() },
        body: (async function* () {
          yield Buffer.alloc(65_537);
        })(),
      })),
    );
    expect(await state(oversized)).toEqual({ state: "rejected", reject_reason: "probe-failed" });
    const malformed = await seedLead(12, "https://malformed.example");
    await probeLeads(
      getPool(),
      loadConfig(),
      AT,
      fetchWith(async () => response(402, { "payment-required": "not-base64" })),
    );
    expect(await state(malformed)).toEqual({ state: "rejected", reject_reason: "probe-failed" });
  });

  it("does not publish private identifiers from a queued lead as a system card", async () => {
    const leadId = await seedLead(6, "https://obs_private.example");
    await probeLeads(
      getPool(),
      loadConfig(),
      AT,
      fetchWith(async () => response(200)),
    );
    const posts = await getPool().query<{ card: Record<string, unknown> }>(
      "SELECT card FROM social_posts WHERE action_id=$1",
      [probedActionId(leadId)],
    );
    expect(posts.rows.every((row) => !JSON.stringify(row.card).includes("obs_private"))).toBe(true);
  });
});
