import { createHash } from "node:crypto";
import { objectiveHash, taskSpecHash } from "@czar/hashing";
import { validateSocialLeadCard } from "@czar/schemas";
import type { TaskSpec } from "@czar/schemas";
import type { Pool, PoolClient } from "pg";
import { randomId, type RandomSource } from "#src/http/ids";

interface OwnerFixture {
  key: string;
  controlled: true;
  sharing: "structured";
}

export interface SupplierFixture {
  key: string;
  serviceId: string;
  resource: { url: string; method: "GET" };
  capability: string;
  taskClass: string;
  probeInput?: { query?: Record<string, string> };
}

interface ExperienceFixture {
  key: string;
  owner: string;
  supplier: string;
  objectiveState: "delivered" | "failed";
  taskSpec: TaskSpec;
  step: { stepIndex: number; kind: string; unitAmount: string };
  observations: Array<{ callIndex: number; delivered: 0 | 1; settledDaysAgo: number }>;
  rating: { value: "good" | "bad"; surface: "web" | "cli" };
}

export interface ControlledFixture {
  network: string;
  owners: OwnerFixture[];
  suppliers: SupplierFixture[];
  experiences: ExperienceFixture[];
  noSupplier: {
    owner: string;
    objectiveState: "no-supplier";
    capability: string;
    taskSpec: TaskSpec;
    lead: { origin: string; pathHint: string; source: "controlled-fixture" };
  };
}

interface SeedOptions {
  count: number;
  network: string;
  consentTextVersion: string;
  now: Date;
  random: RandomSource;
  versionFor(supplier: SupplierFixture): Promise<string>;
}

interface SeedOwner {
  userId: string;
  deviceId: string;
  representativeId: string;
  vault: string;
}

function hex(value: string): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function submission(
  objectiveId: string,
  deviceId: string,
  capability: string,
  taskSpec: TaskSpec,
  now: Date,
): Record<string, unknown> {
  const fields = {
    objectiveId,
    soulVersionHash: hex("controlled:soul"),
    observationHashes: [hex("controlled:observation")],
    detector: "placeholder" as const,
    goal: "Controlled social fixture",
    capabilities: [capability],
    minutesSaved: 30,
    hourlyBand: "B" as const,
  };
  return {
    schemaVersion: "1.0",
    ...fields,
    deviceId,
    objectiveHash: objectiveHash({ ...fields, taskSpecHash: taskSpecHash(taskSpec) }),
    redaction: { layer2: { hits: 0, entities: [] } },
    submittedAt: now.toISOString(),
    taskSpec,
  };
}

async function seedOwners(
  db: PoolClient,
  fixture: ControlledFixture,
  options: SeedOptions,
): Promise<Map<string, SeedOwner>> {
  const owners = new Map<string, SeedOwner>();
  for (const [index, owner] of fixture.owners.entries()) {
    const userId = randomId("usr_", options.random);
    const deviceId = randomId("dev_", options.random);
    const representativeId = randomId("rep_", options.random);
    const vault = `0x${(index + 1).toString(16).padStart(40, "0")}`;
    await db.query(`INSERT INTO users(user_id,vault,network,controlled) VALUES($1,$2,$3,true)`, [
      userId,
      vault,
      fixture.network,
    ]);
    await db.query(
      `INSERT INTO devices(device_id,user_id,device_name,platform,token_hash)
       VALUES($1,$2,'Controlled fixture','linux',$3)`,
      [deviceId, userId, options.random.bytes(32)],
    );
    await db.query(
      `INSERT INTO social_representatives(representative_id,user_id,handle,sharing,
         controlled,consent_text_version,consented_at)
       VALUES($1,$2,$3,$4,true,$5,$6)`,
      [
        representativeId,
        userId,
        `Rep-${representativeId.slice(-4)}`,
        owner.sharing,
        options.consentTextVersion,
        options.now,
      ],
    );
    owners.set(owner.key, { userId, deviceId, representativeId, vault });
  }
  return owners;
}

