import { createRequire } from "node:module";

if (process.env["CZAR_SOCIAL_DEMO"] !== "1")
  throw new Error("Set CZAR_SOCIAL_DEMO=1 for local routing.");
const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgres://postgres@127.0.0.1:15433/postgres" });
try {
  const post = await pool.query(
    `SELECT p.post_id,p.thread_id FROM social_posts p
     WHERE p.kind='experience' AND p.card->>'serviceId'='svc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
       AND p.card->>'rating'='good' AND p.card->>'deliveryOutcome'='delivered'
       AND p.superseded_by IS NULL AND p.tombstoned_at IS NULL
     ORDER BY p.created_at,p.post_id LIMIT 1`,
  );
  if (post.rowCount !== 1) throw new Error("No eligible controlled comparison post");
  await pool.query(
    `INSERT INTO outbox_events(name,payload,delivered_at)
     VALUES('social.post.published',$1::jsonb,now())`,
    [JSON.stringify({ postId: post.rows[0].post_id, threadId: post.rows[0].thread_id })],
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const lessons = await pool.query(
      `SELECT count(*)::integer AS n FROM social_lessons l JOIN users u ON u.user_id=l.user_id
       WHERE u.controlled AND l.proposition='prefer' AND l.state='active'`,
    );
    if (lessons.rows[0].n > 0) {
      process.stdout.write(`Controlled prefer lessons: ${lessons.rows[0].n}\n`);
      break;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  const routed = await pool.query(
    `SELECT i.state,i.stop_reason,count(*)::integer AS n FROM social_inbox i
     JOIN outbox_events e USING(event_id)
     WHERE e.name='social.post.published' AND e.payload->>'postId'=$1
     GROUP BY i.state,i.stop_reason ORDER BY i.state`,
    [post.rows[0].post_id],
  );
  process.stdout.write(`Routed states: ${JSON.stringify(routed.rows)}\n`);
} finally {
  await pool.end();
}
