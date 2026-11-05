import { createHash, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { randomId } from "#src/http/ids";
import { createLesson } from "#src/social/lessons";
import { runSocialInbox } from "#src/social/runtime/run";
import { setupDatabase } from "#test/db";
import {
  createTestContext,
  makeObjectiveSubmission,
  seedDevice,
  TEST_USER_ID,
} from "#test/fixtures";

const pool = setupDatabase();
const objectiveId = `obj_${"A".repeat(26)}`;
const representativeId = `rep_${"A".repeat(26)}`;
const paidObjectiveId = `obj_${"B".repeat(26)}`;
const planId = `pln_${"B".repeat(26)}`;
const serviceId = `svc_${"a".repeat(32)}`;
const versionId = `ver_${"b".repeat(32)}`;

describe("representative run", () => {
  let modelUsageAtStart: string;

  beforeAll(async () => {
    await seedDevice(pool());
    const submission = makeObjectiveSubmission(objectiveId);
    await pool().query(
      `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
       VALUES($1,$2,$3,$4,$5,'no-supplier')`,
      [objectiveId, TEST_USER_ID, submission.deviceId, submission, submission.objectiveHash],
    );
    await pool().query(
      `INSERT INTO social_representatives(representative_id,user_id,handle,sharing)
       VALUES($1,$2,'Rep-AAAA','structured')`,
      [representativeId, TEST_USER_ID],
    );
    const usage = await pool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM model_usage",
    );
    modelUsageAtStart = usage.rows[0]!.count;
  });

  it("publishes a public question for no-supplier and closes the inbox atomically", async () => {
    const event = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,objective_id,payload)
       VALUES('objective.no-supplier',$1,'{}') RETURNING event_id`,
      [objectiveId],
    );
    await pool().query(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'need-unmet',$3)`,
      [representativeId, event.rows[0]!.event_id, { objectiveId }],
    );
    const modelUsageBefore = await pool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM model_usage",
    );
    const context = createTestContext(pool());
    const result = await runSocialInbox(
      pool(),
      loadConfig(),
      context.random,
      new Date("2026-11-05T12:00:00Z"),
    );
    expect(result?.stopReason).toBe("done");
    const posts = await pool().query<{ kind: string; note: null; card: object }>(
      "SELECT kind,note,card FROM social_posts",
    );
    expect(posts.rows).toEqual([
      {
        kind: "question",
        note: null,
        card: expect.objectContaining({ questionKind: "find-supplier" }),
      },
    ]);
    const modelUsageAfter = await pool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM model_usage",
    );
    expect(modelUsageAfter.rows[0]?.count).toBe(modelUsageBefore.rows[0]?.count);
    const inbox = await pool().query<{ state: string }>("SELECT state FROM social_inbox");
    expect(inbox.rows[0]?.state).toBe("done");
    const socialEvent = await pool().query<{ delivered_at: Date | null }>(
      "SELECT delivered_at FROM outbox_events WHERE name='social.post.published'",
    );
    expect(socialEvent.rows[0]?.delivered_at).not.toBeNull();
  });

  it("creates one post when two workers race to claim the same inbox row", async () => {
    const id = `obj_${"J".repeat(26)}`;
    const body = makeObjectiveSubmission(id);
    await pool().query(
      `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
       VALUES($1,$2,$3,$4,$5,'no-supplier')`,
      [id, TEST_USER_ID, body.deviceId, body, body.objectiveHash],
    );
    const event = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,objective_id,payload)
       VALUES('objective.no-supplier',$1,'{}') RETURNING event_id`,
      [id],
    );
    const inbox = await pool().query<{ inbox_id: string }>(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'need-unmet',$3) RETURNING inbox_id`,
      [representativeId, event.rows[0]!.event_id, { objectiveId: id }],
    );
    const before = await pool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM social_posts WHERE kind='question'",
    );
    const now = new Date("2026-11-05T12:00:00Z");
    const random = { bytes: randomBytes };
    const results = await Promise.all([
      runSocialInbox(pool(), loadConfig(), random, now),
      runSocialInbox(pool(), loadConfig(), random, now),
    ]);
    expect(results.map((result) => result?.stopReason).toSorted()).toEqual(["done", undefined]);
    const after = await pool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM social_posts WHERE kind='question'",
    );
    expect(Number(after.rows[0]?.count)).toBe(Number(before.rows[0]?.count) + 1);
    const runs = await pool().query("SELECT 1 FROM social_runs WHERE inbox_id=$1", [
      inbox.rows[0]!.inbox_id,
    ]);
    expect(runs.rowCount).toBe(1);
  });

  it("revises a paid-step experience after a rating without routing it again", async () => {
    const submission = makeObjectiveSubmission(paidObjectiveId);
    await pool().query(
      `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
       VALUES($1,$2,$3,$4,$5,'delivered')`,
      [paidObjectiveId, TEST_USER_ID, submission.deviceId, submission, submission.objectiveHash],
    );
    await pool().query(
      `INSERT INTO plans(plan_id,objective_id,plan,plan_hash,payee_root,state)
       VALUES($1,$2,'{}',$3,$3,'approved')`,
      [planId, paidObjectiveId, `0x${"1".repeat(64)}`],
    );
    await pool().query("UPDATE objectives SET plan_id=$2 WHERE objective_id=$1", [
      paidObjectiveId,
      planId,
    ]);
    await pool().query(
      `INSERT INTO steps(plan_id,step_index,step,state)
       VALUES($1,0,$2,'done')`,
      [planId, { capability: "web-search", kind: "api-call", serviceId, unitAmount: "15000" }],
    );
    const vault = `0x${"0".repeat(40)}`;
    const obsId = `obs_${"a".repeat(32)}`;
    await pool().query(
      `INSERT INTO observations(obs_id,user_id,vault,network,rail,service_id,version_id,
         task_class,objective_id,envelope_ref,step_index,call_index,payment_ref_hash,payment_id,
         dedup_key,delivered,settled_at)
       VALUES($1,$2,$3,'eip155:5042002','x402-exact',$4,$5,'data-json.search',$6,$7,
         0,0,$8,'pay-1','dedup-1',1,$9)`,
      [
        obsId,
        TEST_USER_ID,
        vault,
        serviceId,
        versionId,
        paidObjectiveId,
        `eip155:5042002:${vault}:1`,
        `0x${"2".repeat(64)}`,
        new Date("2026-11-05T10:00:00Z"),
      ],
    );
    const ready = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,objective_id,payload)
       VALUES('objective.delivered',$1,'{}') RETURNING event_id`,
      [paidObjectiveId],
    );
    await pool().query(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'outcome-ready',$3)`,
      [representativeId, ready.rows[0]!.event_id, { objectiveId: paidObjectiveId }],
    );
    const context = createTestContext(pool());
    const now = new Date("2026-11-05T12:00:00Z");
    expect((await runSocialInbox(pool(), loadConfig(), context.random, now))?.stopReason).toBe(
      "done",
    );
    const original = await pool().query<{ post_id: string }>(
      "SELECT post_id FROM social_posts WHERE kind='experience' AND author_id=$1",
      [representativeId],
    );
    const lessonId = `les_${"C".repeat(26)}`;
    const lessonOwner = `usr_${"C".repeat(26)}`;
    await pool().query("INSERT INTO users(user_id) VALUES($1)", [lessonOwner]);
    await pool().query(
      `INSERT INTO social_lessons(lesson_id,user_id,network,service_id,version_id,task_class,
         proposition,strength,source_post_id,source_obs_id,expires_at)
       VALUES($1,$2,'eip155:5042002',$3,$4,'data-json.search','avoid',0.5,$5,$6,$7)`,
      [
        lessonId,
        lessonOwner,
        serviceId,
        versionId,
        original.rows[0]!.post_id,
        obsId,
        new Date("2026-12-05T12:00:00Z"),
      ],
    );
    const ratingId = `rtg_${"A".repeat(26)}`;
    await pool().query(
      `INSERT INTO ratings(rating_id,user_id,vault,objective_id,step_index,network,service_id,
         version_id,task_class,value,surface)
       VALUES($1,$2,$3,$4,0,'eip155:5042002',$5,$6,'data-json.search','good','web')`,
      [ratingId, TEST_USER_ID, vault, paidObjectiveId, serviceId, versionId],
    );
    const updated = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,payload)
       VALUES('rating.recorded',$1) RETURNING event_id`,
      [{ ratingId, objectiveId: paidObjectiveId, stepIndex: 0 }],
    );
    await pool().query(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'outcome-updated',$3)`,
      [
        representativeId,
        updated.rows[0]!.event_id,
        { objectiveId: paidObjectiveId, ratingId, stepIndex: 0 },
      ],
    );
    expect((await runSocialInbox(pool(), loadConfig(), context.random, now))?.action).toBe(
      "revise-experience",
    );
    const posts = await pool().query<{
      post_id: string;
      superseded_by: string | null;
      card: { rating: string };
    }>(
      "SELECT post_id,superseded_by,card FROM social_posts WHERE kind='experience' ORDER BY revision",
    );
    expect(posts.rows).toHaveLength(2);
    expect(posts.rows[0]?.superseded_by).toBe(posts.rows[1]?.post_id);
    expect(posts.rows[1]?.card.rating).toBe("good");
    const link = await pool().query<{ post_id: string }>(
      "SELECT post_id FROM social_evidence_links WHERE obs_id=$1",
      [obsId],
    );
    expect(link.rows[0]?.post_id).toBe(posts.rows[1]?.post_id);
    const feed = await context.app.request("/v1/social/feed?kind=experience", undefined, {
      remoteAddr: "192.0.2.37",
    });
    expect(feed.status).toBe(200);
    const feedItems = (await feed.json()) as { items: { postId: string; revision: number }[] };
    const visibleRevisions = feedItems.items
      .filter((item) => posts.rows.some((post) => post.post_id === item.postId))
      .map(({ postId, revision }) => ({ postId, revision }));
    expect(visibleRevisions).toEqual([{ postId: posts.rows[1]!.post_id, revision: 2 }]);
    const lesson = await pool().query<{ state: string }>(
      "SELECT state FROM social_lessons WHERE lesson_id=$1",
      [lessonId],
    );
    expect(lesson.rows[0]?.state).toBe("superseded");
    const routedEvents = await pool().query(
      `SELECT 1 FROM outbox_events e WHERE e.name='social.post.published'
       AND e.payload->>'postId' IN (SELECT post_id FROM social_posts WHERE kind='experience')`,
    );
    expect(routedEvents.rowCount).toBe(1);
  });

  it("keeps posts, evidence, health facts, and plans unchanged across 100 duplicate replays", async () => {
    const snapshot = async () => {
      const result = await pool().query<{
        posts: string;
        observations: string;
        ratings: string;
        supplier_counts: string;
        supplier_health: string;
        incidents: string;
        plans: string;
        decisions: string;
      }>(`SELECT
        (SELECT count(*) FROM social_posts)::text AS posts,
        (SELECT count(*) FROM observations)::text AS observations,
        (SELECT count(*) FROM ratings)::text AS ratings,
        (SELECT count(*) FROM supplier_counts)::text AS supplier_counts,
        (SELECT count(*) FROM supplier_health)::text AS supplier_health,
        (SELECT count(*) FROM social_incidents)::text AS incidents,
        (SELECT count(*) FROM plans)::text AS plans,
        (SELECT count(*) FROM ranking_decisions)::text AS decisions`);
      return result.rows[0];
    };
    const before = await snapshot();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const event = await pool().query<{ event_id: string }>(
        `INSERT INTO outbox_events(name,objective_id,payload)
         VALUES('objective.delivered',$1,'{}') RETURNING event_id`,
        [paidObjectiveId],
      );
      await pool().query(
        `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
         VALUES($1,$2,'outcome-ready',$3)`,
        [representativeId, event.rows[0]!.event_id, { objectiveId: paidObjectiveId }],
      );
      const replay = await runSocialInbox(
        pool(),
        loadConfig(),
        { bytes: randomBytes },
        new Date("2026-11-05T12:00:00Z"),
      );
      expect(replay?.stopReason, `duplicate attempt ${attempt + 1}`).toBe("abstain-no-evidence");
    }
    const posts = await pool().query<{ count: string }>(
      `SELECT count(*) FROM social_posts WHERE kind='experience'
       AND author_id=$1 AND superseded_by IS NULL`,
      [representativeId],
    );
    expect(posts.rows[0]?.count).toBe("1");
    expect(await snapshot()).toEqual(before);
  });

  it("answers a routed question only with its own settled evidence", async () => {
    const otherUser = `usr_${"B".repeat(26)}`;
    const otherRep = `rep_${"B".repeat(26)}`;
    const threadId = `thr_${"B".repeat(26)}`;
    const questionId = `pst_${"B".repeat(26)}`;
    await pool().query("INSERT INTO users(user_id) VALUES($1)", [otherUser]);
    await pool().query(
      `INSERT INTO social_representatives(representative_id,user_id,handle,sharing)
       VALUES($1,$2,'Rep-BBBB','structured')`,
      [otherRep, otherUser],
    );
    await pool().query(
      `INSERT INTO social_threads(thread_id,kind,network,task_class,capability_tag,
         subject_key,opened_by,contributions,expires_at)
       VALUES($1,'question','eip155:5042002','data-json.search','web-search',
         $2,$3,1,now()+interval '1 day')`,
      [threadId, `question:${threadId}`, otherRep],
    );
    await pool().query(
      `INSERT INTO social_posts(post_id,thread_id,author_id,kind,card,action_id)
       VALUES($1,$2,$3,'question',$4,'other-question')`,
      [
        questionId,
        threadId,
        otherRep,
        {
          cardVersion: "1",
          network: "eip155:5042002",
          taskClass: "data-json.search",
          capabilityTag: "web-search",
          questionKind: "find-supplier",
          asOf: "2026-11-05T00:00:00Z",
        },
      ],
    );
    await pool().query("UPDATE social_threads SET contributions=7 WHERE thread_id=$1", [threadId]);
    const event = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,payload,delivered_at)
       VALUES('social.post.published',$1,now()) RETURNING event_id`,
      [{ postId: questionId, threadId }],
    );
    await pool().query(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'post-routed',$3)`,
      [
        representativeId,
        event.rows[0]!.event_id,
        { postId: questionId, threadId, routingReason: "has-evidence-for-class" },
      ],
    );
    const context = createTestContext(pool());
    expect(
      (await runSocialInbox(pool(), loadConfig(), context.random, new Date("2026-11-05T12:00:00Z")))
        ?.action,
    ).toBe("publish-reply");
    const reply = await pool().query<{ stance: string; parent_post_id: string }>(
      "SELECT stance,parent_post_id FROM social_posts WHERE kind='reply'",
    );
    expect(reply.rows).toEqual([{ stance: "answers", parent_post_id: questionId }]);
    const thread = await pool().query<{ state: string; contributions: number }>(
      "SELECT state,contributions FROM social_threads WHERE thread_id=$1",
      [threadId],
    );
    expect(thread.rows[0]).toEqual({ state: "closed", contributions: 8 });
    const ownerQuestion = await pool().query<{ post_id: string; thread_id: string }>(
      "SELECT post_id,thread_id FROM social_posts WHERE kind='question' AND author_id=$1 LIMIT 1",
      [representativeId],
    );
    const ownerPostId = ownerQuestion.rows[0]!.post_id;
    const ownerThreadId = ownerQuestion.rows[0]!.thread_id;
    const noEvidenceEvent = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,payload,delivered_at)
       VALUES('social.post.published',$1,now()) RETURNING event_id`,
      [{ postId: ownerPostId, threadId: ownerThreadId }],
    );
    await pool().query(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'post-routed',$3)`,
      [
        otherRep,
        noEvidenceEvent.rows[0]!.event_id,
        { postId: ownerPostId, threadId: ownerThreadId, routingReason: "subscribed-tag" },
      ],
    );
    const postsBefore = await pool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM social_posts",
    );
    expect(
      (await runSocialInbox(pool(), loadConfig(), context.random, new Date("2026-11-05T12:00:00Z")))
        ?.stopReason,
    ).toBe("abstain-no-rule");
    const postsAfter = await pool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM social_posts",
    );
    expect(postsAfter.rows[0]?.count).toBe(postsBefore.rows[0]?.count);
    const corroborateId = `pst_${"D".repeat(26)}`;
    await pool().query(
      `INSERT INTO social_posts(post_id,thread_id,author_id,kind,card,action_id)
       VALUES($1,$2,$3,'question',$4,'no-evidence-corroborate')`,
      [
        corroborateId,
        ownerThreadId,
        representativeId,
        {
          cardVersion: "1",
          network: "eip155:5042002",
          taskClass: "data-json.search",
          capabilityTag: "web-search",
          questionKind: "corroborate-failure",
          serviceId: `svc_${"f".repeat(32)}`,
          asOf: "2026-11-05T00:00:00Z",
        },
      ],
    );
    const corroborateEvent = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,payload,delivered_at)
       VALUES('social.post.published',$1,now()) RETURNING event_id`,
      [{ postId: corroborateId, threadId: ownerThreadId }],
    );
    await pool().query(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'post-routed',$3)`,
      [
        otherRep,
        corroborateEvent.rows[0]!.event_id,
        { postId: corroborateId, threadId: ownerThreadId },
      ],
    );
    expect(
      (await runSocialInbox(pool(), loadConfig(), context.random, new Date("2026-11-05T12:00:00Z")))
        ?.stopReason,
    ).toBe("abstain-no-evidence");
  });

  it("finds older eligible evidence beyond twenty newer ineligible steps", async () => {
    const vault = `0x${"0".repeat(40)}`;
    const random = { bytes: randomBytes };
    for (let index = 0; index < 21; index += 1) {
      const id = randomId("obj_", random);
      const body = makeObjectiveSubmission(id);
      await pool().query(
        `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
         VALUES($1,$2,$3,$4,$5,'delivered')`,
        [id, TEST_USER_ID, body.deviceId, body, body.objectiveHash],
      );
      await pool().query(
        `INSERT INTO observations(obs_id,user_id,vault,network,rail,service_id,version_id,
           task_class,objective_id,envelope_ref,step_index,call_index,payment_ref_hash,
           payment_id,dedup_key,delivered,settled_at)
         VALUES($1,$2,$3,'eip155:5042002','x402-exact',$4,$5,'data-json.search',$6,$7,
           0,0,$8,$9,$10,1,$11)`,
        [
          `obs_${randomBytes(16).toString("hex")}`,
          TEST_USER_ID,
          vault,
          serviceId,
          versionId,
          id,
          `eip155:5042002:${vault}:${index + 200}`,
          `0x${"2".repeat(64)}`,
          `pay-extra-${index}`,
          `dedup-extra-${index}`,
          new Date(`2026-11-05T11:${String(index).padStart(2, "0")}:00Z`),
        ],
      );
    }
    const threadId = `thr_${"C".repeat(26)}`;
    const questionId = `pst_${"C".repeat(26)}`;
    const otherRep = `rep_${"B".repeat(26)}`;
    await pool().query(
      `INSERT INTO social_threads(thread_id,kind,network,task_class,capability_tag,
         subject_key,opened_by,contributions,expires_at)
       VALUES($1,'question','eip155:5042002','data-json.search','web-search',
         $2,$3,1,now()+interval '1 day')`,
      [threadId, `question:${threadId}`, otherRep],
    );
    await pool().query(
      `INSERT INTO social_posts(post_id,thread_id,author_id,kind,card,action_id)
       VALUES($1,$2,$3,'question',$4,$5)`,
      [
        questionId,
        threadId,
        otherRep,
        {
          cardVersion: "1",
          network: "eip155:5042002",
          taskClass: "data-json.search",
          capabilityTag: "web-search",
          questionKind: "find-supplier",
          asOf: "2026-11-05T00:00:00Z",
        },
        "older-evidence-question",
      ],
    );
    const event = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,payload,delivered_at)
       VALUES('social.post.published',$1,now()) RETURNING event_id`,
      [{ postId: questionId, threadId }],
    );
    await pool().query(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'post-routed',$3)`,
      [
        representativeId,
        event.rows[0]!.event_id,
        {
          postId: questionId,
          threadId,
          routingReason: "has-evidence-for-class",
        },
      ],
    );
    expect(
      (await runSocialInbox(pool(), loadConfig(), random, new Date("2026-11-05T12:00:00Z")))
        ?.action,
    ).toBe("publish-reply");
  });

  it("rolls back before commit and keeps one post after a commit crash", async () => {
    const crashObjective = `obj_${"C".repeat(26)}`;
    const submission = makeObjectiveSubmission(crashObjective);
    await pool().query(
      `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
       VALUES($1,$2,$3,$4,$5,'no-supplier')`,
      [crashObjective, TEST_USER_ID, submission.deviceId, submission, submission.objectiveHash],
    );
    const event = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,objective_id,payload)
       VALUES('objective.no-supplier',$1,'{}') RETURNING event_id`,
      [crashObjective],
    );
    const inbox = await pool().query<{ inbox_id: string }>(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'need-unmet',$3) RETURNING inbox_id`,
      [representativeId, event.rows[0]!.event_id, { objectiveId: crashObjective }],
    );
    const inboxId = inbox.rows[0]!.inbox_id;
    const expectedActionId = createHash("sha256")
      .update([representativeId, event.rows[0]!.event_id, "publish-question", "", ""].join("\0"))
      .digest("hex");
    const context = createTestContext(pool());
    const now = new Date("2026-11-05T12:00:00Z");
    expect(
      (
        await runSocialInbox(pool(), loadConfig(), context.random, now, {
          afterPostInsert: async () => {
            throw new Error("injected after insert");
          },
        })
      )?.stopReason,
    ).toBe("retry-transient");
    const rolledBack = await pool().query("SELECT 1 FROM social_posts WHERE action_id=$1", [
      expectedActionId,
    ]);
    expect(rolledBack.rowCount).toBe(0);
    await pool().query("UPDATE social_inbox SET due_at=$2 WHERE inbox_id=$1", [
      inboxId,
      new Date(now.getTime() - 1),
    ]);
    expect(
      (
        await runSocialInbox(pool(), loadConfig(), context.random, now, {
          afterCommit: async () => {
            throw new Error("injected worker crash after commit");
          },
        })
      )?.stopReason,
    ).toBe("retry-transient");
    const published = await pool().query("SELECT 1 FROM social_posts WHERE action_id=$1", [
      expectedActionId,
    ]);
    expect(published.rowCount).toBe(1);
    const postCount = await pool().query<{ count: string }>(
      `SELECT count(*) FROM social_posts p JOIN social_runs r ON r.post_id=p.post_id
       WHERE r.inbox_id=$1`,
      [inboxId],
    );
    expect(postCount.rows[0]?.count).toBe("1");
    const runCount = await pool().query<{ count: string }>(
      "SELECT count(*) FROM social_runs WHERE inbox_id=$1",
      [inboxId],
    );
    expect(runCount.rows[0]?.count).toBe("1");
    expect(await runSocialInbox(pool(), loadConfig(), context.random, now)).toBeNull();
    const afterCommitReplay = await pool().query<{ posts: string; runs: string }>(
      `SELECT (SELECT count(*) FROM social_posts WHERE action_id=$1)::text AS posts,
         (SELECT count(*) FROM social_runs WHERE inbox_id=$2)::text AS runs`,
      [expectedActionId, inboxId],
    );
    expect(afterCommitReplay.rows[0]).toEqual({ posts: "1", runs: "1" });
  });

  it("rejects publication when consent changes after context load", async () => {
    const changedObjective = `obj_${"D".repeat(26)}`;
    const submission = makeObjectiveSubmission(changedObjective);
    await pool().query(
      `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
       VALUES($1,$2,$3,$4,$5,'no-supplier')`,
      [changedObjective, TEST_USER_ID, submission.deviceId, submission, submission.objectiveHash],
    );
    const event = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,objective_id,payload)
       VALUES('objective.no-supplier',$1,'{}') RETURNING event_id`,
      [changedObjective],
    );
    const inbox = await pool().query<{ inbox_id: string }>(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'need-unmet',$3) RETURNING inbox_id`,
      [representativeId, event.rows[0]!.event_id, { objectiveId: changedObjective }],
    );
    const context = createTestContext(pool());
    const result = await runSocialInbox(
      pool(),
      loadConfig(),
      context.random,
      new Date("2026-11-05T12:00:00Z"),
      {
        beforeCommit: async () => {
          await pool().query(
            `UPDATE social_representatives SET sharing='off',
               sharing_version=sharing_version+1 WHERE representative_id=$1`,
            [representativeId],
          );
        },
      },
    );
    expect(result?.stopReason).toBe("rejected-consent-changed");
    const run = await pool().query<{ post_id: string | null }>(
      "SELECT post_id FROM social_runs WHERE inbox_id=$1",
      [inbox.rows[0]!.inbox_id],
    );
    expect(run.rows).toEqual([{ post_id: null }]);
  });

  it("records skipped-paused for a representative paused before the run", async () => {
    const id = `obj_${"G".repeat(26)}`;
    const body = makeObjectiveSubmission(id);
    await pool().query(
      `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
       VALUES($1,$2,$3,$4,$5,'no-supplier')`,
      [id, TEST_USER_ID, body.deviceId, body, body.objectiveHash],
    );
    const event = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,objective_id,payload)
       VALUES('objective.no-supplier',$1,'{}') RETURNING event_id`,
      [id],
    );
    await pool().query(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'need-unmet',$3)`,
      [representativeId, event.rows[0]!.event_id, { objectiveId: id }],
    );
    await pool().query("UPDATE social_representatives SET paused=true WHERE representative_id=$1", [
      representativeId,
    ]);
    const result = await runSocialInbox(
      pool(),
      loadConfig(),
      createTestContext(pool()).random,
      new Date("2026-11-05T12:00:00Z"),
    );
    expect(result?.stopReason).toBe("skipped-paused");
  });

  it("does not create a lesson from a routed post for an initially paused recipient", async () => {
    const recipient = `usr_${"B".repeat(26)}`;
    const recipientRep = `rep_${"B".repeat(26)}`;
    const deviceId = `dev_${"B".repeat(26)}`;
    const activeObjective = `obj_${"H".repeat(26)}`;
    await pool().query(
      `INSERT INTO devices(device_id,user_id,device_name,platform,token_hash)
       VALUES($1,$2,'Test','linux',$3)`,
      [deviceId, recipient, Buffer.alloc(32, 3)],
    );
    const body = makeObjectiveSubmission(activeObjective, { deviceId });
    await pool().query(
      `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state,
         created_at)
       VALUES($1,$2,$3,$4,$5,'planning',$6)`,
      [
        activeObjective,
        recipient,
        deviceId,
        body,
        body.objectiveHash,
        new Date("2026-11-05T00:00:00Z"),
      ],
    );
    const post = await pool().query<{ post_id: string; thread_id: string }>(
      `SELECT p.post_id,p.thread_id FROM social_posts p
       JOIN social_evidence_links l ON l.post_id=p.post_id
       WHERE p.author_id=$1 AND p.kind='experience' AND p.superseded_by IS NULL LIMIT 1`,
      [representativeId],
    );
    const source = post.rows[0]!;
    const event = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,payload,delivered_at)
       VALUES('social.post.published',$1,now()) RETURNING event_id`,
      [{ postId: source.post_id, threadId: source.thread_id }],
    );
    await pool().query(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'post-routed',$3)`,
      [
        recipientRep,
        event.rows[0]!.event_id,
        {
          postId: source.post_id,
          threadId: source.thread_id,
          routingReason: "subscribed-service",
        },
      ],
    );
    await pool().query("UPDATE social_representatives SET paused=true WHERE representative_id=$1", [
      recipientRep,
    ]);
    let lessonAttempts = 0;
    const result = await runSocialInbox(
      pool(),
      loadConfig(),
      { bytes: randomBytes },
      new Date("2026-11-05T12:00:00Z"),
      {
        createLesson: async (...args) => {
          lessonAttempts += 1;
          return createLesson(...args);
        },
      },
    );
    expect(result?.stopReason).toBe("skipped-paused");
    expect(lessonAttempts).toBe(0);
    const lessons = await pool().query("SELECT 1 FROM social_lessons WHERE user_id=$1", [
      recipient,
    ]);
    expect(lessons.rowCount).toBe(0);
  });

  it("creates a private lesson while sharing is off without publishing", async () => {
    const recipient = `usr_${"B".repeat(26)}`;
    const recipientRep = `rep_${"B".repeat(26)}`;
    const source = await pool().query<{ post_id: string; thread_id: string }>(
      `SELECT p.post_id,p.thread_id FROM social_posts p
       JOIN social_evidence_links l ON l.post_id=p.post_id
       WHERE p.author_id=$1 AND p.kind='experience' AND p.superseded_by IS NULL LIMIT 1`,
      [representativeId],
    );
    const post = source.rows[0]!;
    const event = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,payload,delivered_at)
       VALUES('social.post.published',$1,now()) RETURNING event_id`,
      [{ postId: post.post_id, threadId: post.thread_id }],
    );
    await pool().query(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'post-routed',$3)`,
      [
        recipientRep,
        event.rows[0]!.event_id,
        {
          postId: post.post_id,
          threadId: post.thread_id,
          routingReason: "subscribed-service",
        },
      ],
    );
    await pool().query(
      "UPDATE social_representatives SET paused=false,sharing='off' WHERE representative_id=$1",
      [recipientRep],
    );
    const before = await pool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM social_posts WHERE author_id=$1",
      [recipientRep],
    );
    const result = await runSocialInbox(
      pool(),
      loadConfig(),
      { bytes: randomBytes },
      new Date("2026-11-05T12:00:00Z"),
      { createLesson },
    );
    expect(result?.action).toBe("create-lesson");
    expect(result?.stopReason).toBe("done");
    const lessons = await pool().query("SELECT 1 FROM social_lessons WHERE user_id=$1", [
      recipient,
    ]);
    expect(lessons.rowCount).toBe(1);
    const publicPosts = await pool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM social_posts WHERE author_id=$1",
      [recipientRep],
    );
    expect(publicPosts.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("allows only one first-day post when two workers run at the cap", async () => {
    const now = new Date("2026-11-06T12:00:00Z");
    await pool().query(
      "UPDATE social_representatives SET sharing='structured',paused=false WHERE representative_id=$1",
      [representativeId],
    );
    await pool().query("UPDATE social_inbox SET state='done' WHERE state IN ('queued','retry')");
    for (const suffix of ["E", "F"]) {
      const id = `obj_${suffix.repeat(26)}`;
      const body = makeObjectiveSubmission(id);
      await pool().query(
        `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
         VALUES($1,$2,$3,$4,$5,'no-supplier')`,
        [id, TEST_USER_ID, body.deviceId, body, body.objectiveHash],
      );
      const event = await pool().query<{ event_id: string }>(
        `INSERT INTO outbox_events(name,objective_id,payload)
         VALUES('objective.no-supplier',$1,'{}') RETURNING event_id`,
        [id],
      );
      await pool().query(
        `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
         VALUES($1,$2,'need-unmet',$3)`,
        [representativeId, event.rows[0]!.event_id, { objectiveId: id }],
      );
    }
    const config = loadConfig({ envFile: { "social.repDailyPostCap": 1 } });
    const random = { bytes: randomBytes };
    const [first, second] = await Promise.all([
      runSocialInbox(pool(), config, random, now),
      runSocialInbox(pool(), config, random, now),
    ]);
    const remaining = await runSocialInbox(pool(), config, random, now);
    expect([first?.stopReason, second?.stopReason, remaining?.stopReason].toSorted()).toEqual([
      "done",
      "skipped-daily-cap",
      undefined,
    ]);
    const posts = await pool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM social_posts
       WHERE author_id=$1 AND created_at::date=$2::date`,
      [representativeId, now],
    );
    expect(posts.rows[0]?.count).toBe("1");
  });

  it("skips a would-publish item when the representative turns sharing off", async () => {
    const id = `obj_${"Z".repeat(26)}`;
    const body = makeObjectiveSubmission(id);
    await pool().query(
      `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
       VALUES($1,$2,$3,$4,$5,'no-supplier')`,
      [id, TEST_USER_ID, body.deviceId, body, body.objectiveHash],
    );
    const event = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,objective_id,payload)
       VALUES('objective.no-supplier',$1,'{}') RETURNING event_id`,
      [id],
    );
    const inbox = await pool().query<{ inbox_id: string }>(
      `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
       VALUES($1,$2,'need-unmet',$3) RETURNING inbox_id`,
      [representativeId, event.rows[0]!.event_id, { objectiveId: id }],
    );
    await pool().query("UPDATE social_inbox SET state='done' WHERE inbox_id<>$1", [
      inbox.rows[0]!.inbox_id,
    ]);
    await pool().query(
      "UPDATE social_representatives SET sharing='off' WHERE representative_id=$1",
      [representativeId],
    );
    const before = await pool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM social_posts WHERE author_id=$1",
      [representativeId],
    );
    const result = await runSocialInbox(
      pool(),
      loadConfig(),
      { bytes: randomBytes },
      new Date("2026-11-07T12:00:00Z"),
    );
    expect(result).toEqual({ action: "abstain", stopReason: "skipped-sharing-off", postId: null });
    const after = await pool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM social_posts WHERE author_id=$1",
      [representativeId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    const run = await pool().query<{ stop_reason: string }>(
      "SELECT stop_reason FROM social_runs WHERE inbox_id=$1",
      [inbox.rows[0]!.inbox_id],
    );
    expect(run.rows).toEqual([{ stop_reason: "skipped-sharing-off" }]);
  });

  it("leaves model usage unchanged and every post note empty across all representative runs", async () => {
    const usage = await pool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM model_usage",
    );
    expect(usage.rows[0]?.count).toBe(modelUsageAtStart);
    const notes = await pool().query<{ total: string; with_note: string }>(
      `SELECT count(*)::text AS total,
         count(*) FILTER (WHERE note IS NOT NULL)::text AS with_note FROM social_posts`,
    );
    expect(Number(notes.rows[0]?.total)).toBeGreaterThan(0);
    expect(notes.rows[0]?.with_note).toBe("0");
  });
});
