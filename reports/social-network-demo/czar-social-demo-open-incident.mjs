import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

if (process.env["CZAR_SOCIAL_DEMO"] !== "1") {
  throw new Error("Set CZAR_SOCIAL_DEMO=1 for the authorized local demo.");
}
const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { Pool } = require("pg");
const { randomId } = await import("../../apps/server/src/http/ids.ts");
const { replayControlledFixtures } =
  await import("../../apps/server/src/social/controlled-fixtures.ts");
const { evaluateIncidents } = await import("../../apps/server/src/social/incidents.ts");
const { loadConfigFile, validateLocalOnlyConfig } = await import("@czar/config");

const network = "eip155:5042002";
const incidentService = "svc_223349701b9428c8a6dc42d8a7c99c4a";
const preferredService = `svc_${"a".repeat(32)}`;
const databaseUrl = "postgres://postgres@127.0.0.1:15433/postgres";
const configPath = fileURLToPath(new URL("../../env/local.toml", import.meta.url));
const config = await loadConfigFile(configPath);
await validateLocalOnlyConfig({
  config,
  overlayPath: configPath,
  arcRpcUrl: "http://127.0.0.1:8545",
});
const pool = new Pool({ connectionString: databaseUrl });
const random = { bytes: randomBytes };
const hex = (value) => `0x${createHash("sha256").update(value).digest("hex")}`;
const id = (prefix) => randomId(prefix, random);
const now = new Date();
const taskSpec = {
  schemaVersion: "1.1",
  kind: "table-fill",
  topic: "Controlled search fixture",
  subjects: [{ label: "Synthetic example" }],
  fields: ["Result"],
  sourceTrust: "user-prompt",
  output: { format: "markdown-table", formatSource: "default" },
};

function objectiveSubmission(objectiveId, deviceId) {
  return {
    schemaVersion: "1.0",
    objectiveId,
    deviceId,
    soulVersionHash: hex("controlled:demo:soul"),
    observationHashes: [hex("controlled:demo:observation")],
    detector: "placeholder",
    goal: "Controlled social incident follow-up",
    capabilities: ["web-search"],
    minutesSaved: 30,
    hourlyBand: "B",
    objectiveHash: hex(objectiveId),
    redaction: { layer2: { hits: 0, entities: [] } },
    submittedAt: now.toISOString(),
    taskSpec,
  };
}

async function seedOwner(client, ordinal) {
  const userId = id("usr_");
  const deviceId = id("dev_");
  const representativeId = id("rep_");
  const vault = `0x${createHash("sha256").update(userId).digest("hex").slice(0, 40)}`;
  await client.query("INSERT INTO users(user_id,vault,network,controlled) VALUES($1,$2,$3,true)", [
    userId,
    vault,
    network,
  ]);
  await client.query(
    `INSERT INTO devices(device_id,user_id,device_name,platform,token_hash)
     VALUES($1,$2,'Controlled plan fixture','linux',$3)`,
    [deviceId, userId, randomBytes(32)],
  );
  await client.query(
    `INSERT INTO social_representatives(representative_id,user_id,handle,sharing,controlled,
       consent_text_version,consented_at)
     VALUES($1,$2,$3,'structured',true,$4,$5)`,
    [
      representativeId,
      userId,
      `Rep-${representativeId.slice(-4)}`,
      String(config.get("social.consentTextVersion")),
      now,
    ],
  );
  return { userId, deviceId, vault, ordinal };
}

async function seedExperience(client, owner, serviceId, versionId, rating, ordinal) {
  const objectiveId = id("obj_");
  const planId = id("pln_");
  const ratingId = id("rtg_");
  const obsId = `obs_${randomBytes(16).toString("hex")}`;
  const envelopeRef = `${network}:${owner.vault}:${1000 + ordinal}`;
  const body = objectiveSubmission(objectiveId, owner.deviceId);
  await client.query(
    `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,
       state,plan_id,envelope_ref,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [
      objectiveId,
      owner.userId,
      owner.deviceId,
      body,
      body.objectiveHash,
      rating === "bad" ? "failed" : "delivered",
      planId,
      envelopeRef,
      now,
    ],
  );
  await client.query(
    `INSERT INTO plans(plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES($1,$2,'{}',$3,$3,'approved')`,
    [planId, objectiveId, hex(`controlled:plan:${objectiveId}`)],
  );
  await client.query(`INSERT INTO steps(plan_id,step_index,step,state) VALUES($1,0,$2,'done')`, [
    planId,
    { kind: "x402-exact", serviceId, capability: "web-search", unitAmount: "100000" },
  ]);
  await client.query(
    `INSERT INTO ratings(rating_id,user_id,vault,objective_id,step_index,network,service_id,
       version_id,task_class,value,surface,created_at)
     VALUES($1,$2,$3,$4,0,$5,$6,$7,'data-json.search',$8,'web',$9)`,
    [ratingId, owner.userId, owner.vault, objectiveId, network, serviceId, versionId, rating, now],
  );
  await client.query(
    `INSERT INTO observations(obs_id,user_id,vault,network,rail,service_id,version_id,
       task_class,objective_id,envelope_ref,step_index,call_index,payment_ref_hash,
       payment_id,dedup_key,delivered,settled_at,controlled)
     VALUES($1,$2,$3,$4,'x402-exact',$5,$6,'data-json.search',$7,$8,0,0,$9,$10,$10,$11,$12,true)`,
    [
      obsId,
      owner.userId,
      owner.vault,
      network,
      serviceId,
      versionId,
      objectiveId,
      envelopeRef,
      hex(`controlled:payment:${obsId}`),
      `controlled:${obsId}`,
      rating === "bad" ? 0 : 1,
      now,
    ],
  );
  await client.query("INSERT INTO rating_receipts(obs_id,rating_id) VALUES($1,$2)", [
    obsId,
    ratingId,
  ]);
}

try {
  const versions = await pool.query(
    `SELECT service_id,version_id FROM service_versions
     WHERE network=$1 AND service_id=ANY($2::text[])`,
    [network, [incidentService, preferredService]],
  );
  const version = new Map(versions.rows.map((row) => [row.service_id, row.version_id]));
  if (!version.has(incidentService) || !version.has(preferredService)) {
    throw new Error("Controlled supplier versions are absent from the local fixture database.");
  }
  const before = await pool.query(
    "SELECT state,count(*)::integer n FROM social_incidents GROUP BY state ORDER BY state",
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owners = [];
    for (let ordinal = 0; ordinal < 3; ordinal += 1) {
      owners.push(await seedOwner(client, ordinal));
    }
    for (const [ordinal, owner] of owners.entries()) {
      await seedExperience(
        client,
        owner,
        incidentService,
        version.get(incidentService),
        "bad",
        ordinal,
      );
    }
    await seedExperience(
      client,
      owners[1],
      preferredService,
      version.get(preferredService),
      "good",
      3,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const replay = await replayControlledFixtures(pool);
  await evaluateIncidents(pool, config, new Date());
  const after = await pool.query(
    "SELECT state,count(*)::integer n FROM social_incidents GROUP BY state ORDER BY state",
  );
  process.stdout.write(
    `Controlled evidence replayed ${replay.outcomes} outcomes/${replay.ratings} ratings; ` +
      `incident state counts ${JSON.stringify(before.rows)} -> ${JSON.stringify(after.rows)}.\n`,
  );
  if (!after.rows.some((row) => row.state === "open" && row.n > 0)) {
    throw new Error("Controlled evidence did not open an incident.");
  }
} finally {
  await pool.end();
}
