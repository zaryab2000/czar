import { createHash } from "node:crypto";
import type { Config } from "@czar/config";
import { validateSchema, type SocialExperienceCard, type SocialQuestionCard } from "@czar/schemas";
import type { Pool, PoolClient } from "pg";
import { randomId, ulid, type RandomSource } from "#src/http/ids";
import { taskClassFor } from "#src/selection/task-class";
import { finishInbox, claimNextInbox, retryInbox, type InboxRow } from "#src/social/inbox";
import { isPublicContentSafe } from "#src/social/projection/denylist";
import { buildExperienceCard } from "#src/social/projection/experience-card";
import { day } from "#src/social/posts";

interface Representative {
  representative_id: string;
  user_id: string;
  sharing: "off" | "structured" | "discuss";
  sharing_version: number;
  paused: boolean;
}

interface PlannedPost {
  threadKind: "service" | "question" | "incident";
  subjectKey: string;
  network: string;
  serviceId: string | null;
  taskClass: string | null;
  capabilityTag: string | null;
  card: object;
  kind: "experience" | "question" | "reply";
  evidenceIds: string[];
  subjectLabels: string[];
  stepIndex: number | null;
  revisionOf?: { postId: string; threadId: string; revision: number };
  existingThreadId?: string;
  parentPostId?: string;
  stance?: "corroborates" | "contradicts" | "answers" | "neutral";
  linkKind?: "experience" | "reply" | "attach";
}

export interface RunResult {
  action: string;
  stopReason: string;
  postId: string | null;
}

export interface RunHooks {
  beforeCommit?(): Promise<void>;
  afterPostInsert?(): Promise<void>;
  createLesson?(
    client: PoolClient,
    input: { representativeId: string; postId: string; now: Date },
    config: Config,
  ): Promise<boolean>;
}

interface RunContext {
  db: PoolClient;
  item: InboxRow;
  representative: Representative;
  config: Config;
  random: RandomSource;
  now: Date;
}

function outputFormat(
  value: string | null,
): Exclude<SocialQuestionCard["outputFormat"], undefined> {
  if (
    value === "json" ||
    value === "csv" ||
    value === "markdown-table" ||
    value === "markdown-list" ||
    value === "prose"
  )
    return value;
  return null;
}

function actionId(
  context: RunContext,
  action: string,
  subject: string,
  step: number | null,
): string {
  return actionIdFor(
    context.representative.representative_id,
    context.item.event_id,
    action,
    subject,
    step,
  );
}

function actionIdFor(
  representativeId: string,
  eventId: string,
  action: string,
  subject: string,
  step: number | null,
): string {
  return createHash("sha256")
    .update([representativeId, eventId, action, subject, step ?? ""].join("\0"))
    .digest("hex");
}

function failureQuestion(plan: PlannedPost, now: Date): PlannedPost {
  const card = plan.card as SocialExperienceCard;
  const question: SocialQuestionCard = {
    cardVersion: "1",
    network: plan.network,
    taskClass: plan.taskClass ?? "",
    capabilityTag: plan.capabilityTag ?? "",
    outputFormat: card.outputFormat,
    serviceId: plan.serviceId ?? "",
    questionKind: "corroborate-failure",
    asOf: day(now),
    ...(card.versionId ? { versionId: card.versionId } : {}),
  };
  return {
    threadKind: "question",
    subjectKey: plan.subjectKey,
    network: plan.network,
    serviceId: plan.serviceId,
    taskClass: plan.taskClass,
    capabilityTag: plan.capabilityTag,
    card: question,
    kind: "question",
    evidenceIds: [],
    subjectLabels: plan.subjectLabels,
    stepIndex: plan.stepIndex,
  };
}

async function alreadyAsked(context: RunContext, plan: PlannedPost): Promise<boolean> {
  const objectiveId = context.item.refs["objectiveId"];
  if (typeof objectiveId !== "string") return false;
  const events = await context.db.query<{ event_id: string }>(
    `SELECT event_id FROM social_inbox WHERE representative_id=$1
       AND refs->>'objectiveId'=$2 AND kind IN ('outcome-ready','outcome-updated')`,
    [context.representative.representative_id, objectiveId],
  );
  const ids = events.rows.map((row) =>
    actionIdFor(
      context.representative.representative_id,
      row.event_id,
      "publish-question",
      plan.subjectKey,
      plan.stepIndex,
    ),
  );
  if (ids.length === 0) return false;
  const found = await context.db.query(
    "SELECT 1 FROM social_posts WHERE action_id=ANY($1::text[]) LIMIT 1",
    [ids],
  );
  return found.rowCount === 1;
}

