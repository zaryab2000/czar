import { expect, test, type Page } from "@playwright/test";
import type { AppPlan, Me } from "@czar/schemas";

const PLAN_ID = "pln_ta14_performance";
const INITIAL_JS_BUDGET_BYTES = 300 * 1024;
const INTERACTIVE_BUDGET_MS = 1_500;

const plan = {
  schemaVersion: "1.2",
  planId: PLAN_ID,
  objectiveId: "obj_ta14_performance",
  objectiveHash: `0x${"1".repeat(64)}`,
  planHash: `0x${"2".repeat(64)}`,
  network: "eip155:5042002",
  category: "research",
  cap: "1000000",
  slackBps: 0,
  maxStepAmount: "1000000",
  pocketCapBps: 0,
  expiresAt: "2026-10-26T00:00:00Z",
  steps: [],
  payeeLeaves: [],
  payeeRoot: `0x${"3".repeat(64)}`,
  shadow: false,
  createdAt: "2026-10-25T00:00:00Z",
} satisfies AppPlan;

const me = {
  userId: "usr_ta14_performance",
  msca: "0x0000000000000000000000000000000000000001",
  vault: "0x0000000000000000000000000000000000000002",
  vaultCreated: true,
  network: "eip155:5042002",
  balances: {
    vaultBalance: "1000000",
    free: "1000000",
    committed: "0",
    mscaBalance: "1000",
    pocketOutstanding: "0",
    asOfBlock: 1,
  },
  limits: [],
  frozen: false,
  paused: false,
  displayCurrency: "USD",
} satisfies Me;

test("approval deep link meets the JavaScript and interactive budgets", async ({
  page,
  browserName,
}) => {
  await mockApprovalApi(page);
  await page.goto(`/approve/${PLAN_ID}`);

  const approveButton = page.getByRole("button", { name: "Approve $1.00" });
  await expect(approveButton).toBeEnabled();
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const interactiveMs = await page.evaluate(() => performance.now());

  await page.waitForLoadState("networkidle");
  const initialJsBytes = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.endsWith(".js"))
      .reduce((total, entry) => total + (entry as PerformanceResourceTiming).encodedBodySize, 0),
  );
  test.info().annotations.push({
    type: "TA-14 performance",
    description:
      `browser=${browserName}; JS=${initialJsBytes} bytes; ` +
      `interactive=${interactiveMs.toFixed(0)} ms; Apple M4 Mac mini (Mac16,10)`,
  });

  expect(initialJsBytes).toBeLessThanOrEqual(INITIAL_JS_BUDGET_BYTES);
  expect(interactiveMs).toBeLessThanOrEqual(INTERACTIVE_BUDGET_MS);
});

async function mockApprovalApi(page: Page): Promise<void> {
  await page.route("**/v1/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/v1/me") {
      await route.fulfill({
        contentType: "application/json",
        headers: {
          "X-Czar-Bundler-Order": "circle,pimlico,alchemy,zerodev",
          "X-Czar-Bundler-Endpoints": "{}",
        },
        body: JSON.stringify(me),
      });
      return;
    }
    if (pathname === `/v1/approvals/${PLAN_ID}`) {
      await route.fulfill({
        contentType: "application/json",
        headers: { "X-Czar-Large-Cap-Warn-Bps": "5000" },
        body: JSON.stringify(plan),
      });
      return;
    }
    if (pathname === "/v1/approvals") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/problem+json",
      body: JSON.stringify({ detail: "Not found", czarCode: "validation", retryable: false }),
    });
  });
}
