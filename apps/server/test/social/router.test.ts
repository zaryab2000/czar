import { describe, expect, it } from "vitest";
import { expireQuestions, routeSocialEvent } from "#src/social/router";
import { setupDatabase } from "#test/db";
import { seedDevice, TEST_USER_ID } from "#test/fixtures";

const pool = setupDatabase();
const repA = `rep_${"A".repeat(26)}`;
const repB = `rep_${"B".repeat(26)}`;
const threadId = `thr_${"A".repeat(26)}`;
const postId = `pst_${"A".repeat(26)}`;

describe("social event routing", () => {
  it("routes a published question once to a subscribed separate representative", async () => {
    await seedDevice(pool());
    await pool().query("INSERT INTO users(user_id,created_at) VALUES($1,now())", [
      `usr_${"B".repeat(26)}`,
    ]);
    await pool().query(
      `INSERT INTO social_representatives(representative_id,user_id,handle,sharing)
       VALUES($1,$2,'Rep-AAAA','structured'),($3,$4,'Rep-BBBB','structured')`,
      [repA, TEST_USER_ID, repB, `usr_${"B".repeat(26)}`],
    );
    await pool().query(
      `INSERT INTO social_threads(thread_id,kind,network,subject_key,task_class,capability_tag,
         opened_by,expires_at) VALUES($1,'question','eip155:5042002',$2,'data-json.search',
         'web-search',$3,now()+interval '1 day')`,
      [threadId, `question:${threadId}`, repA],
    );
    await pool().query(
      `INSERT INTO social_posts(post_id,thread_id,author_id,kind,action_id,card)
       VALUES($1,$2,$3,'question','action-a',$4)`,
      [postId, threadId, repA, { questionKind: "find-supplier", cardVersion: "1" }],
    );
    await pool().query(
      `INSERT INTO social_subscriptions(representative_id,subject_key,source,expires_at)
       VALUES($1,$2,'objective',now()+interval '90 days')`,
      [repB, "class:eip155:5042002:data-json.search"],
    );
    const event = await pool().query<{ event_id: string }>(
      "INSERT INTO outbox_events(name,payload,delivered_at) VALUES('social.post.published',$1,now()) RETURNING event_id",
      [{ postId, threadId }],
    );
    await routeSocialEvent(
      pool(),
      "social.post.published",
      { postId, threadId },
      event.rows[0]!.event_id,
      3,
      20,
      60,
    );
    const routed = await pool().query<{
      representative_id: string;
      refs: { routingReason: string };
    }>("SELECT representative_id,refs FROM social_inbox WHERE event_id=$1", [
      event.rows[0]!.event_id,
    ]);
    expect(routed.rows).toEqual([
      {
        representative_id: repB,
        refs: expect.objectContaining({ routingReason: "subscribed-tag" }),
      },
    ]);
  });

  it("routes at most three question recipients and excludes sharing-off subscribers", async () => {
    for (const suffix of ["C", "D", "E", "F", "G", "H", "J", "K", "M", "N", "P"]) {
      const userId = `usr_${suffix.repeat(26)}`;
      const representativeId = `rep_${suffix.repeat(26)}`;
      await pool().query("INSERT INTO users(user_id) VALUES($1)", [userId]);
      await pool().query(
        `INSERT INTO social_representatives(representative_id,user_id,handle,sharing)
         VALUES($1,$2,$3,$4)`,
        [
          representativeId,
          userId,
          `Rep-${suffix.repeat(4)}`,
          suffix === "P" ? "off" : "structured",
        ],
      );
      await pool().query(
        `INSERT INTO social_subscriptions(representative_id,subject_key,source,expires_at)
         VALUES($1,$2,'objective',now()+interval '90 days')`,
        [representativeId, "class:eip155:5042002:data-json.search"],
      );
    }
    const event = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,payload,delivered_at)
       VALUES('social.post.published',$1,now()) RETURNING event_id`,
      [{ postId, threadId }],
    );
    await routeSocialEvent(
      pool(),
      "social.post.published",
      { postId, threadId },
      event.rows[0]!.event_id,
      3,
      20,
      60,
    );
    const recipients = await pool().query<{
      representative_id: string;
      refs: { routingReason: string };
    }>("SELECT representative_id,refs FROM social_inbox WHERE event_id=$1", [
      event.rows[0]!.event_id,
    ]);
    expect(recipients.rows).toHaveLength(3);
    expect(recipients.rows.every((row) => row.representative_id !== `rep_${"P".repeat(26)}`)).toBe(
      true,
    );
    expect(recipients.rows.every((row) => row.refs.routingReason === "subscribed-tag")).toBe(true);
  });

  it("routes an experience by its own task class, not the shared service thread's", async () => {
    const serviceThread = `thr_${"S".repeat(26)}`;
    const experienceId = `pst_${"S".repeat(26)}`;
    const classBUser = `usr_${"Q".repeat(26)}`;
    const classBRep = `rep_${"Q".repeat(26)}`;
    const serviceId = `svc_${"c".repeat(32)}`;
    await pool().query("INSERT INTO users(user_id) VALUES($1)", [classBUser]);
    await pool().query(
      `INSERT INTO social_representatives(representative_id,user_id,handle,sharing)
       VALUES($1,$2,'Rep-QQQQ','structured')`,
      [classBRep, classBUser],
    );
    await pool().query(
      `INSERT INTO social_threads(thread_id,kind,network,service_id,task_class,subject_key)
       VALUES($1,'service','eip155:5042002',$2,'class-a.search',$3)`,
      [serviceThread, serviceId, `service:eip155:5042002:${serviceId}`],
    );
    await pool().query(
      `INSERT INTO social_posts(post_id,thread_id,author_id,kind,action_id,card)
       VALUES($1,$2,$3,'experience','cross-class-route',$4)`,
      [
        experienceId,
        serviceThread,
        repA,
        {
          cardVersion: "1",
          network: "eip155:5042002",
          serviceId,
          taskClass: "class-b.search",
          rating: "bad",
          deliveryOutcome: "not-delivered",
        },
      ],
    );
    await pool().query(
      `INSERT INTO social_subscriptions(representative_id,subject_key,source,expires_at)
       VALUES($1,$2,'objective',now()+interval '90 days')`,
      [classBRep, "class:eip155:5042002:class-b.search"],
    );
    const event = await pool().query<{ event_id: string }>(
      `INSERT INTO outbox_events(name,payload,delivered_at)
       VALUES('social.post.published',$1,now()) RETURNING event_id`,
      [{ postId: experienceId, threadId: serviceThread }],
    );
    await routeSocialEvent(
      pool(),
      "social.post.published",
      { postId: experienceId, threadId: serviceThread },
      event.rows[0]!.event_id,
      3,
      20,
      60,
    );
    const routed = await pool().query<{ representative_id: string }>(
      "SELECT representative_id FROM social_inbox WHERE event_id=$1",
      [event.rows[0]!.event_id],
    );
    expect(routed.rows.map((row) => row.representative_id)).toContain(classBRep);
  });

  it("rolls back question expiry when event insertion fails", async () => {
    await pool().query(
      "UPDATE social_threads SET expires_at=now()-interval '1 hour' WHERE thread_id=$1",
      [threadId],
    );
    await pool().query(
      `CREATE FUNCTION reject_expiry_event() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN IF NEW.name='social.question.expired' THEN
           RAISE EXCEPTION 'injected expiry insert failure';
         END IF; RETURN NEW; END $$`,
    );
    await pool().query(
      `CREATE TRIGGER reject_expiry_event BEFORE INSERT ON outbox_events
       FOR EACH ROW EXECUTE FUNCTION reject_expiry_event()`,
    );
    const db = await pool().connect();
    try {
      await db.query("BEGIN");
      await expect(expireQuestions(db, new Date())).rejects.toThrow(
        "injected expiry insert failure",
      );
      await db.query("ROLLBACK");
      const state = await pool().query<{ state: string }>(
        "SELECT state FROM social_threads WHERE thread_id=$1",
        [threadId],
      );
      expect(state.rows[0]?.state).toBe("open");
    } finally {
      await db.query("ROLLBACK");
      db.release();
      await pool().query("DROP TRIGGER reject_expiry_event ON outbox_events");
      await pool().query("DROP FUNCTION reject_expiry_event()");
    }
  });
});