async function planNeedUnmet(context: RunContext): Promise<PlannedPost[]> {
  const objectiveId = context.item.refs["objectiveId"];
  if (typeof objectiveId !== "string") return [];
  const result = await context.db.query<{
    state: string;
    capabilities: string[];
    output_format: string | null;
  }>(
    `SELECT state,capabilities,output_format FROM social_objective_projection
     WHERE objective_id=$1 AND user_id=$2`,
    [objectiveId, context.representative.user_id],
  );
  const objective = result.rows[0];
  const capability = objective?.capabilities?.[0];
  if (objective?.state !== "no-supplier" || !capability) return [];
  const labels = await context.db.query<{ labels: string[] }>(
    "SELECT social_objective_subject_labels($1) AS labels",
    [objectiveId],
  );
  const network = String(context.config.get("selection.paymentNetwork"));
  const taskClass = taskClassFor(capability, context.config);
  const card: SocialQuestionCard = {
    cardVersion: "1",
    network,
    taskClass,
    capabilityTag: capability,
    outputFormat: outputFormat(objective.output_format),
    questionKind: "find-supplier",
    asOf: day(context.now),
  };
  if (!validateSchema("social-question-card", card)) return [];
  return [
    {
      threadKind: "question",
      subjectKey: "",
      network,
      serviceId: null,
      taskClass,
      capabilityTag: capability,
      card,
      kind: "question",
      evidenceIds: [],
      subjectLabels: labels.rows[0]?.labels ?? [],
      stepIndex: null,
    },
  ];
}

async function planOutcomeReady(context: RunContext): Promise<PlannedPost[]> {
  const objectiveId = context.item.refs["objectiveId"];
  if (typeof objectiveId !== "string") return [];
  const steps = await context.db.query<{ step_index: number }>(
    `SELECT DISTINCT step_index FROM social_observation_projection
     WHERE objective_id=$1 AND user_id=$2 AND step_index IS NOT NULL
       AND settled_at IS NOT NULL AND released_at IS NULL ORDER BY step_index`,
    [objectiveId, context.representative.user_id],
  );
  const plans: PlannedPost[] = [];
  for (const row of steps.rows) {
    const projection = await buildExperienceCard(context.db, objectiveId, row.step_index);
    if (!projection) continue;
    const existing = await context.db.query(
      `SELECT 1 FROM social_evidence_links
       WHERE obs_id=ANY($1::text[]) AND link_kind='experience' LIMIT 1`,
      [projection.observationIds],
    );
    if (existing.rowCount) continue;
    const { card } = projection;
    plans.push({
      threadKind: "service",
      subjectKey: `service:${card.network}:${card.serviceId}`,
      network: card.network,
      serviceId: card.serviceId,
      taskClass: card.taskClass,
      capabilityTag: card.capabilityTag,
      card,
      kind: "experience",
      evidenceIds: projection.observationIds,
      subjectLabels: projection.subjectLabels,
      stepIndex: row.step_index,
    });
  }
  const failed = plans.find((plan) => {
    const card = plan.card as { deliveryOutcome: string };
    return card.deliveryOutcome === "not-delivered" || card.deliveryOutcome === "partial";
  });
  if (failed && !(await alreadyAsked(context, failed)))
    plans.push(failureQuestion(failed, context.now));
  return plans;
}

