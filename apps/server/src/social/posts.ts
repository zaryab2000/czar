import type { Pool, PoolClient } from "pg";
import { validateSocialPostProjection, type SocialPostProjection } from "@czar/schemas";

interface PostRow {
  post_id: string;
  thread_id: string;
  parent_post_id: string | null;
  author_id: string | null;
  handle: string | null;
  controlled: boolean | null;
  kind: SocialPostProjection["kind"];
  stance: SocialPostProjection["stance"];
  card: SocialPostProjection["card"];
  revision: number;
  superseded_by: string | null;
  tombstoned_at: Date | null;
  created_at: Date;
}

export function day(value: Date | string): string {
  return `${new Date(value).toISOString().slice(0, 10)}T00:00:00Z`;
}

export function projectPost(row: PostRow): SocialPostProjection {
  const post: SocialPostProjection = {
    postId: row.post_id,
    threadId: row.thread_id,
    parentPostId: row.parent_post_id,
    author:
      row.author_id && row.handle && row.controlled !== null
        ? { representativeId: row.author_id, handle: row.handle, controlled: row.controlled }
        : null,
    kind: row.kind,
    stance: row.stance,
    card: row.tombstoned_at ? { tombstoned: true } : row.card,
    revision: row.revision,
    supersededBy: row.superseded_by,
    tombstoned: row.tombstoned_at !== null,
    createdAt: day(row.created_at),
  };
  if (!validateSocialPostProjection(post)) throw new Error("Invalid social post projection.");
  return post;
}

const POST_COLUMNS = `p.post_id,p.thread_id,p.parent_post_id,p.author_id,r.handle,r.controlled,
  p.kind,p.stance,p.card,p.revision,p.superseded_by,p.tombstoned_at,p.created_at`;
const POST_FROM = `FROM social_posts p LEFT JOIN social_representatives r
  ON r.representative_id=p.author_id`;

export async function listThreadPosts(
  pool: Pool,
  threadId: string,
): Promise<SocialPostProjection[]> {
  const result = await pool.query<PostRow>(
    `SELECT ${POST_COLUMNS} ${POST_FROM} WHERE p.thread_id=$1 AND p.superseded_by IS NULL
     ORDER BY p.created_at,p.post_id LIMIT 200`,
    [threadId],
  );
  return result.rows.map(projectPost);
}

export async function listFeedPosts(
  pool: Pool,
  options: {
    kind?: string | undefined;
    network?: string | undefined;
    cursor?: string;
    limit: number;
  },
): Promise<{ items: SocialPostProjection[]; nextCursor: string | null }> {
  const result = await pool.query<PostRow>(
    `SELECT ${POST_COLUMNS} ${POST_FROM}
     JOIN social_threads t ON t.thread_id=p.thread_id
     WHERE p.superseded_by IS NULL AND ($1::text IS NULL OR p.kind=$1)
       AND ($2::text IS NULL OR t.network=$2)
       AND ($3::text IS NULL OR (p.created_at,p.post_id) <
         (SELECT created_at,post_id FROM social_posts WHERE post_id=$3))
     ORDER BY p.created_at DESC,p.post_id DESC LIMIT $4`,
    [options.kind ?? null, options.network ?? null, options.cursor ?? null, options.limit + 1],
  );
  const rows = result.rows.slice(0, options.limit);
  return {
    items: rows.map(projectPost),
    nextCursor: result.rows.length > options.limit ? (rows.at(-1)?.post_id ?? null) : null,
  };
}

/** Remove every revision while preserving private evidence links for deduplication. */
export async function tombstonePost(
  client: PoolClient,
  postId: string,
  userId: string,
  now: Date,
): Promise<"deleted" | "unknown" | "not-your-post"> {
  const found = await client.query<{ author_id: string | null; user_id: string | null }>(
    `SELECT p.author_id,r.user_id FROM social_posts p
     LEFT JOIN social_representatives r ON r.representative_id=p.author_id
     WHERE p.post_id=$1 FOR UPDATE OF p`,
    [postId],
  );
  const row = found.rows[0];
  if (!row) return "unknown";
  if (!row.author_id || row.user_id !== userId) return "not-your-post";
  await client.query(
    `WITH RECURSIVE chain AS (
       SELECT post_id,parent_post_id,superseded_by FROM social_posts WHERE post_id=$1
       UNION
       SELECT p.post_id,p.parent_post_id,p.superseded_by FROM social_posts p
       JOIN chain c ON p.superseded_by=c.post_id OR c.superseded_by=p.post_id
     )
     UPDATE social_posts SET tombstoned_at=COALESCE(tombstoned_at,$2),
       card='{"tombstoned":true}'::jsonb WHERE post_id IN (SELECT post_id FROM chain)`,
    [postId, now],
  );
  await client.query(
    `UPDATE social_lessons SET state='superseded'
     WHERE source_post_id IN (
       WITH RECURSIVE chain AS (
         SELECT post_id,superseded_by FROM social_posts WHERE post_id=$1
         UNION
         SELECT p.post_id,p.superseded_by FROM social_posts p JOIN chain c
           ON p.superseded_by=c.post_id OR c.superseded_by=p.post_id
       ) SELECT post_id FROM chain
     ) AND state='active'`,
    [postId],
  );
  return "deleted";
}
