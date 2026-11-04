import { randomBytes } from "node:crypto";
import type { Config } from "@czar/config";
import type { RankingDecision } from "@czar/schemas";
import type { Pool, PoolClient } from "pg";
import { randomId } from "#src/http/ids";
import { taskClassFor } from "#src/selection/task-class";

export interface PersonalLesson {
  readonly lessonId: string;
  readonly serviceId: string;
  readonly handle: string;
  readonly proposition: "prefer" | "avoid";
  readonly taskClass: string;
  readonly strength: number;
}

type Ranked = RankingDecision["ranked"][number];

function margin(score: number, strength: number, maxDelta: number): number {
  return Math.round(score * 1_000_000) - Math.round(maxDelta * strength * 1_000_000);
}

function eligible(first: Ranked, other: Ranked, lesson: PersonalLesson, maxDelta: number): boolean {
  if (first.badges.includes("incident-open") !== other.badges.includes("incident-open"))
    return false;
  return Math.round(other.score * 1_000_000) >= margin(first.score, lesson.strength, maxDelta);
}

/** Reorder only already probed rated survivors within the exact millionth margin. */
export function chooseWithLessons(
  survivors: readonly Ranked[],
  lessons: readonly PersonalLesson[],
  maxDelta: number,
): { selected: Ranked; used: readonly PersonalLesson[] } {
  const first = survivors[0];
  if (!first) throw new Error("Cannot apply lessons without a probed rated survivor.");
  for (const lesson of lessons) {
    if (lesson.proposition === "avoid" && lesson.serviceId === first.service_id) {
      const alternative = survivors.slice(1).find((row) => eligible(first, row, lesson, maxDelta));
      if (alternative) return { selected: alternative, used: [lesson] };
    }
    if (lesson.proposition === "prefer") {
      const preferred = survivors.find((row) => row.service_id === lesson.serviceId);
      if (preferred && eligible(first, preferred, lesson, maxDelta))
        return { selected: preferred, used: [lesson] };
    }
  }
  return { selected: first, used: [] };
}

interface LessonRow {
  lesson_id: string;
  service_id: string;
  handle: string;
  proposition: "prefer" | "avoid";
  task_class: string;
  strength: string;
}

/** Read active, unexpired owner lessons in newest-first order. */
export async function lessonsFor(
  pool: Pool,
  userId: string,
  network: string,
  taskClass: string,
  now = new Date(),
): Promise<PersonalLesson[]> {
  const result = await pool.query<LessonRow>(
    `SELECT l.lesson_id,l.service_id,r.handle,l.proposition,l.task_class,l.strength
     FROM social_lessons l JOIN social_posts p ON p.post_id=l.source_post_id
     JOIN social_representatives r ON r.representative_id=p.author_id
     WHERE l.user_id=$1 AND l.network=$2 AND l.task_class=$3 AND l.state='active'
       AND l.expires_at>$4 AND p.tombstoned_at IS NULL
     ORDER BY l.created_at DESC,l.lesson_id DESC`,
    [userId, network, taskClass, now],
  );
  return result.rows.map((row) => ({
    lessonId: row.lesson_id,
    serviceId: row.service_id,
    handle: row.handle,
    proposition: row.proposition,
    taskClass: row.task_class,
    strength: Number(row.strength),
  }));
}

interface LessonSource {
  user_id: string;
  network: string;
  service_id: string;
  version_id: string | null;
  task_class: string;
  rating: "good" | "bad" | "none";
  delivery_outcome: string;
  source_obs_id: string;
  author_id: string;
  controlled: boolean;
}

function propositionFor(source: LessonSource): "prefer" | "avoid" | null {
  if (source.rating === "bad" || source.delivery_outcome === "not-delivered") return "avoid";
  if (source.rating === "good" && source.delivery_outcome === "delivered") return "prefer";
  return null;
}