async function planOutcomeUpdated(context: RunContext): Promise<PlannedPost[]> {
  const objectiveId = context.item.refs["objectiveId"];
  const stepIndex = context.item.refs["stepIndex"];
  if (typeof objectiveId !== "string" || typeof stepIndex !== "number") return [];
  const old = await context.db.query<{
    post_id: string;
    thread_id: string;
    revision: number;
  }>(
    `SELECT DISTINCT p.post_id,p.thread_id,p.revision FROM social_posts p
     JOIN social_evidence_links l ON l.post_id=p.post_id AND l.link_kind='experience'
     JOIN social_observation_projection o ON o.obs_id=l.obs_id
     WHERE p.author_id=$1 AND p.kind='experience' AND p.superseded_by IS NULL
       AND p.tombstoned_at IS NULL AND o.objective_id=$2 AND o.step_index=$3
       AND o.user_id=$4 LIMIT 1`,
    [
      context.representative.representative_id,
      objectiveId,
      stepIndex,
      context.representative.user_id,
    ],
  );
  const prior = old.rows[0];
  if (!prior) {
    const ready = await context.db.query<{ state: string }>(
      `SELECT state FROM social_inbox WHERE representative_id=$1 AND kind='outcome-ready'
         AND refs->>'objectiveId'=$2 ORDER BY inbox_id DESC LIMIT 1`,
      [context.representative.representative_id, objectiveId],
    );
    if (ready.rows[0] && ready.rows[0].state !== "done") {
      throw new Error(`Outcome-ready has not completed for ${objectiveId}.`);
    }
    return [];
  }
  const projection = await buildExperienceCard(context.db, objectiveId, stepIndex);
  if (!projection) return [];
  const { card } = projection;
  const plan: PlannedPost = {
    threadKind: "service",
    subjectKey: `service:${card.network}:${card.serviceId}`,
    network: card.network,
    serviceId: card.serviceId,
    taskClass: card.taskClass,
    capabilityTag: card.capabilityTag,
    card,
    kind: "experience",
    evidenceIds: projection.observationIds,
    subjectLabels: projection.subjectLabels,
    stepIndex,
    revisionOf: { postId: prior.post_id, threadId: prior.thread_id, revision: prior.revision },
  };
  const plans = [plan];
  if (card.rating === "bad" && !(await alreadyAsked(context, plan))) {
    plans.push(failureQuestion(plan, context.now));
  }
  return plans;
}

function isBad(card: SocialExperienceCard): boolean {
  return card.rating === "bad" || card.deliveryOutcome === "not-delivered";
}

function isGood(card: SocialExperienceCard): boolean {
  return card.deliveryOutcome === "delivered" && card.rating !== "bad";
}

interface RoutedPost {
  post_id: string;
  thread_id: string;
  author_id: string | null;
  kind: string;
  card: Record<string, unknown>;
  thread_kind: "service" | "question" | "incident";
  network: string;
  service_id: string | null;
  version_id: string | null;
  task_class: string | null;
  capability_tag: string | null;
  subject_key: string;
  state: string;
}

async function ownEvidence(
  context: RunContext,
  post: RoutedPost,
): Promise<Awaited<ReturnType<typeof buildExperienceCard>> | null> {
  const serviceId =
    post.service_id ?? (typeof post.card["serviceId"] === "string" ? post.card["serviceId"] : null);
  const versionId =
    post.version_id ?? (typeof post.card["versionId"] === "string" ? post.card["versionId"] : null);
  const taskClass =
    post.task_class ?? (typeof post.card["taskClass"] === "string" ? post.card["taskClass"] : null);
  const findSupplier = post.kind === "question" && post.card["questionKind"] === "find-supplier";
  for (let offset = 0; ; offset += 20) {
    const found = await context.db.query<{ objective_id: string; step_index: number }>(
      `SELECT o.objective_id,o.step_index,max(o.settled_at) AS latest
     FROM social_observation_projection o
     LEFT JOIN ratings_effective r ON r.objective_id=o.objective_id
       AND r.step_index=o.step_index
     WHERE o.user_id=$1 AND o.network=$2 AND o.settled_at IS NOT NULL
       AND o.released_at IS NULL AND o.objective_id IS NOT NULL
       AND o.step_index IS NOT NULL
       AND ($3::text IS NULL OR o.service_id=$3)
       AND ($4::text IS NULL OR o.version_id=$4)
       AND ($5::text IS NULL OR o.task_class=$5)
     GROUP BY o.objective_id,o.step_index,r.value
     ORDER BY CASE WHEN $6::boolean AND r.value='good' THEN 1 ELSE 0 END DESC,
       latest DESC LIMIT 20 OFFSET $7`,
      [
        context.representative.user_id,
        post.network,
        serviceId,
        versionId,
        taskClass,
        findSupplier,
        offset,
      ],
    );
    for (const row of found.rows) {
      const projection = await buildExperienceCard(context.db, row.objective_id, row.step_index);
      if (projection && (!findSupplier || isGood(projection.card))) return projection;
    }
    if (found.rows.length < 20) return null;
  }
}

