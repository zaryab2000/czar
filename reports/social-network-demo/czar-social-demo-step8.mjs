import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

if (process.env["CZAR_SOCIAL_DEMO"] !== "1")
  throw new Error("Set CZAR_SOCIAL_DEMO=1 for local pause/replay.");
const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const serverRequire = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { chromium } = webRequire("@playwright/test");
const { Pool } = serverRequire("pg");
const pool = new Pool({ connectionString: "postgres://postgres@127.0.0.1:15433/postgres" });
let browser;
try {
  const owner = await pool.query(
    `SELECT o.objective_id,o.user_id,r.representative_id FROM objectives o
     JOIN users u USING(user_id) JOIN social_representatives r USING(user_id)
     WHERE o.state='no-supplier' AND u.controlled LIMIT 1`,
  );
  if (owner.rowCount !== 1) throw new Error("No controlled no-supplier owner");
  const { objective_id, user_id, representative_id } = owner.rows[0];
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions(token_hash,user_id,expires_at)
     VALUES($1,$2,now()+interval '2 hours')`,
    [createHash("sha256").update(token).digest(), user_id],
  );
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((value) => {
    sessionStorage.setItem("czar.appSession", value);
    sessionStorage.setItem("czar.appSessionExpiresAt", "2099-01-01T00:00:00.000Z");
  }, token);
  await page.route("**/v1/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ network: "eip155:5042002" }),
    }),
  );
  await page.goto("http://localhost:3001/social/me", { waitUntil: "networkidle" });
  const pause = page.getByLabel("Pause representative");
  await pause.waitFor({ timeout: 15000 });
  if (!(await pause.isChecked())) await pause.click();
  await page.reload({ waitUntil: "networkidle" });
  if (!(await pause.isChecked())) throw new Error("Representative did not pause");
  await page.screenshot({ path: "/private/tmp/czar-social-demo-08-paused.png", fullPage: true });
  const event = await pool.query(
    `INSERT INTO outbox_events(name,objective_id,payload)
     VALUES('objective.no-supplier',$1,'{}') RETURNING event_id`,
    [objective_id],
  );
  let skipped = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runs = await pool.query(
      `SELECT count(*)::integer AS n FROM social_runs run JOIN social_inbox i USING(inbox_id)
       WHERE i.representative_id=$1 AND i.event_id=$2 AND run.stop_reason='skipped-paused'`,
      [representative_id, event.rows[0].event_id],
    );
    if (runs.rows[0].n === 1) {
      skipped = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  if (!skipped) throw new Error("No skipped-paused run for the replayed controlled event");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("abstain: skipped paused").first().waitFor({ timeout: 10000 });
  await page.screenshot({
    path: "/private/tmp/czar-social-demo-08-skipped-paused.png",
    fullPage: true,
  });
  process.stdout.write("Controlled representative paused; replay run recorded skipped-paused.\n");
} finally {
  await browser?.close();
  await pool.end();
}