/** Create a private lesson only when the recipient has relevant activity but no own evidence. */
export async function createLesson(
  client: PoolClient,
  input: { representativeId: string; postId: string; now: Date },
  config: Config,
): Promise<boolean> {
  const source = await client.query<LessonSource>(
    `SELECT receiver.user_id,p.card->>'network' AS network,
       p.card->>'serviceId' AS service_id,p.card->>'versionId' AS version_id,
       p.card->>'taskClass' AS task_class,p.card->>'rating' AS rating,
       p.card->>'deliveryOutcome' AS delivery_outcome,link.obs_id AS source_obs_id,
       p.author_id,r.controlled
     FROM social_posts p JOIN social_representatives r ON r.representative_id=p.author_id
     JOIN social_representatives receiver ON receiver.representative_id=$1
     JOIN social_evidence_links link ON link.post_id=p.post_id
     JOIN social_observation_projection o ON o.obs_id=link.obs_id
     WHERE p.post_id=$2 AND p.kind IN ('experience','reply') AND p.tombstoned_at IS NULL
       AND o.user_id=r.user_id AND o.settled_at IS NOT NULL AND o.released_at IS NULL
       AND o.network=p.card->>'network' AND o.service_id=p.card->>'serviceId'
       AND o.task_class=p.card->>'taskClass'
       AND nullif(o.version_id,'ver_unknown') IS NOT DISTINCT FROM p.card->>'versionId'
     ORDER BY link.obs_id LIMIT 1`,
    [input.representativeId, input.postId],
  );
  const row = source.rows[0];
  if (!row || row.author_id === input.representativeId) return false;
  const proposition = propositionFor(row);
  if (!proposition) return false;
  const own = await client.query(
    `SELECT 1 FROM social_observation_projection WHERE user_id=$1 AND network=$2
       AND service_id=$3 AND task_class=$4 LIMIT 1`,
    [row.user_id, row.network, row.service_id, row.task_class],
  );
  if (own.rowCount) return false;
  const recent = await client.query<{ capabilities: string[] }>(
    `SELECT capabilities FROM social_objective_projection
     WHERE user_id=$1 AND created_at >= $2 ORDER BY created_at DESC`,
    [row.user_id, new Date(input.now.getTime() - 90 * 86400000)],
  );
  if (
    !recent.rows.some((item) =>
      item.capabilities.some((capability) => taskClassFor(capability, config) === row.task_class),
    )
  )
    return false;
  const baseStrength =
    row.rating === "none"
      ? Number(config.get("social.lessonStrengthFactOnly"))
      : Number(config.get("social.lessonStrengthRated"));
  const strength = baseStrength * (row.controlled ? 0.5 : 1);
  const lessonId = randomId("les_", { bytes: randomBytes });
  const expiresAt = new Date(
    input.now.getTime() + Number(config.get("social.lessonTtlDays")) * 86400000,
  );
  const inserted = await client.query(
    `INSERT INTO social_lessons(lesson_id,user_id,network,service_id,version_id,task_class,
       proposition,strength,source_post_id,source_obs_id,expires_at,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT(user_id,network,service_id,task_class,source_obs_id) DO NOTHING
     RETURNING lesson_id`,
    [
      lessonId,
      row.user_id,
      row.network,
      row.service_id,
      row.version_id,
      row.task_class,
      proposition,
      strength,
      input.postId,
      row.source_obs_id,
      expiresAt,
      input.now,
    ],
  );
  if (!inserted.rowCount) return false;
  await client.query(
    `UPDATE social_lessons l SET state='superseded'
     FROM social_posts p WHERE l.source_post_id=p.post_id AND l.user_id=$1
       AND l.network=$2 AND l.service_id=$3 AND l.task_class=$4
       AND p.author_id=$5 AND l.proposition<>$6 AND l.lesson_id<>$7 AND l.state='active'`,
    [
      row.user_id,
      row.network,
      row.service_id,
      row.task_class,
      row.author_id,
      proposition,
      lessonId,
    ],
  );
  return true;
}