async function planRouted(context: RunContext): Promise<PlannedPost[]> {
  const postId = context.item.refs["postId"];
  const threadId = context.item.refs["threadId"];
  if (typeof postId !== "string" || typeof threadId !== "string") return [];
  const found = await context.db.query<RoutedPost>(
    `SELECT p.post_id,p.thread_id,p.author_id,p.kind,p.card,
       t.kind AS thread_kind,t.network,t.service_id,t.version_id,t.task_class,
       t.capability_tag,t.subject_key,t.state
     FROM social_posts p JOIN social_threads t ON t.thread_id=p.thread_id
     WHERE p.post_id=$1 AND p.thread_id=$2 AND p.tombstoned_at IS NULL`,
    [postId, threadId],
  );
  const post = found.rows[0];
  if (
    !post ||
    post.author_id === context.representative.representative_id ||
    post.kind === "lead" ||
    post.kind === "system" ||
    post.kind === "reply"
  )
    return [];
  if (post.thread_kind === "question" && post.state !== "open") {
    throw new SocialStop("skipped-thread-closed");
  }
  const evidence = await ownEvidence(context, post);
  if (!evidence) return [];
  let stance: PlannedPost["stance"];
  if (post.kind === "question" && post.card["questionKind"] === "find-supplier") {
    stance = "answers";
  } else if (post.kind === "question") {
    stance = isBad(evidence.card)
      ? "corroborates"
      : isGood(evidence.card)
        ? "contradicts"
        : undefined;
  } else if (post.kind === "experience") {
    const original = post.card as unknown as SocialExperienceCard;
    stance =
      (isBad(original) && isGood(evidence.card)) || (isGood(original) && isBad(evidence.card))
        ? "contradicts"
        : undefined;
  }
  if (!stance) return [];
  return [
    {
      threadKind: post.thread_kind,
      existingThreadId: post.thread_id,
      parentPostId: post.post_id,
      stance,
      linkKind: "reply",
      subjectKey: post.subject_key,
      network: post.network,
      serviceId: post.service_id,
      taskClass: post.task_class,
      capabilityTag: post.capability_tag,
      card: evidence.card,
      kind: "reply",
      evidenceIds: evidence.observationIds,
      subjectLabels: evidence.subjectLabels,
      stepIndex: null,
    },
  ];
}

async function planIncident(context: RunContext): Promise<PlannedPost[]> {
  const incidentId = context.item.refs["incidentId"];
  if (typeof incidentId !== "string") return [];
  const found = await context.db.query<{
    thread_id: string | null;
    network: string;
    service_id: string;
    version_id: string;
    task_class: string;
  }>(
    `SELECT thread_id,network,service_id,version_id,task_class
     FROM social_incidents WHERE incident_id=$1`,
    [incidentId],
  );
  const incident = found.rows[0];
  if (!incident?.thread_id) return [];
  const post = await context.db.query<{
    post_id: string;
    card: SocialExperienceCard;
  }>(
    `SELECT DISTINCT p.post_id,p.card,p.created_at FROM social_posts p
     JOIN social_evidence_links l ON l.post_id=p.post_id AND l.link_kind='experience'
     JOIN social_observation_projection o ON o.obs_id=l.obs_id
     WHERE p.author_id=$1 AND p.kind='experience' AND p.superseded_by IS NULL
       AND p.tombstoned_at IS NULL AND o.network=$2 AND o.service_id=$3
       AND o.task_class=$4 AND ($5='ver_unknown' OR o.version_id=$5)
     ORDER BY p.created_at DESC LIMIT 1`,
    [
      context.representative.representative_id,
      incident.network,
      incident.service_id,
      incident.task_class,
      incident.version_id,
    ],
  );
  const own = post.rows[0];
  if (!own) return [];
  const evidence = await context.db.query<{ obs_id: string }>(
    `SELECT obs_id FROM social_evidence_links WHERE post_id=$1 AND link_kind='experience'`,
    [own.post_id],
  );
  return [
    {
      threadKind: "incident",
      existingThreadId: incident.thread_id,
      subjectKey: `incident:${incident.network}:${incident.service_id}:${incident.version_id}:${incident.task_class}`,
      network: incident.network,
      serviceId: incident.service_id,
      taskClass: incident.task_class,
      capabilityTag: own.card.capabilityTag,
      card: own.card,
      kind: "reply",
      stance: "neutral",
      linkKind: "attach",
      evidenceIds: evidence.rows.map((row) => row.obs_id),
      subjectLabels: [],
      stepIndex: null,
    },
  ];
}

