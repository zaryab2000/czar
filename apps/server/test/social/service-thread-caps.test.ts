import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { runSocialInbox } from "#src/social/runtime/run";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission } from "#test/fixtures";

const pool = setupDatabase();
const network = "eip155:5042002";
const serviceId = `svc_${"a".repeat(32)}`;
const versionId = `ver_${"b".repeat(32)}`;
const threadId = `thr_${"A".repeat(26)}`;
const now = new Date("2026-11-05T12:00:00Z");

function owner(letter: string, digit: string) {
  return {
    userId: `usr_${letter.repeat(26)}`,
    deviceId: `dev_${letter.repeat(26)}`,
    representativeId: `rep_${letter.repeat(26)}`,
    objectiveId: `obj_${letter.repeat(26)}`,
    planId: `pln_${letter.repeat(26)}`,
    vault: `0x${digit.repeat(40)}`,
    obsId: `obs_${digit.repeat(32)}`,
  };
}

async function seedOwner(letter: string, digit: string): Promise<void> {
  const value = owner(letter, digit);
  await pool().query("INSERT INTO users(user_id,vault) VALUES($1,$2)", [value.userId, value.vault]);
  await pool().query(
    `INSERT INTO devices(device_id,user_id,device_name,platform,token_hash)
     VALUES($1,$2,'Test','linux',$3)`,
    [value.deviceId, value.userId, Buffer.alloc(32, Number(digit))],
  );
  await pool().query(
    `INSERT INTO social_representatives(representative_id,user_id,handle,sharing)
     VALUES($1,$2,$3,'structured')`,
    [value.representativeId, value.userId, `Rep-${letter.repeat(4)}`],
  );
}

async function queuePaidExperience(letter: string, digit: string): Promise<void> {
  const value = owner(letter, digit);
  const submission = makeObjectiveSubmission(value.objectiveId, { deviceId: value.deviceId });
  await pool().query(
    `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state,
       plan_id,envelope_ref)
     VALUES($1,$2,$3,$4,$5,'delivered',$6,$7)`,
    [
      value.objectiveId,
      value.userId,
      value.deviceId,
      submission,
      submission.objectiveHash,
      value.planId,
      `${network}:${value.vault}:1`,
    ],
  );
  await pool().query(
    `INSERT INTO plans(plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES($1,$2,'{}',$3,$3,'approved')`,
    [value.planId, value.objectiveId, `0x${digit.repeat(64)}`],
  );
  await pool().query(`INSERT INTO steps(plan_id,step_index,step,state) VALUES($1,0,$2,'done')`, [
    value.planId,
    { capability: "web-search", kind: "api-call", serviceId, unitAmount: "100000" },
  ]);
  await pool().query(
    `INSERT INTO observations(obs_id,user_id,vault,network,rail,service_id,version_id,
       task_class,objective_id,envelope_ref,step_index,call_index,payment_ref_hash,
       payment_id,dedup_key,delivered,settled_at)
     VALUES($1,$2,$3,$4,'x402-exact',$5,$6,'data-json.search',$7,$8,0,0,$9,$10,$11,1,$12)`,
    [
      value.obsId,
      value.userId,
      value.vault,
      network,
      serviceId,
      versionId,
      value.objectiveId,
      `${network}:${value.vault}:1`,
      `0x${digit.repeat(64)}`,
      `paid-${letter}`,
      `dedup-${letter}`,
      now,
    ],
  );
  const event = await pool().query<{ event_id: string }>(
    `INSERT INTO outbox_events(name,objective_id,payload)
     VALUES('objective.delivered',$1,'{}') RETURNING event_id`,
    [value.objectiveId],
  );
  await pool().query(
    `INSERT INTO social_inbox(representative_id,event_id,kind,refs,due_at,created_at)
     VALUES($1,$2,'outcome-ready',$3,$4,$4)`,
    [
      value.representativeId,
      event.rows[0]!.event_id,
      { objectiveId: value.objectiveId },
      new Date(now.getTime() - 1),
    ],
  );
}

async function fillerPosts(count: number, author: string, start: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await pool().query(
      `INSERT INTO social_posts(post_id,thread_id,author_id,kind,card,action_id)
       VALUES($1,$2,$3,'experience','{}',$4)`,
      [
        `pst_${String(index + start).padStart(26, "0")}`,
        threadId,
        author,
        `fixture-post-${index + start}`,
      ],
    );
  }
  await pool().query(
    "UPDATE social_threads SET contributions=contributions+$2 WHERE thread_id=$1",
    [threadId, count],
  );
}

describe("service thread contribution caps", () => {
  beforeAll(async () => {
    for (const [letter, digit] of [
      ["A", "1"],
      ["B", "2"],
      ["C", "3"],
      ["D", "4"],
    ]) {
      await seedOwner(letter!, digit!);
    }
    await pool().query(
      `INSERT INTO social_threads(thread_id,kind,network,service_id,task_class,
         capability_tag,subject_key,opened_by)
       VALUES($1,'service',$2,$3,'data-json.search','web-search',$4,$5)`,
      [
        threadId,
        network,
        serviceId,
        `service:${network}:${serviceId}`,
        owner("D", "4").representativeId,
      ],
    );
  });

  it("accepts the ninth, tenth, and fiftieth experience from different owners", async () => {
    await fillerPosts(8, owner("D", "4").representativeId, 1);
    for (const [letter, digit, expected] of [
      ["A", "1", 9],
      ["B", "2", 10],
    ] as const) {
      await queuePaidExperience(letter, digit);
      expect(
        (await runSocialInbox(pool(), loadConfig(), { bytes: randomBytes }, now))?.action,
      ).toBe("publish-experience");
      const state = await pool().query<{ contributions: number; state: string }>(
        "SELECT contributions,state FROM social_threads WHERE thread_id=$1",
        [threadId],
      );
      expect(state.rows[0]).toEqual({ contributions: expected, state: "open" });
    }
    await fillerPosts(37, owner("D", "4").representativeId, 100);
    await fillerPosts(2, owner("C", "3").representativeId, 200);
    await queuePaidExperience("C", "3");
    expect((await runSocialInbox(pool(), loadConfig(), { bytes: randomBytes }, now))?.action).toBe(
      "publish-experience",
    );
    const state = await pool().query<{ contributions: number; state: string }>(
      "SELECT contributions,state FROM social_threads WHERE thread_id=$1",
      [threadId],
    );
    expect(state.rows[0]).toEqual({ contributions: 50, state: "open" });
    const third = await pool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM social_posts
       WHERE thread_id=$1 AND author_id=$2 AND kind='experience'`,
      [threadId, owner("C", "3").representativeId],
    );
    expect(third.rows[0]?.count).toBe("3");
  });
});
