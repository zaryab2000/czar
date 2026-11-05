import { randomBytes } from "node:crypto";
import { loadConfig, type Config } from "@czar/config";
import { encodeBase64Json, type SafeFetch } from "@czar/x402";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { runDemoCheck, type DemoChecks } from "#src/social/demo-check";
import { runDemoReset } from "#src/social/demo-reset";
import { runDemoSeed } from "#src/social/demo-seed";
import { socialWorkerPass } from "#src/social/worker-main";
import { randomId } from "#src/http/ids";
import { setupDatabase } from "#test/db";
import { seedDevice, TEST_USER_ID, TEST_DEVICE_ID } from "#test/fixtures";

const pool = setupDatabase();
const now = new Date();
const quickId = `svc_${"a".repeat(32)}`;
const deepId = `svc_${"b".repeat(32)}`;
const network = "eip155:5042002";
const asset = "0x3600000000000000000000000000000000000000";
const bobVault = `0x${"3".repeat(40)}`;

async function seedPreservationFixtures(): Promise<{
  observationId: string;
  oldRatingId: string;
  newRatingId: string;
  otherIncidentId: string;
  representativeId: string;
}> {
  const database = pool();
  const random = { bytes: randomBytes };
  await seedDevice(database);
  const representativeId = randomId("rep_", random);
  await database.query(
    `INSERT INTO social_representatives(representative_id,user_id,handle,sharing)
     VALUES($1,$2,'Rep-B0B0','structured')`,
    [representativeId, TEST_USER_ID],
  );
  await database.query(
    `INSERT INTO social_subscriptions(representative_id,subject_key,source,expires_at)
     VALUES($1,$2,'purchase',$3)`,
    [representativeId, `service:${network}:${quickId}`, new Date(Date.now() + 86_400_000)],
  );
  await database.query("UPDATE users SET vault=$1 WHERE user_id=$2", [bobVault, TEST_USER_ID]);
  const objectiveId = randomId("obj_", random);
  const planId = randomId("pln_", random);
  const observationId = `obs_${randomBytes(16).toString("hex")}`;
  const oldRatingId = randomId("rtg_", random);
  const newRatingId = randomId("rtg_", random);
  const envelopeRef = `${network}:${bobVault}:999`;
  const paymentHash = `0x${"c".repeat(64)}`;
  await database.query(
    `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state,
       plan_id,envelope_ref) VALUES($1,$2,$3,'{}',$4,'delivered',$5,$6)`,
    [objectiveId, TEST_USER_ID, TEST_DEVICE_ID, `0x${"a".repeat(64)}`, planId, envelopeRef],
  );
  await database.query(
    `INSERT INTO plans(plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES($1,$2,'{}',$3,$3,'approved')`,
    [planId, objectiveId, `0x${"b".repeat(64)}`],
  );
  await database.query("INSERT INTO steps(plan_id,step_index,step,state) VALUES($1,0,$2,'done')", [
    planId,
    { kind: "x402-exact", serviceId: quickId, payee: `0x${"1".repeat(40)}` },
  ]);
  await database.query(
    `INSERT INTO observations(obs_id,user_id,vault,network,rail,service_id,version_id,
       task_class,objective_id,envelope_ref,step_index,call_index,payment_ref_hash,payment_id,
       dedup_key,delivered,settled_at,settlement_tx)
     VALUES($1,$2,$3,$4,'x402-exact',$5,$6,'smart-contract-audit',$7,$8,0,0,$9,
       'bob-payment-1',$10,1,now(),$11)`,
    [
      observationId,
      TEST_USER_ID,
      bobVault,
      network,
      quickId,
      `ver_${"a".repeat(32)}`,
      objectiveId,
      envelopeRef,
      paymentHash,
      `x402-exact:${network}:${bobVault}:0x${"1".repeat(40)}:${paymentHash}`,
      `0x${"d".repeat(64)}`,
    ],
  );
  for (const [ratingId, createdAt] of [
    [oldRatingId, new Date("2020-01-01T00:00:00Z")],
    [newRatingId, new Date(Date.now() + 1000)],
  ] as const) {
    await database.query(
      `INSERT INTO ratings(rating_id,user_id,vault,objective_id,step_index,network,service_id,
         version_id,task_class,value,surface,created_at)
       VALUES($1,$2,$3,$4,0,$5,$6,$7,'smart-contract-audit','bad','web',$8)`,
      [
        ratingId,
        TEST_USER_ID,
        bobVault,
        objectiveId,
        network,
        quickId,
        `ver_${"a".repeat(32)}`,
        createdAt,
      ],
    );
  }
  await database.query("INSERT INTO rating_receipts(obs_id,rating_id) VALUES($1,$2)", [
    observationId,
    newRatingId,
  ]);
  const otherIncidentId = await seedOtherSocialHistory(database);
  return { observationId, oldRatingId, newRatingId, otherIncidentId, representativeId };
}

