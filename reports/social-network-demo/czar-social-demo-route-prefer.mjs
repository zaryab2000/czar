import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

if (process.env["CZAR_SOCIAL_DEMO"] !== "1") {
  throw new Error("Set CZAR_SOCIAL_DEMO=1 for the authorized local demo.");
}
const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { Pool } = require("pg");
const { loadConfigFile, validateLocalOnlyConfig } = await import("@czar/config");
const { routeSocialEvent } = await import("../../apps/server/src/social/router.ts");
const configPath = fileURLToPath(new URL("../../env/local.toml", import.meta.url));
const config = await loadConfigFile(configPath);
await validateLocalOnlyConfig({
  config,
  overlayPath: configPath,
  arcRpcUrl: "http://127.0.0.1:8545",
});
const pool = new Pool({ connectionString: "postgres://postgres@127.0.0.1:15433/postgres" });
try {
  const post = await pool.query(
    `SELECT p.post_id,p.thread_id FROM social_posts p
     WHERE p.kind='experience' AND p.card->>'serviceId'=$1
       AND p.card->>'rating'='good' AND p.card->>'deliveryOutcome'='delivered'
       AND p.tombstoned_at IS NULL AND p.superseded_by IS NULL
     ORDER BY p.created_at DESC,p.post_id DESC LIMIT 1`,
    [`svc_${"a".repeat(32)}`],
  );
  if (post.rowCount !== 1) throw new Error("No controlled good comparison post was published.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const event = await client.query(
      `INSERT INTO outbox_events(name,payload,delivered_at)
       VALUES('social.post.published',$1::jsonb,now()) RETURNING event_id`,
      [JSON.stringify({ postId: post.rows[0].post_id, threadId: post.rows[0].thread_id })],
    );
    await routeSocialEvent(
      client,
      "social.post.published",
      { postId: post.rows[0].post_id, threadId: post.rows[0].thread_id },
      String(event.rows[0].event_id),
      50,
      0,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const active = await pool.query(
      `SELECT count(*)::integer n FROM social_lessons
       WHERE proposition='prefer' AND state='active' AND service_id=$1`,
      [`svc_${"a".repeat(32)}`],
    );
    if (active.rows[0].n > 0) {
      process.stdout.write(`Live routed active prefer lessons: ${active.rows[0].n}.\n`);
      break;
    }
    if (attempt === 29) throw new Error("Production worker did not create a routed prefer lesson.");
    await new Promise((done) => setTimeout(done, 1000));
  }
} finally {
  await pool.end();
}
