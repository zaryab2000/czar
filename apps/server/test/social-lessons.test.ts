import { loadConfig } from "@czar/config";
import { beforeEach, describe, expect, it } from "vitest";
import { createLesson, lessonsFor } from "#src/social/lessons";
import { setupDatabase } from "#test/db";

const getPool = setupDatabase();
const NETWORK = "eip155:5042002";
const SERVICE = `svc_${"a".repeat(32)}`;
const VERSION = `ver_${"a".repeat(32)}`;
const TASK_CLASS = "data-json.search";
const AT = new Date("2026-11-05T00:00:00.000Z");
const SOURCE = `usr_${"1".repeat(26)}`;
const RECIPIENT = `usr_${"2".repeat(26)}`;
const SOURCE_REP = `rep_${"1".repeat(26)}`;
const RECIPIENT_REP = `rep_${"2".repeat(26)}`;
const POST = `pst_${"1".repeat(26)}`;
const OBS = `obs_${"1".repeat(32)}`;

async function seed(cardService = SERVICE): Promise<void> {
  for (const [user, rep] of [
    [SOURCE, SOURCE_REP],
    [RECIPIENT, RECIPIENT_REP],
  ]) {
    await getPool().query("INSERT INTO users(user_id) VALUES($1)", [user]);
    await getPool().query(
      "INSERT INTO social_representatives(representative_id,user_id,handle) VALUES($1,$2,$3)",
      [rep, user, "Rep-ABCD"],
    );
  }
  await getPool().query(
    `INSERT INTO devices(device_id,user_id,device_name,platform,token_hash)
     VALUES($1,$2,'Test','linux',$3)`,
    [`dev_${"2".repeat(26)}`, RECIPIENT, Buffer.alloc(32, 2)],
  );
  for (const [index, user, device] of [
    [1, SOURCE, `dev_${"1".repeat(26)}`],
    [2, RECIPIENT, `dev_${"2".repeat(26)}`],
  ] as const) {
    if (index === 1)
      await getPool().query(
        `INSERT INTO devices(device_id,user_id,device_name,platform,token_hash)
         VALUES($1,$2,'Test','linux',$3)`,
        [device, user, Buffer.alloc(32, 1)],
      );
    await getPool().query(
      `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state,
        created_at) VALUES($1,$2,$3,$4,$5,'planning',$6)`,
      [
        `obj_${String(index).repeat(26)}`,
        user,
        device,
        JSON.stringify({ capabilities: ["web-search"], taskSpec: { kind: "table-fill" } }),
        `0x${"a".repeat(64)}`,
        AT,
      ],
    );
  }
  await getPool().query(
    `INSERT INTO observations(obs_id,user_id,vault,network,rail,service_id,version_id,
       task_class,objective_id,envelope_ref,step_index,call_index,payment_ref_hash,
       payment_id,dedup_key,delivered,settled_at)
     VALUES($1,$2,$3,$4,'x402-exact',$5,$6,$7,$8,$9,0,0,$10,'pay_1','dedup_1',1,$11)`,
    [
      OBS,
      SOURCE,
      `0x${"1".repeat(40)}`,
      NETWORK,
      SERVICE,
      VERSION,
      TASK_CLASS,
      `obj_${"1".repeat(26)}`,
      `eip155:5042002:0x${"1".repeat(40)}:1`,
      `0x${"1".repeat(64)}`,
      AT,
    ],
  );
  await getPool().query(
    `INSERT INTO social_threads(thread_id,kind,network,subject_key,opened_by)
     VALUES($1,'service',$2,$3,$4)`,
    [`thr_${"1".repeat(26)}`, NETWORK, `service:${NETWORK}:${SERVICE}`, SOURCE_REP],
  );
  const card = {
    network: NETWORK,
    serviceId: cardService,
    versionId: VERSION,
    taskClass: TASK_CLASS,
    rating: "good",
    deliveryOutcome: "delivered",
  };
  await getPool().query(
    `INSERT INTO social_posts(post_id,thread_id,author_id,kind,card,action_id)
     VALUES($1,$2,$3,'experience',$4::jsonb,'experience:1')`,
    [POST, `thr_${"1".repeat(26)}`, SOURCE_REP, JSON.stringify(card)],
  );
  await getPool().query(
    "INSERT INTO social_evidence_links(post_id,obs_id,link_kind) VALUES($1,$2,'experience')",
    [POST, OBS],
  );
}

describe("SN-4 private lessons", () => {
  beforeEach(async () => {
    await getPool().query("TRUNCATE users CASCADE");
  });
  it("creates one lesson from linked settled evidence for an active recipient", async () => {
    await seed();
    const client = await getPool().connect();
    try {
      const input = { representativeId: RECIPIENT_REP, postId: POST, now: AT };
      expect(await createLesson(client, input, loadConfig())).toBe(true);
      expect(await createLesson(client, input, loadConfig())).toBe(false);
    } finally {
      client.release();
    }
    expect(await lessonsFor(getPool(), RECIPIENT, NETWORK, TASK_CLASS, AT)).toMatchObject([
      { serviceId: SERVICE, proposition: "prefer", strength: 1 },
    ]);
  });

  it("rejects a post whose service differs from its linked observation", async () => {
    await seed(`svc_${"b".repeat(32)}`);
    const client = await getPool().connect();
    try {
      expect(
        await createLesson(
          client,
          { representativeId: RECIPIENT_REP, postId: POST, now: AT },
          loadConfig(),
        ),
      ).toBe(false);
    } finally {
      client.release();
    }
    expect(await lessonsFor(getPool(), RECIPIENT, NETWORK, TASK_CLASS, AT)).toEqual([]);
  });
});
