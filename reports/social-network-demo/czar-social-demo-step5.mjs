import { createHash } from "node:crypto";
import { createRequire } from "node:module";

if (process.env["CZAR_SOCIAL_DEMO"] !== "1")
  throw new Error("Set CZAR_SOCIAL_DEMO=1 for local replay.");
const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const serverRequire = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { chromium } = webRequire("@playwright/test");
const { Pool } = serverRequire("pg");
const pool = new Pool({ connectionString: "postgres://postgres@127.0.0.1:15433/postgres" });
let browser;
try {
  const objective = await pool.query(
    `SELECT o.objective_id FROM objectives o JOIN ratings r USING(objective_id)
     JOIN users u ON u.user_id=o.user_id
     WHERE u.controlled AND o.state='delivered' AND r.value='good'
       AND r.service_id='svc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
     ORDER BY o.created_at,o.objective_id LIMIT 1`,
  );
  if (objective.rowCount !== 1) throw new Error("No controlled good-rated comparison objective");
  const snapshot = async () => {
    const result = await pool.query(`SELECT
      (SELECT count(*)::integer FROM social_posts) AS posts,
      (SELECT count(*)::integer FROM observations) AS observations,
      (SELECT count(*)::integer FROM ratings) AS ratings,
      (SELECT count(*)::integer FROM supplier_counts) AS supplier_counts,
      (SELECT count(*)::integer FROM supplier_health) AS supplier_health,
      (SELECT count(*)::integer FROM social_incidents) AS incidents,
      (SELECT count(*)::integer FROM ranking_decisions) AS decisions,
      (SELECT md5(coalesce(string_agg(plan_hash,',' ORDER BY plan_id),'')) FROM plans) AS plan_hashes`);
    return result.rows[0];
  };
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/v1/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ network: "eip155:5042002" }),
    }),
  );
  const feed = async (name) => {
    await page.goto("http://localhost:3001/social", { waitUntil: "networkidle" });
    await page.getByRole("article", { name: "experience post" }).first().waitFor();
    const posts = await page.getByRole("article").allTextContents();
    await page.screenshot({ path: `/private/tmp/czar-social-demo-05-${name}.png`, fullPage: true });
    return createHash("sha256").update(JSON.stringify(posts)).digest("hex");
  };
  const before = await snapshot();
  const feedBefore = await feed("before-100-replays");
  const events = await pool.query(
    `INSERT INTO outbox_events(name,objective_id,payload)
     SELECT 'objective.delivered',$1,'{}'::jsonb FROM generate_series(1,100)
     RETURNING event_id`,
    [objective.rows[0].objective_id],
  );
  const ids = events.rows.map((row) => row.event_id);
  let processed = 0;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await pool.query(
      `SELECT count(*)::integer AS n FROM social_inbox
       WHERE event_id=ANY($1::bigint[]) AND state IN ('done','skipped')`,
      [ids],
    );
    processed = result.rows[0].n;
    if (processed === 100) break;
    await new Promise((done) => setTimeout(done, 1000));
  }
  const after = await snapshot();
  const feedAfter = await feed("after-100-replays");
  const runs = await pool.query(
    `SELECT run.stop_reason,count(*)::integer AS n FROM social_runs run
     JOIN social_inbox i USING(inbox_id) WHERE i.event_id=ANY($1::bigint[])
     GROUP BY run.stop_reason ORDER BY run.stop_reason`,
    [ids],
  );
  process.stdout.write(`Processed ${processed}/100 duplicate events.\n`);
  process.stdout.write(`Before ${JSON.stringify(before)}\nAfter ${JSON.stringify(after)}\n`);
  process.stdout.write(`Run reasons ${JSON.stringify(runs.rows)}\n`);
  process.stdout.write(`Feed article SHA256 before=${feedBefore} after=${feedAfter}\n`);
  if (
    processed !== 100 ||
    JSON.stringify(before) !== JSON.stringify(after) ||
    feedBefore !== feedAfter
  ) {
    throw new Error("Duplicate replay changed controlled social state or feed");
  }
} finally {
  await browser?.close();
  await pool.end();
}