async function planPosts(context: RunContext): Promise<PlannedPost[]> {
  if (context.item.kind === "need-unmet") return planNeedUnmet(context);
  if (context.item.kind === "outcome-ready") return planOutcomeReady(context);
  if (context.item.kind === "outcome-updated") return planOutcomeUpdated(context);
  if (context.item.kind === "post-routed") return planRouted(context);
  if (context.item.kind === "incident-changed") return planIncident(context);
  return [];
}

async function threadFor(context: RunContext, plan: PlannedPost): Promise<string> {
  if (plan.existingThreadId) {
    const existing = await context.db.query<{
      thread_id: string;
      state: string;
      kind: string;
      contributions: number;
      expires_at: Date | null;
    }>(
      `SELECT thread_id,state,kind,contributions,expires_at FROM social_threads
       WHERE thread_id=$1 FOR UPDATE`,
      [plan.existingThreadId],
    );
    const row = existing.rows[0];
    if (!row || row.state !== "open" || (row.expires_at && row.expires_at <= context.now)) {
      throw new SocialStop("skipped-thread-closed");
    }
    if (
      row.kind === "question" &&
      row.contributions >= Number(context.config.get("social.maxContributionsPerThread"))
    ) {
      throw new SocialStop("skipped-thread-full");
    }
    return row.thread_id;
  }
  const id = randomId("thr_", context.random);
  const subjectKey = plan.threadKind === "question" ? `question:${id}` : plan.subjectKey;
  const expires =
    plan.threadKind === "question"
      ? new Date(
          context.now.getTime() +
            Number(context.config.get("social.questionLifetimeHours")) * 3_600_000,
        )
      : null;
  await context.db.query(
    `INSERT INTO social_threads(thread_id,kind,network,service_id,task_class,capability_tag,
       subject_key,opened_by,expires_at,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     ON CONFLICT DO NOTHING`,
    [
      id,
      plan.threadKind,
      plan.network,
      plan.serviceId,
      plan.taskClass,
      plan.capabilityTag,
      subjectKey,
      context.representative.representative_id,
      expires,
      context.now,
    ],
  );
  const thread = await context.db.query<{
    thread_id: string;
    state: string;
    contributions: number;
  }>("SELECT thread_id,state,contributions FROM social_threads WHERE subject_key=$1 FOR UPDATE", [
    subjectKey,
  ]);
  const row = thread.rows[0];
  if (!row) throw new Error(`Social thread create failed for ${subjectKey}.`);
  if (row.state !== "open") throw new SocialStop("skipped-thread-closed");
  if (
    plan.threadKind === "question" &&
    row.contributions >= Number(context.config.get("social.maxContributionsPerThread"))
  ) {
    throw new SocialStop("skipped-thread-full");
  }
  return row.thread_id;
}

class SocialStop extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

async function postBudget(context: RunContext, threadId: string): Promise<void> {
  const limit = Number(context.config.get("social.repDailyPostCap"));
  await context.db.query(
    `INSERT INTO social_budgets(representative_id,day,posts)
     VALUES($1,$2::date,0) ON CONFLICT(representative_id,day) DO NOTHING`,
    [context.representative.representative_id, context.now],
  );
  const used = await context.db.query<{ posts: number }>(
    `SELECT posts FROM social_budgets WHERE representative_id=$1 AND day=$2::date FOR UPDATE`,
    [context.representative.representative_id, context.now],
  );
  if ((used.rows[0]?.posts ?? 0) >= limit) throw new SocialStop("skipped-daily-cap");
  const thread = await context.db.query<{ kind: string; contributions: number }>(
    "SELECT kind,contributions FROM social_threads WHERE thread_id=$1 FOR UPDATE",
    [threadId],
  );
  if (thread.rows[0]?.kind === "question") {
    const repPosts = await context.db.query<{ count: string }>(
      `SELECT count(*) FROM social_posts WHERE thread_id=$1 AND author_id=$2`,
      [threadId, context.representative.representative_id],
    );
    if (
      Number(repPosts.rows[0]?.count) >=
      Number(context.config.get("social.maxContributionsPerRepPerThread"))
    ) {
      throw new SocialStop("skipped-rep-thread-cap");
    }
  }
}

