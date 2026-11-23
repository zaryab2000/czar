import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

if (process.env["CZAR_SOCIAL_DEMO"] !== "1")
  throw new Error("Set CZAR_SOCIAL_DEMO=1 for local capture.");
const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const serverRequire = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { chromium } = webRequire("@playwright/test");
const { Pool } = serverRequire("pg");
const pool = new Pool({ connectionString: "postgres://postgres@127.0.0.1:15433/postgres" });
let browser;
try {
  const owner = await pool.query(
    `SELECT o.user_id FROM objectives o JOIN users u USING(user_id)
     WHERE o.state='no-supplier' AND u.controlled LIMIT 1`,
  );
  if (owner.rowCount !== 1) throw new Error("No controlled no-supplier owner");
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions(token_hash,user_id,expires_at)
     VALUES($1,$2,now()+interval '2 hours')`,
    [createHash("sha256").update(token).digest(), owner.rows[0].user_id],
  );
  const incident = await pool.query(
    `SELECT thread_id FROM social_incidents ORDER BY opened_at LIMIT 1`,
  );
  const question = await pool.query(
    `SELECT thread_id FROM social_threads WHERE kind='question' ORDER BY created_at DESC LIMIT 1`,
  );
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  await page.addInitScript((value) => {
    sessionStorage.setItem("czar.appSession", value);
    sessionStorage.setItem("czar.appSessionExpiresAt", "2099-01-01T00:00:00.000Z");
  }, token);
  // The social API remains live; only the unrelated account summary requires a vault.
  await page.route("**/v1/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ network: "eip155:5042002" }),
    }),
  );
  const capture = async (path, name, heading) => {
    await page.goto(`http://localhost:3001${path}`, { waitUntil: "networkidle" });
    try {
      await page.getByRole("heading", { name: heading }).first().waitFor({ timeout: 5000 });
    } catch (error) {
      process.stdout.write(
        `${name} mismatch at ${page.url()} headings=${JSON.stringify(await page.locator("h1,h2").allTextContents())}\n`,
      );
      await page.screenshot({
        path: `/private/tmp/czar-social-demo-${name}-failed.png`,
        fullPage: true,
      });
      throw error;
    }
    await page.screenshot({ path: `/private/tmp/czar-social-demo-${name}.png`, fullPage: true });
    process.stdout.write(`${name}: ${page.url()}\n`);
  };
  await capture("/onboarding/representative", "01-onboarding", "Your commerce representative");
  await capture("/social", "02-feed", "Representatives");
  if (incident.rows[0]) {
    await capture(`/social/threads/${incident.rows[0].thread_id}`, "03-incident-thread", /.+/);
  }
  if (question.rows[0]) {
    await capture(`/social/threads/${question.rows[0].thread_id}`, "06-lead-thread", /.+/);
  }
  await capture("/social/me", "07-my-representative-before", "Your representative");
  await page.getByText("Controlled representative").first().waitFor({ timeout: 10000 });
  await page
    .getByText(/prefer svc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/)
    .first()
    .waitFor({ timeout: 10000 });
  await page.screenshot({
    path: "/private/tmp/czar-social-demo-07-prefer-lesson.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Dismiss" }).first().click();
  await page.getByText("(dismissed)").first().waitFor({ timeout: 10000 });
  await page.screenshot({
    path: "/private/tmp/czar-social-demo-07-dismissed-lesson.png",
    fullPage: true,
  });
} finally {
  await browser?.close();
  await pool.end();
}
