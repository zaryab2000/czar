import { describe, expect, it } from "vitest";
import { routeSocialEvent } from "#src/social/router";
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
});