async function insertPost(context: RunContext, plan: PlannedPost): Promise<string | null> {
  if (!isPublicContentSafe(plan.card, plan.subjectLabels)) {
    throw new SocialStop("rejected-denylist");
  }
  const threadId = plan.revisionOf?.threadId ?? (await threadFor(context, plan));
  await postBudget(context, threadId);
  const postId = randomId("pst_", context.random);
  const action =
    plan.linkKind === "attach"
      ? "attach-experience"
      : plan.kind === "reply"
        ? "publish-reply"
        : `publish-${plan.kind}`;
  const id = plan.revisionOf
    ? `${actionId(context, "revise-experience", plan.subjectKey, plan.stepIndex)}:r${plan.revisionOf.revision + 1}`
    : actionId(context, action, plan.subjectKey, plan.stepIndex);
  const created = await context.db.query<{ post_id: string }>(
    `INSERT INTO social_posts(post_id,thread_id,parent_post_id,author_id,kind,stance,
       card,action_id,revision,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT(action_id) DO NOTHING RETURNING post_id`,
    [
      postId,
      threadId,
      plan.parentPostId ?? null,
      context.representative.representative_id,
      plan.kind,
      plan.stance ?? null,
      plan.card,
      id,
      (plan.revisionOf?.revision ?? 0) + 1,
      context.now,
    ],
  );
  if (!created.rows[0]) {
    const existing = await context.db.query<{ post_id: string }>(
      "SELECT post_id FROM social_posts WHERE action_id=$1",
      [id],
    );
    return existing.rows[0]?.post_id ?? null;
  }
  if (plan.revisionOf) {
    const revised = await context.db.query(
      `UPDATE social_posts SET superseded_by=$2
       WHERE post_id=$1 AND superseded_by IS NULL AND tombstoned_at IS NULL`,
      [plan.revisionOf.postId, postId],
    );
    if (revised.rowCount !== 1) throw new SocialStop("abstain-no-rule");
    await context.db.query(
      `UPDATE social_evidence_links SET post_id=$2 WHERE post_id=$1 AND link_kind='experience'`,
      [plan.revisionOf.postId, postId],
    );
  } else {
    for (const observationId of plan.evidenceIds) {
      await context.db.query(
        `INSERT INTO social_evidence_links(post_id,obs_id,link_kind)
         VALUES($1,$2,$3)`,
        [postId, observationId, plan.linkKind ?? "experience"],
      );
    }
  }
  await context.db.query(
    `INSERT INTO social_budgets(representative_id,day,posts)
     VALUES($1,$2::date,1) ON CONFLICT(representative_id,day)
     DO UPDATE SET posts=social_budgets.posts+1`,
    [context.representative.representative_id, context.now],
  );
  await context.db.query(
    `UPDATE social_threads SET contributions=contributions+1,revision=revision+1,
       state=CASE WHEN kind='question' AND contributions+1 >= $3 THEN 'closed'
         ELSE state END,updated_at=$2 WHERE thread_id=$1`,
    [threadId, context.now, Number(context.config.get("social.maxContributionsPerThread"))],
  );
  if (!plan.revisionOf) {
    await context.db.query(
      `INSERT INTO outbox_events(name,payload,delivered_at)
       VALUES('social.post.published',$1,now())`,
      [{ postId, threadId }],
    );
  }
  return postId;
}

