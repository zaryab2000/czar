import { createRequire } from "node:module";

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const PLAN_ID = `pln_${"A".repeat(26)}`;
const SELECTED = `svc_${"b".repeat(32)}`;
const AVOIDED = `svc_${"a".repeat(32)}`;
const lesson = {
  lessonId: `les_${"A".repeat(26)}`,
  handle: "Rep-ABCD",
  proposition: "avoid",
  serviceId: AVOIDED,
  taskClass: "data-json.search",
};
const plan = {
  schemaVersion: "1.4",
  planId: PLAN_ID,
  objectiveId: `obj_${"A".repeat(26)}`,
  objectiveHash: `0x${"1".repeat(64)}`,
  planHash: `0x${"2".repeat(64)}`,
  network: "eip155:5042002",
  category: "research",
  cap: "1000000",
  slackBps: 0,
  maxStepAmount: "1000000",
  pocketCapBps: 0,
  expiresAt: "2099-01-01T00:00:00Z",
  steps: [
    {
      stepIndex: 0,
      stepId: "step-social-approval",
      kind: "x402-exact",
      capability: "web-search",
      serviceId: SELECTED,
      resource: { url: "https://selected.example/search", method: "GET" },
      payee: `0x${"1".repeat(40)}`,
      unitAmount: "1000000",
      expectedCalls: 1,
      stepCap: "1000000",
      routingReason: "vault-direct",
      acceptanceProfileId: "json",
      why: {
        fills: ["answer"],
        summary: "It checked a search service.",
        alternativesLost: [],
        lessons: [lesson],
      },
    },
  ],
  payeeLeaves: [{ payee: `0x${"1".repeat(40)}`, kind: 1, stepIndex: 0, stepCap: "1000000" }],
  payeeRoot: `0x${"3".repeat(64)}`,
  shadow: false,
  createdAt: "2026-11-05T00:00:00Z",
  approvalReasons: ["incident-open"],
};
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    sessionStorage.setItem("czar.appSession", "fixture-session");
    sessionStorage.setItem("czar.appSessionExpiresAt", "2099-01-01T00:00:00.000Z");
  });
  await page.route("**/v1/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        userId: `usr_${"A".repeat(26)}`,
        network: "eip155:5042002",
        vaultCreated: true,
        mode: "controlled",
        balances: { free: "1000000", committed: "0", pocketOutstanding: "0", mscaBalance: "0" },
        limits: [],
        frozen: false,
        paused: false,
      }),
    }),
  );
  await page.route("**/v1/approvals?**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    }),
  );
  await page.route(`**/v1/approvals/${PLAN_ID}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "X-Czar-Large-Cap-Warn-Bps": "5000" },
      body: JSON.stringify(plan),
    }),
  );
  await page.goto(`http://localhost:3001/approve/${PLAN_ID}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Review this plan" }).waitFor();
  await page.getByText(/This supplier has an open incident:/).waitFor();
  await page.getByText(new RegExp(`that ${AVOIDED} did not`)).waitFor();
  await page.screenshot({
    path: "/private/tmp/czar-social-demo-04-incident-approval-fixture.png",
    fullPage: true,
  });
  plan.steps[0].why.lessons = [{ ...lesson, proposition: "prefer", serviceId: SELECTED }];
  delete plan.approvalReasons;
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText(new RegExp(`that ${SELECTED} did do`)).waitFor();
  await page.screenshot({
    path: "/private/tmp/czar-social-demo-07-prefer-approval-fixture.png",
    fullPage: true,
  });
  process.stdout.write(
    "Deterministic approval UI shows incident line and avoids supplier misattribution.\n",
  );
} finally {
  await browser.close();
}