async function seedExperience(
  db: PoolClient,
  experience: ExperienceFixture,
  fixture: ControlledFixture,
  options: SeedOptions,
  owners: Map<string, SeedOwner>,
  versions: Map<string, string>,
  envelopeOrdinal: number,
): Promise<void> {
  const owner = owners.get(experience.owner);
  const supplier = fixture.suppliers.find((item) => item.key === experience.supplier);
  const versionId = supplier ? versions.get(supplier.key) : undefined;
  if (!owner || !supplier || !versionId)
    throw new Error(`Invalid controlled fixture ${experience.key}`);
  const objectiveId = randomId("obj_", options.random);
  const planId = randomId("pln_", options.random);
  const envelopeRef = `${fixture.network}:${owner.vault}:${envelopeOrdinal}`;
  const body = submission(
    objectiveId,
    owner.deviceId,
    supplier.capability,
    experience.taskSpec,
    options.now,
  );
  await db.query(
    `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,
       state,plan_id,envelope_ref,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [
      objectiveId,
      owner.userId,
      owner.deviceId,
      body,
      body["objectiveHash"],
      experience.objectiveState,
      planId,
      envelopeRef,
      options.now,
    ],
  );
  await db.query(
    `INSERT INTO plans(plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES($1,$2,'{}',$3,$3,'approved')`,
    [planId, objectiveId, hex(`controlled:plan:${experience.key}`)],
  );
  await db.query(`INSERT INTO steps(plan_id,step_index,step,state) VALUES($1,$2,$3,'done')`, [
    planId,
    experience.step.stepIndex,
    {
      kind: experience.step.kind,
      serviceId: supplier.serviceId,
      capability: supplier.capability,
      unitAmount: experience.step.unitAmount,
    },
  ]);
  const ratingId = randomId("rtg_", options.random);
  await db.query(
    `INSERT INTO ratings(rating_id,user_id,vault,objective_id,step_index,network,service_id,
       version_id,task_class,value,surface,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      ratingId,
      owner.userId,
      owner.vault,
      objectiveId,
      experience.step.stepIndex,
      fixture.network,
      supplier.serviceId,
      versionId,
      supplier.taskClass,
      experience.rating.value,
      experience.rating.surface,
      options.now,
    ],
  );
  for (const call of experience.observations) {
    const obsId = `obs_${options.random.bytes(16).toString("hex")}`;
    const settledAt = new Date(options.now.getTime() - call.settledDaysAgo * 86_400_000);
    await db.query(
      `INSERT INTO observations(obs_id,user_id,vault,network,rail,service_id,version_id,
         task_class,objective_id,envelope_ref,step_index,call_index,payment_ref_hash,
         payment_id,dedup_key,delivered,settled_at,controlled)
       VALUES($1,$2,$3,$4,'x402-exact',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true)`,
      [
        obsId,
        owner.userId,
        owner.vault,
        fixture.network,
        supplier.serviceId,
        versionId,
        supplier.taskClass,
        objectiveId,
        envelopeRef,
        experience.step.stepIndex,
        call.callIndex,
        hex(`controlled:payment:${experience.key}:${call.callIndex}`),
        `controlled:${experience.key}:${call.callIndex}`,
        `controlled:${experience.key}:${call.callIndex}`,
        call.delivered,
        settledAt,
      ],
    );
    await db.query("INSERT INTO rating_receipts(obs_id,rating_id) VALUES($1,$2)", [
      obsId,
      ratingId,
    ]);
  }
}

async function seedNoSupplier(
  db: PoolClient,
  fixture: ControlledFixture,
  options: SeedOptions,
  owners: Map<string, SeedOwner>,
): Promise<void> {
  const owner = owners.get(fixture.noSupplier.owner);
  if (!owner) throw new Error("Controlled no-supplier owner is absent.");
  const objectiveId = randomId("obj_", options.random);
  const body = submission(
    objectiveId,
    owner.deviceId,
    fixture.noSupplier.capability,
    fixture.noSupplier.taskSpec,
    options.now,
  );
  await db.query(
    `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,
       state,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,'no-supplier',$6,$6)`,
    [objectiveId, owner.userId, owner.deviceId, body, body["objectiveHash"], options.now],
  );
  await db.query(
    `INSERT INTO outbox_events(name,objective_id,payload,created_at)
     VALUES('objective.no-supplier',$1,'{}',$2)`,
    [objectiveId, options.now],
  );
  const lead = fixture.noSupplier.lead;
  const threadId = randomId("thr_", options.random);
  const postId = randomId("pst_", options.random);
  const leadId = randomId("led_", options.random);
  const card = {
    cardVersion: "1",
    network: fixture.network,
    origin: lead.origin,
    pathHint: lead.pathHint,
    capabilityTag: fixture.noSupplier.capability,
    source: lead.source,
  };
  if (!validateSocialLeadCard(card)) throw new Error("Invalid controlled fixture lead card.");
  await db.query(
    `INSERT INTO social_threads(thread_id,kind,network,task_class,capability_tag,
       subject_key,opened_by,contributions,expires_at)
     VALUES($1,'question',$2,$3,$3,$4,$5,1,$6)`,
    [
      threadId,
      fixture.network,
      fixture.noSupplier.capability,
      `question:${threadId}`,
      owner.representativeId,
      new Date(options.now.getTime() + 24 * 3_600_000),
    ],
  );
  await db.query(
    `INSERT INTO social_posts(post_id,thread_id,author_id,kind,card,action_id,created_at)
     VALUES($1,$2,$3,'lead',$4,$5,$6)`,
    [
      postId,
      threadId,
      owner.representativeId,
      JSON.stringify(card),
      `fixture-lead:${leadId}`,
      options.now,
    ],
  );
  await db.query(
    `INSERT INTO social_leads(lead_id,post_id,network,origin,path_hint,capability_tag,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
    [
      leadId,
      postId,
      fixture.network,
      lead.origin,
      lead.pathHint,
      fixture.noSupplier.capability,
      options.now,
    ],
  );
}

/** Insert controlled evidence only into a caller-approved isolated local database. */
export async function seedControlledFixtures(
  pool: Pool,
  fixture: ControlledFixture,
  options: SeedOptions,
): Promise<void> {
  if (options.count !== 3 || fixture.owners.length !== 3 || options.network !== fixture.network) {
    throw new Error("Controlled fixture requires exactly three owners on its declared network.");
  }
  const versions = new Map<string, string>();
  for (const supplier of fixture.suppliers) {
    const versionId = await options.versionFor(supplier);
    if (!/^ver_[0-9a-f]{32}$/.test(versionId)) {
      throw new Error(`Supplier ${supplier.key} has no verified service version.`);
    }
    versions.set(supplier.key, versionId);
  }
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const existing = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users WHERE controlled",
    );
    if (existing.rows[0]?.count !== "0") throw new Error("Controlled owners already exist.");
    const owners = await seedOwners(db, fixture, options);
    for (const supplier of fixture.suppliers) {
      await db.query(
        `INSERT INTO service_versions(network,service_id,version_id)
         VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [fixture.network, supplier.serviceId, versions.get(supplier.key)],
      );
    }
    for (const [index, experience] of fixture.experiences.entries()) {
      await seedExperience(db, experience, fixture, options, owners, versions, index + 100);
    }
    await seedNoSupplier(db, fixture, options, owners);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

/** Emit each controlled outcome and rating once for an explicit local replay. */
export async function replayControlledFixtures(
  pool: Pool,
): Promise<{ outcomes: number; ratings: number }> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const outcomes = await db.query(
      `INSERT INTO outbox_events(name,objective_id,payload)
       SELECT 'objective.delivered',o.objective_id,'{}'::jsonb
       FROM objectives o JOIN users u USING(user_id)
       WHERE u.controlled AND EXISTS(SELECT 1 FROM ratings r WHERE r.objective_id=o.objective_id)
         AND NOT EXISTS(SELECT 1 FROM outbox_events e WHERE e.name='objective.delivered'
           AND e.objective_id=o.objective_id)`,
    );
    const ratings = await db.query(
      `INSERT INTO outbox_events(name,objective_id,payload)
       SELECT 'rating.recorded',r.objective_id,jsonb_build_object(
         'objectiveId',r.objective_id,'ratingId',r.rating_id,'stepIndex',r.step_index)
       FROM ratings r JOIN users u USING(user_id)
       WHERE u.controlled AND NOT EXISTS(SELECT 1 FROM outbox_events e
         WHERE e.name='rating.recorded' AND e.payload->>'ratingId'=r.rating_id)`,
    );
    await db.query("COMMIT");
    return { outcomes: outcomes.rowCount ?? 0, ratings: ratings.rowCount ?? 0 };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