async function seedOtherSocialHistory(database: Pool): Promise<string> {
  const random = { bytes: randomBytes };
  const otherId = `svc_${"e".repeat(32)}`;
  await database.query(
    `INSERT INTO social_threads(thread_id,kind,network,service_id,subject_key)
     VALUES($1,'service',$2,$3,$4)`,
    [randomId("thr_", random), network, otherId, `service:${network}:${otherId}`],
  );
  await database.query(
    `INSERT INTO social_posts(post_id,thread_id,kind,action_id)
     SELECT $1,thread_id,'system',$2 FROM social_threads WHERE service_id=$3`,
    [randomId("pst_", random), `other-service-${randomBytes(8).toString("hex")}`, otherId],
  );
  const otherIncidentId = randomId("inc_", random);
  const otherIncidentThread = randomId("thr_", random);
  await database.query(
    `INSERT INTO social_threads(thread_id,kind,network,service_id,version_id,task_class,
       subject_key,incident_id)
     VALUES($1,'incident',$2,$3,$4,'data-json',$5,$6)`,
    [
      otherIncidentThread,
      network,
      quickId,
      `ver_${"a".repeat(32)}`,
      `incident:${otherIncidentId}`,
      otherIncidentId,
    ],
  );
  await database.query(
    `INSERT INTO social_incidents(incident_id,network,service_id,version_id,task_class,
       state,distinct_owners,negative_units,window_start,window_end,thread_id)
     VALUES($1,$2,$3,$4,'data-json','open',3,3,$5,$6,$7)`,
    [
      otherIncidentId,
      network,
      quickId,
      `ver_${"a".repeat(32)}`,
      new Date(Date.now() - 86_400_000),
      new Date(),
      otherIncidentThread,
    ],
  );
  return otherIncidentId;
}

function registration(name: string) {
  return {
    serviceName: name,
    resource: { url: `https://merchant.example/v1/${name}`, method: "POST" },
    probeInput: { body: { query: "czar probe" } },
    capabilities: ["code-review"],
  };
}

const safeFetch: SafeFetch = async (url) => {
  const resourceUrl = new URL(url).origin + new URL(url).pathname;
  const payTo = resourceUrl.includes("quick") ? `0x${"1".repeat(40)}` : `0x${"2".repeat(40)}`;
  return {
    status: 402,
    url: resourceUrl,
    headers: {
      "payment-required": encodeBase64Json({
        x402Version: 2,
        resource: { url: resourceUrl },
        accepts: [
          {
            scheme: "exact",
            network,
            amount: "50000",
            asset,
            payTo,
            maxTimeoutSeconds: 300,
            extra: {},
          },
        ],
      }),
    },
    body: Buffer.from(""),
  };
};

async function seedInitialAudit(): Promise<{ config: Config; check: DemoChecks }> {
  const config = loadConfig({
    envFile: {
      "selection.paymentNetwork": network,
      "planner.capabilityToTaskClass": { "code-review": "smart-contract-audit" },
      "selection.czarRegisteredServices": {
        [quickId]: registration("czar-audit-quick"),
        [deepId]: registration("czar-audit-deep"),
      },
    },
  });
  await runDemoSeed(pool(), config, now, safeFetch);
  const beforeWorker = await runDemoCheck(pool(), config);
  expect(beforeWorker.controlledRepresentatives).toBe(3);
  expect(beforeWorker.activeClassSubscriptions).toBe(3);
  expect(beforeWorker.openAuditIncidents).toBe(0);
  expect(beforeWorker.startingRank).toEqual([quickId, deepId]);
  expect(beforeWorker.experiencePosts).toBe(0);
  const workerNow = new Date(now.getTime() + 60_000);
  for (let pass = 0; pass < 30; pass += 1) {
    await socialWorkerPass(pool(), config, workerNow);
  }
  const check = await runDemoCheck(pool(), config);
  expect(check.experiencePosts).toBe(3);
  expect(check.passed).toBe(true);
  return { config, check };
}

