import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { apiContracts, validateRecordedExchange } from "@czar/api-contract";
import { setupDatabase } from "#test/db";
import {
  createTestContext,
  seedDevice,
  testAppConfig,
  TEST_DEVICE_ID,
  TEST_USER_ID,
} from "#test/fixtures";

const getPool = setupDatabase();
const token = Buffer.alloc(32, 19).toString("base64url");
const auth = { Authorization: `Bearer ${token}` };

beforeAll(async () => {
  await seedDevice(getPool());
  await getPool().query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [createHash("sha256").update(token).digest(), TEST_USER_ID],
  );
});

describe("SN-1 social routes", () => {
  it("serves public empty pages and signals without login and validates every response", async () => {
    const { app } = createTestContext(getPool());
    const paths = [
      ["listSocialFeed", "/v1/social/feed"],
      ["listSocialThreads", "/v1/social/threads"],
      ["listSocialIncidents", "/v1/social/incidents"],
      [
        "getSocialServiceSignals",
        `/v1/social/services/svc_${"a".repeat(32)}/signals?network=eip155:5042002`,
      ],
    ] as const;
    for (const [operation, path] of paths) {
      const response = await app.request(path, undefined, { remoteAddr: "192.0.2.1" });
      expect(response.status, operation).toBe(200);
      const body = await response.json();
      expect(
        validateRecordedExchange(operation, {
          responseStatus: 200,
          responseBody: body,
        }).valid,
        operation,
      ).toBe(true);
      if (operation === "listSocialFeed") {
        expect(response.headers.get("X-Czar-Social-Poll-Seconds")).toBe("15");
      }
    }
  });

  it("creates the representative lazily and requires current consent on every sharing change", async () => {
    const { app } = createTestContext(getPool());
    const me = await app.request("/v1/social/me", { headers: auth });
    expect(me.status).toBe(200);
    expect(
      validateRecordedExchange("getSocialMe", {
        responseStatus: 200,
        responseBody: await me.clone().json(),
      }).valid,
    ).toBe(true);
    const update = (sharing: string, consentTextVersion: string) =>
      app.request("/v1/social/me", {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ sharing, consentTextVersion }),
      });
    const stale = await update("structured", "stale-client-version");
    expect(stale.status).toBe(422);
    expect(apiContracts.get("updateSocialMe")?.responses.get("4XX")?.(await stale.json())).toBe(
      true,
    );
    const enabled = await update("structured", "2026-11-05");
    expect(enabled.status).toBe(200);
    expect(
      validateRecordedExchange("updateSocialMe", {
        requestBody: { sharing: "structured", consentTextVersion: "2026-11-05" },
        responseStatus: 200,
        responseBody: await enabled.clone().json(),
      }).valid,
    ).toBe(true);
    const beforePause = await getPool().query<{
      sharing_version: number;
      consent_text_version: string | null;
      consented_at: Date | null;
    }>(
      "SELECT sharing_version,consent_text_version,consented_at FROM social_representatives WHERE user_id=$1",
      [TEST_USER_ID],
    );
    const paused = await app.request("/v1/social/me", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ paused: true }),
    });
    expect(paused.status).toBe(200);
    const afterPause = await getPool().query<{
      sharing_version: number;
      consent_text_version: string | null;
      consented_at: Date | null;
    }>(
      "SELECT sharing_version,consent_text_version,consented_at FROM social_representatives WHERE user_id=$1",
      [TEST_USER_ID],
    );
    expect(afterPause.rows[0]).toEqual(beforePause.rows[0]);
    const resumed = await app.request("/v1/social/me", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ paused: false }),
    });
    expect(resumed.status).toBe(200);
    const staleOff = await update("off", "stale-client-version");
    expect(staleOff.status).toBe(422);
    const off = await update("off", "2026-11-05");
    expect(off.status).toBe(200);
    expect(((await off.json()) as { sharing: string }).sharing).toBe("off");
  });

  it("rejects forged public address headers and requires an app session for owner reads", async () => {
    const { app } = createTestContext(getPool());
    const publicResponse = await app.request(
      "/v1/social/feed",
      {
        headers: { "X-Forwarded-For": "203.0.113.9" },
      },
      { remoteAddr: "192.0.2.8" },
    );
    expect(publicResponse.status).toBe(200);
    const unauthenticated = await app.request("/v1/social/me");
    expect(unauthenticated.status).toBe(401);
    expect(
      apiContracts.get("getSocialMe")?.responses.get("4XX")?.(await unauthenticated.json()),
    ).toBe(true);
  });

  it("limits public reads by socket address and validates the error contract", async () => {
    const { app } = createTestContext(getPool(), {
      config: testAppConfig({
        "social.publicReadRateLimitPerMinute": 1,
      }),
    });
    const first = await app.request("/v1/social/feed", undefined, { remoteAddr: "192.0.2.77" });
    const denied = await app.request(
      "/v1/social/feed",
      {
        headers: { "X-Forwarded-For": "192.0.2.78" },
      },
      { remoteAddr: "192.0.2.77" },
    );
    expect(first.status).toBe(200);
    expect(denied.status).toBe(429);
    expect(apiContracts.get("listSocialFeed")?.responses.get("429")?.(await denied.json())).toBe(
      true,
    );
  });

  it("accepts owner leads and pages feed and threads without losing the boundary row", async () => {
    const { app } = createTestContext(getPool());
    const enabled = await app.request("/v1/social/me", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ sharing: "structured", consentTextVersion: "2026-11-05" }),
    });
    expect(enabled.status).toBe(200);
    const posted: string[] = [];
    for (const origin of ["https://one.example", "https://two.example", "https://three.example"]) {
      const requestBody = { network: "eip155:5042002", origin, capabilityTag: "web-search" };
      const response = await app.request("/v1/social/leads", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify(requestBody),
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as { postId: string };
      expect(
        validateRecordedExchange("suggestSocialLead", {
          requestBody,
          responseStatus: 202,
          responseBody: body,
        }).valid,
      ).toBe(true);
      posted.push(body.postId);
      const event = await getPool().query<{ delivered_at: Date | null }>(
        `SELECT delivered_at FROM outbox_events
         WHERE name='social.post.published' AND payload->>'postId'=$1`,
        [body.postId],
      );
      expect(event.rows).toHaveLength(1);
      expect(event.rows[0]?.delivered_at).not.toBeNull();
    }
    const feedFirst = await app.request("/v1/social/feed?limit=2", undefined, {
      remoteAddr: "192.0.2.3",
    });
    const feedPage = (await feedFirst.json()) as {
      items: { postId: string }[];
      nextCursor: string;
    };
    const feedSecond = await app.request(
      `/v1/social/feed?limit=2&cursor=${feedPage.nextCursor}`,
      undefined,
      { remoteAddr: "192.0.2.3" },
    );
    const feedNext = (await feedSecond.json()) as { items: { postId: string }[] };
    expect([...feedPage.items, ...feedNext.items].map((post) => post.postId).toSorted()).toEqual(
      posted.toSorted(),
    );
    const threadsFirst = await app.request("/v1/social/threads?limit=2");
    const threadsPage = (await threadsFirst.json()) as { items: object[]; nextCursor: string };
    const threadsSecond = await app.request(
      `/v1/social/threads?limit=2&cursor=${threadsPage.nextCursor}`,
    );
    const threadsNext = (await threadsSecond.json()) as { items: object[] };
    expect(threadsPage.items).toHaveLength(2);
    expect(threadsNext.items).toHaveLength(1);
  });

  it("tombstones every revision and supersedes lessons from the chain", async () => {
    const pool = getPool();
    const { app } = createTestContext(pool);
    const first = await pool.query<{
      post_id: string;
      thread_id: string;
      author_id: string;
      card: object;
    }>("SELECT post_id,thread_id,author_id,card FROM social_posts WHERE kind='lead' LIMIT 1");
    const post = first.rows[0]!;
    const revisionId = `pst_${"Z".repeat(26)}`;
    await pool.query(
      `INSERT INTO social_posts(post_id,thread_id,author_id,kind,card,action_id,revision)
       VALUES($1,$2,$3,'lead',$4,'revision-test',2)`,
      [revisionId, post.thread_id, post.author_id, post.card],
    );
    await pool.query("UPDATE social_posts SET superseded_by=$2 WHERE post_id=$1", [
      post.post_id,
      revisionId,
    ]);
    for (const [index, sourcePost] of [post.post_id, revisionId].entries()) {
      await pool.query(
        `INSERT INTO social_lessons(lesson_id,user_id,network,service_id,task_class,
          proposition,strength,source_post_id,source_obs_id,expires_at)
         VALUES($1,$2,'eip155:5042002',$3,'web-search','avoid',0.3,$4,$5,now()+interval '1 day')`,
        [
          `les_${String(index).repeat(26)}`,
          TEST_USER_ID,
          `svc_${"a".repeat(32)}`,
          sourcePost,
          `obs_test_${index}`,
        ],
      );
    }
    const observationId = `obs_${"a".repeat(32)}`;
    await pool.query(
      `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
       VALUES($1,$2,$3,'{}',$4,'delivered')`,
      [`obj_${"A".repeat(26)}`, TEST_USER_ID, TEST_DEVICE_ID, `0x${"a".repeat(64)}`],
    );
    await pool.query(
      `INSERT INTO observations(obs_id,user_id,vault,network,rail,service_id,task_class,
        objective_id,envelope_ref,step_index,call_index,payment_ref_hash,payment_id,dedup_key)
       VALUES($1,$2,$3,'eip155:5042002','x402-exact',$4,'web-search',$5,$6,0,0,$7,'pay-test','dedup-test')`,
      [
        observationId,
        TEST_USER_ID,
        `0x${"0".repeat(40)}`,
        `svc_${"a".repeat(32)}`,
        `obj_${"A".repeat(26)}`,
        `eip155:5042002:0x${"0".repeat(40)}:1`,
        `0x${"b".repeat(64)}`,
      ],
    );
    await pool.query(
      "INSERT INTO social_evidence_links(post_id,obs_id,link_kind) VALUES($1,$2,'attach')",
      [post.post_id, observationId],
    );
    const response = await app.request(`/v1/social/posts/${post.post_id}`, {
      method: "DELETE",
      headers: { ...auth, "Idempotency-Key": randomUUID() },
    });
    expect(response.status).toBe(204);
    expect(validateRecordedExchange("deleteSocialPost", { responseStatus: 204 }).valid).toBe(true);
    const rows = await pool.query(
      "SELECT card,tombstoned_at FROM social_posts WHERE post_id=ANY($1)",
      [[post.post_id, revisionId]],
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.card).toEqual({ tombstoned: true });
      expect(row.tombstoned_at).not.toBeNull();
    }
    const lessons = await pool.query("SELECT state FROM social_lessons WHERE user_id=$1", [
      TEST_USER_ID,
    ]);
    expect(lessons.rows).toEqual([{ state: "superseded" }, { state: "superseded" }]);
    const links = await pool.query("SELECT post_id FROM social_evidence_links WHERE obs_id=$1", [
      observationId,
    ]);
    expect(links.rows).toEqual([{ post_id: post.post_id }]);
  });

  it("serves incident, thread, activity, and lesson contracts with public day timestamps", async () => {
    const pool = getPool();
    const { app } = createTestContext(pool);
    const incidentIds: string[] = [];
    for (const [index, digit] of ["A", "B", "C"].entries()) {
      const threadId = `thr_${digit.repeat(26)}`;
      const incidentId = `inc_${digit.repeat(26)}`;
      incidentIds.push(incidentId);
      await pool.query(
        `INSERT INTO social_threads(thread_id,kind,network,service_id,version_id,task_class,
          subject_key,incident_id)
         VALUES($1,'incident','eip155:5042002',$2,'ver_unknown',$3,$4,$5)`,
        [threadId, `svc_${"a".repeat(32)}`, `task-${index}`, `incident:task-${index}`, incidentId],
      );
      await pool.query(
        `INSERT INTO social_incidents(incident_id,network,service_id,version_id,task_class,
          state,distinct_owners,negative_units,window_start,window_end,thread_id,opened_at)
         VALUES($1,'eip155:5042002',$2,'ver_unknown',$3,'open',3,4,$4,$5,$6,$7)`,
        [
          incidentId,
          `svc_${"a".repeat(32)}`,
          `task-${index}`,
          new Date("2026-11-01T01:00:00Z"),
          new Date("2026-11-05T01:00:00Z"),
          threadId,
          new Date(`2026-11-05T09:14:${String(index).padStart(2, "0")}Z`),
        ],
      );
      const objectiveId = `obj_${digit.repeat(25)}Q`;
      await pool.query(
        `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
         VALUES($1,$2,$3,$4,$5,'planning')`,
        [
          objectiveId,
          TEST_USER_ID,
          TEST_DEVICE_ID,
          JSON.stringify({ capabilities: ["web-search"], taskSpec: { kind: "table-fill" } }),
          `0x${"a".repeat(64)}`,
        ],
      );
      await pool.query(
        `INSERT INTO observations(obs_id,user_id,vault,network,rail,service_id,version_id,
          task_class,objective_id,envelope_ref,step_index,call_index,payment_ref_hash,
          payment_id,dedup_key,delivered,settled_at)
         VALUES($1,$2,$3,'eip155:5042002','x402-exact',$4,'ver_unknown',$5,$6,$7,0,$8,$9,$10,$11,0,$12)`,
        [
          `obs_${(index + 101).toString(16).padStart(32, "0")}`,
          TEST_USER_ID,
          `0x${"1".repeat(40)}`,
          `svc_${"a".repeat(32)}`,
          `task-${index}`,
          objectiveId,
          `eip155:5042002:0x${"1".repeat(40)}:1`,
          index,
          `0x${String(index + 1).padStart(64, "0")}`,
          `pay_${digit.repeat(26)}`,
          `dedup_${digit.repeat(26)}`,
          new Date("2026-11-05T00:00:00Z"),
        ],
      );
    }
    const first = await app.request("/v1/social/incidents?limit=2");
    const firstBody = (await first.json()) as {
      items: { incidentId: string; openedAt: string }[];
      nextCursor: string;
    };
    expect(
      validateRecordedExchange("listSocialIncidents", {
        responseStatus: 200,
        responseBody: firstBody,
      }).valid,
    ).toBe(true);
    expect(firstBody.items.map((item) => item.openedAt)).toEqual([
      "2026-11-05T00:00:00Z",
      "2026-11-05T00:00:00Z",
    ]);
    const second = await app.request(`/v1/social/incidents?limit=2&cursor=${firstBody.nextCursor}`);
    const secondBody = (await second.json()) as { items: { incidentId: string }[] };
    expect(
      [...firstBody.items, ...secondBody.items].map((item) => item.incidentId).toSorted(),
    ).toEqual(incidentIds.toSorted());
    const detail = await app.request(`/v1/social/threads/thr_${"A".repeat(26)}`);
    const detailBody = await detail.json();
    expect(
      validateRecordedExchange("getSocialThread", {
        responseStatus: 200,
        responseBody: detailBody,
      }).valid,
    ).toBe(true);
    const representative = await pool.query<{ representative_id: string }>(
      "SELECT representative_id FROM social_representatives WHERE user_id=$1",
      [TEST_USER_ID],
    );
    const representativeId = representative.rows[0]!.representative_id;
    const event = await pool.query<{ event_id: string }>(
      "INSERT INTO outbox_events(name,payload) VALUES('social.test','{}') RETURNING event_id",
    );
    const inbox = await pool.query<{ inbox_id: string }>(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'post-routed','{}') RETURNING inbox_id`,
      [representativeId, event.rows[0]!.event_id],
    );
    await pool.query(
      `INSERT INTO social_runs(run_id,inbox_id,representative_id,sharing_version,
        policy_version,action,stop_reason,started_at,finished_at)
       VALUES($1,$2,$3,1,'soc-1','abstain','skipped-paused',$4,$4)`,
      [
        `run_${"A".repeat(26)}`,
        inbox.rows[0]!.inbox_id,
        representativeId,
        new Date("2026-11-05T09:14:00Z"),
      ],
    );
    const activity = await app.request("/v1/social/me/activity", { headers: auth });
    expect(
      validateRecordedExchange("listSocialActivity", {
        responseStatus: 200,
        responseBody: await activity.json(),
      }).valid,
    ).toBe(true);
    const source = await pool.query<{ post_id: string }>(
      "SELECT post_id FROM social_posts WHERE tombstoned_at IS NULL LIMIT 1",
    );
    await pool.query(
      `INSERT INTO social_lessons(lesson_id,user_id,network,service_id,task_class,
        proposition,strength,source_post_id,source_obs_id,expires_at)
       VALUES($1,$2,'eip155:5042002',$3,'web-search','prefer',0.3,$4,'obs_new',now()+interval '1 day')`,
      [`les_${"A".repeat(26)}`, TEST_USER_ID, `svc_${"a".repeat(32)}`, source.rows[0]!.post_id],
    );
    const lessons = await app.request("/v1/social/me/lessons", { headers: auth });
    expect(
      validateRecordedExchange("listSocialLessons", {
        responseStatus: 200,
        responseBody: await lessons.json(),
      }).valid,
    ).toBe(true);
    const dismissed = await app.request(`/v1/social/me/lessons/les_${"A".repeat(26)}`, {
      method: "DELETE",
      headers: { ...auth, "Idempotency-Key": randomUUID() },
    });
    expect(dismissed.status).toBe(204);
    expect(validateRecordedExchange("dismissSocialLesson", { responseStatus: 204 }).valid).toBe(
      true,
    );
  });

  it("rejects unsafe lead origins and a different owner's deletion", async () => {
    const pool = getPool();
    const { app } = createTestContext(pool);
    const badBody = {
      network: "eip155:5042002",
      origin: "http://127.0.0.1:9123",
      capabilityTag: "web-search",
    };
    const rejected = await app.request("/v1/social/leads", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify(badBody),
    });
    expect(rejected.status).toBe(400);
    expect(
      apiContracts.get("suggestSocialLead")?.responses.get("4XX")?.(await rejected.json()),
    ).toBe(true);
    for (const pathHint of [`/obs_${"a".repeat(32)}`, "/private/report.json"]) {
      const response = await app.request("/v1/social/leads", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          network: "eip155:5042002",
          origin: "https://safe.example",
          capabilityTag: "web-search",
          pathHint,
        }),
      });
      expect(response.status).toBe(400);
    }
    for (const origin of [`https://0x${"a".repeat(40)}.example`, "https://private-report.json"]) {
      const response = await app.request("/v1/social/leads", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ network: "eip155:5042002", origin, capabilityTag: "web-search" }),
      });
      expect(response.status).toBe(400);
    }
    const otherUser = `usr_${"B".repeat(26)}`;
    const otherToken = Buffer.alloc(32, 29).toString("base64url");
    await pool.query("INSERT INTO users(user_id) VALUES($1)", [otherUser]);
    await pool.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [createHash("sha256").update(otherToken).digest(), otherUser],
    );
    const post = await pool.query<{ post_id: string }>(
      "SELECT post_id FROM social_posts WHERE tombstoned_at IS NULL LIMIT 1",
    );
    const denied = await app.request(`/v1/social/posts/${post.rows[0]!.post_id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${otherToken}`,
        "Idempotency-Key": randomUUID(),
      },
    });
    expect(denied.status).toBe(403);
    expect(apiContracts.get("deleteSocialPost")?.responses.get("4XX")?.(await denied.json())).toBe(
      true,
    );
    const untouched = await pool.query("SELECT tombstoned_at FROM social_posts WHERE post_id=$1", [
      post.rows[0]!.post_id,
    ]);
    expect(untouched.rows[0]?.tombstoned_at).toBeNull();
  });
});