async function recordRun(context: RunContext, result: RunResult): Promise<void> {
  await context.db.query(
    `INSERT INTO social_runs(run_id,inbox_id,representative_id,sharing_version,
       policy_version,action,stop_reason,post_id,started_at,finished_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [
      ulid("run_", context.now, context.random),
      context.item.inbox_id,
      context.representative.representative_id,
      context.representative.sharing_version,
      String(context.config.get("social.policyVersion")),
      result.action,
      result.stopReason,
      result.postId,
      context.now,
    ],
  );
  await finishInbox(
    context.db,
    context.item.inbox_id,
    context.item.lease_token,
    result.stopReason,
    context.now,
  );
}

async function executeClaim(
  pool: Pool,
  item: InboxRow,
  config: Config,
  random: RandomSource,
  now: Date,
  hooks: RunHooks,
): Promise<RunResult | null> {
  const db = await pool.connect();
  try {
    const found = await db.query<Representative>(
      `SELECT representative_id,user_id,sharing,sharing_version,paused
       FROM social_representatives WHERE representative_id=$1`,
      [item.representative_id],
    );
    const representative = found.rows[0];
    if (!representative) throw new Error(`Unknown representative ${item.representative_id}.`);
    const context = { db, item, representative, config, random, now };
    const event = await db.query<{ created_at: Date }>(
      "SELECT created_at FROM outbox_events WHERE event_id=$1",
      [item.event_id],
    );
    let result: RunResult;
    let plans: PlannedPost[] = [];
    if (representative.paused) {
      result = { action: "abstain", stopReason: "skipped-paused", postId: null };
    } else if (representative.sharing === "off") {
      result = { action: "abstain", stopReason: "skipped-sharing-off", postId: null };
    } else if (
      now.getTime() - (event.rows[0]?.created_at.getTime() ?? 0) >
      Number(config.get("social.eventMaxAgeHours")) * 3_600_000
    ) {
      result = { action: "abstain", stopReason: "skipped-stale", postId: null };
    } else {
      plans = await planPosts(context);
      result = {
        action: "abstain",
        stopReason: item.kind === "outcome-updated" ? "abstain-no-rule" : "abstain-no-evidence",
        postId: null,
      };
    }
    await hooks.beforeCommit?.();
    await db.query("BEGIN");
    const current = await db.query<Representative>(
      `SELECT representative_id,user_id,sharing,sharing_version,paused
       FROM social_representatives WHERE representative_id=$1 FOR SHARE`,
      [item.representative_id],
    );
    const lease = await db.query<{ lease_token: string }>(
      "SELECT lease_token FROM social_inbox WHERE inbox_id=$1 FOR UPDATE",
      [item.inbox_id],
    );
    if (lease.rows[0]?.lease_token !== item.lease_token) {
      await db.query("ROLLBACK");
      return null;
    }
    if (
      current.rows[0]?.sharing_version !== representative.sharing_version ||
      (current.rows[0]?.paused && !representative.paused)
    ) {
      result = { action: "abstain", stopReason: "rejected-consent-changed", postId: null };
    } else if (!representative.paused) {
      const routedPostId = item.refs["postId"];
      const lessonCreated =
        item.kind === "post-routed" && typeof routedPostId === "string" && hooks.createLesson
          ? await hooks.createLesson(
              db,
              {
                representativeId: representative.representative_id,
                postId: routedPostId,
                now,
              },
              config,
            )
          : false;
      if (lessonCreated && plans.length === 0) {
        result = { action: "create-lesson", stopReason: "done", postId: null };
      }
    }
    if (result.stopReason !== "rejected-consent-changed" && plans.length > 0) {
      await db.query("SAVEPOINT social_publication");
      try {
        if (plans.some((plan) => !isPublicContentSafe(plan.card, plan.subjectLabels))) {
          throw new SocialStop("rejected-denylist");
        }
        let postId: string | null = null;
        for (const plan of plans) postId = await insertPost(context, plan);
        if (postId) await hooks.afterPostInsert?.();
        if (postId) {
          result = {
            action: plans[0]?.revisionOf
              ? "revise-experience"
              : plans[0]?.linkKind === "attach"
                ? "attach-experience"
                : plans[0]?.kind === "reply"
                  ? "publish-reply"
                  : plans[0]?.kind === "question"
                    ? "publish-question"
                    : "publish-experience",
            stopReason: "done",
            postId,
          };
        }
      } catch (error) {
        await db.query("ROLLBACK TO SAVEPOINT social_publication");
        if (!(error instanceof SocialStop)) throw error;
        result = { action: "abstain", stopReason: error.reason, postId: null };
      }
    }
    await recordRun(context, result);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

/** Claim and run one due representative item without any model call. */
export async function runSocialInbox(
  pool: Pool,
  config: Config,
  random: RandomSource,
  now: Date,
  hooks: RunHooks = {},
): Promise<RunResult | null> {
  const item = await claimNextInbox(pool, now, Number(config.get("social.runLeaseMs")), random);
  if (!item) return null;
  try {
    return await executeClaim(pool, item, config, random, now, hooks);
  } catch {
    await retryInbox(pool, {
      inboxId: item.inbox_id,
      leaseToken: item.lease_token,
      now,
      baseMs: Number(config.get("social.retryBaseMs")),
      maxMs: Number(config.get("social.retryMaxMs")),
      maxAttempts: Number(config.get("social.maxAttempts")),
    });
    return { action: "abstain", stopReason: "retry-transient", postId: null };
  }
}