describe("SCR-183 demo seed command", () => {
  it("refuses to seed before the audit task-class mapping is installed", async () => {
    const config = loadConfig({
      envFile: {
        "selection.paymentNetwork": network,
        "planner.capabilityToTaskClass": { "web-search": "data-json.search" },
      },
    });
    await expect(runDemoSeed(pool(), config, now, safeFetch)).rejects.toThrow(
      "requires SCR-182 code-review audit task-class mapping",
    );
  });

  it("probes both merchants, seeds evidence, and stores A then B as ranked", async () => {
    const { config, check: afterWorker } = await seedInitialAudit();
    const bob = await seedPreservationFixtures();
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const controlledObjectives = await pool().query<{ objective_id: string }>(
        `SELECT o.objective_id FROM objectives o JOIN users u USING(user_id)
         JOIN social_representatives r USING(user_id)
         WHERE u.controlled AND r.controlled AND r.handle=ANY($1::text[])`,
        [["Rep-CZ01", "Rep-CZ02", "Rep-CZ03"]],
      );
      const objectiveIds = new Set(controlledObjectives.rows.map((row) => row.objective_id));
      const controlledBudgets = await pool().query<{ representative_id: string }>(
        `SELECT b.representative_id FROM social_budgets b
         JOIN social_representatives r USING(representative_id)
         WHERE r.handle=ANY($1::text[])`,
        [["Rep-CZ01", "Rep-CZ02", "Rep-CZ03"]],
      );
      expect(controlledBudgets.rowCount).toBeGreaterThan(0);
      const beforeEvents = await pool().query(
        `SELECT event_id,name,objective_id,payload,created_at,delivered_at,txid::text
         FROM outbox_events ORDER BY event_id`,
      );
      const beforeDeliveries = await pool().query(
        "SELECT event_id,consumer,state FROM event_deliveries ORDER BY event_id",
      );
      const beforeCursor = await pool().query(
        "SELECT consumer,last_txid::text,last_event_id FROM social_consumer_cursor",
      );
      const beforeDecisions = await pool().query<{ query_id: string }>(
        "SELECT query_id::text FROM ranking_decisions ORDER BY query_id",
      );
      const reset = await runDemoReset(pool(), config, new Date(), safeFetch);
      expect(reset.controlledOwnersDeleted).toBe(3);
      expect(reset.rehearsalRatingsDeleted).toBe(cycle === 0 ? 1 : 0);
      const preserved = await pool().query<{ payment_id: string; settlement_tx: string }>(
        "SELECT payment_id,settlement_tx FROM observations WHERE obs_id=$1",
        [bob.observationId],
      );
      expect(preserved.rows).toEqual([
        {
          payment_id: "bob-payment-1",
          settlement_tx: `0x${"d".repeat(64)}`,
        },
      ]);
      expect(
        (
          await pool().query(
            `SELECT r.sharing,s.subject_key FROM social_representatives r
             JOIN social_subscriptions s USING(representative_id)
             WHERE r.representative_id=$1`,
            [bob.representativeId],
          )
        ).rows,
      ).toEqual([{ sharing: "structured", subject_key: `service:${network}:${quickId}` }]);
      const ratings = await pool().query<{ rating_id: string }>(
        "SELECT rating_id FROM ratings WHERE rating_id=ANY($1::text[])",
        [[bob.oldRatingId, bob.newRatingId]],
      );
      expect(ratings.rows.map((row) => row.rating_id)).toEqual([bob.oldRatingId]);
      expect(
        (await pool().query("SELECT 1 FROM rating_receipts WHERE obs_id=$1", [bob.observationId]))
          .rowCount,
      ).toBe(0);
      expect(
        (await pool().query("SELECT 1 FROM social_posts WHERE action_id LIKE 'other-service-%'"))
          .rowCount,
      ).toBe(1);
      expect(
        (
          await pool().query(
            "SELECT 1 FROM social_incidents WHERE incident_id=$1 AND task_class='data-json'",
            [bob.otherIncidentId],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await pool().query(
            "SELECT 1 FROM social_budgets WHERE representative_id=ANY($1::text[])",
            [controlledBudgets.rows.map((row) => row.representative_id)],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await pool().query(
            `SELECT event_id,name,objective_id,payload,created_at,delivered_at,txid::text
             FROM outbox_events ORDER BY event_id`,
          )
        ).rows,
      ).toEqual(
        beforeEvents.rows.map((event) => ({
          ...event,
          objective_id: objectiveIds.has(event.objective_id as string) ? null : event.objective_id,
        })),
      );
      expect(
        (
          await pool().query(
            "SELECT event_id,consumer,state FROM event_deliveries ORDER BY event_id",
          )
        ).rows,
      ).toEqual(beforeDeliveries.rows);
      expect(
        (
          await pool().query(
            "SELECT consumer,last_txid::text,last_event_id FROM social_consumer_cursor",
          )
        ).rows,
      ).toEqual(beforeCursor.rows);
      const retainedDecisions = await pool().query<{ query_id: string }>(
        "SELECT query_id::text FROM ranking_decisions WHERE query_id=ANY($1::uuid[]) ORDER BY query_id",
        [beforeDecisions.rows.map((row) => row.query_id)],
      );
      expect(retainedDecisions.rows).toEqual(beforeDecisions.rows);
      expect(
        (
          await pool().query("SELECT 1 FROM supplier_counts WHERE service_id=ANY($1::text[])", [
            [quickId, deepId],
          ])
        ).rowCount,
      ).toBe(0);
      if (cycle === 0) {
        const emptyReset = await runDemoReset(pool(), config, new Date(), safeFetch);
        expect(emptyReset.realRatingsSkippedWithoutBoundary).toBe(true);
        expect(emptyReset.rehearsalRatingsDeleted).toBe(0);
      }
      await runDemoSeed(pool(), config, new Date(), safeFetch);
      for (let pass = 0; pass < 30; pass += 1) {
        await socialWorkerPass(pool(), config, new Date(Date.now() + 60_000));
      }
      expect(await runDemoCheck(pool(), config)).toEqual(afterWorker);
    }
  });
});
