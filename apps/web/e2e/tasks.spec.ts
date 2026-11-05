import { expect, test, type Page } from "@playwright/test";

// SCR-181 test 9 (UX-02, UX-03, UX-04): start a task in the browser, follow it without reloading, and rate
// the delivered result. UI route checks: the app API is answered in the browser.
const objectiveId = `obj_${"0".repeat(26)}`;
const planId = `pln_${"0".repeat(26)}`;
const SOURCE = "contract Vault { function withdraw() public {} }";
const NOW = "2026-11-05T12:00:00.000Z";

const task = (state: string, extra: Record<string, unknown> = {}) => ({
  objectiveId,
  title: "Vault audit",
  kind: "smart-contract-audit",
  state,
  createdAt: NOW,
  updatedAt: NOW,
  origin: "web",
  ...extra,
});

async function ownerSession(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem("czar.appSession", "fixture-session");
    sessionStorage.setItem("czar.appSessionExpiresAt", "2099-01-01T00:00:00.000Z");
  });
  await page.route("**/v1/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        userId: `usr_${"0".repeat(26)}`,
        network: "eip155:5042002",
        vaultCreated: true,
        mode: "live",
        balances: { free: "5000000", committed: "0", pocketOutstanding: "0", mscaBalance: "0" },
        limits: [],
        frozen: false,
        paused: false,
      }),
    }),
  );
}

/** The rest of Home's data, empty, so only the tasks section has content. */
async function emptyHomeData(page: Page) {
  const emptyPage = JSON.stringify({ items: [], nextCursor: null });
  for (const path of [
    "**/v1/approvals**",
    "**/v1/ledger/receipts**",
    "**/v1/pockets/manual-returns**",
    "**/v1/app/results**",
  ])
    await page.route(path, (route) =>
      route.fulfill({ contentType: "application/json", body: emptyPage }),
    );
  await page.route("**/v1/social/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        representative: null,
        stats: { posts: 0, replies: 0, lessonsActive: 0 },
      }),
    }),
  );
}

/** Answers GET for the task with each state in turn, then keeps the last one. */
async function taskStates(page: Page, states: readonly Record<string, unknown>[]) {
  let served = 0;
  await page.route(`**/v1/app/objectives/${objectiveId}`, async (route) => {
    const body = states[Math.min(served, states.length - 1)];
    served += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
}

test("a new task is submitted and its progress shows Finding the best merchant", async ({
  page,
}) => {
  await ownerSession(page);
  let submitted: Record<string, unknown> | undefined;
  let idempotencyKey: string | undefined;
  await page.route("**/v1/app/objectives", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    idempotencyKey = route.request().headers()["idempotency-key"];
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ objectiveId, state: "received" }),
    });
  });
  await taskStates(page, [task("received")]);
  await page.goto("/tasks/new");
  await expect(
    page.getByText(
      "What you paste is sent to Czar and to the merchant you approve. Do not paste secrets or private keys.",
    ),
  ).toBeVisible();
  await page.getByLabel("Title").fill("Vault audit");
  await page.getByLabel("What should the audit look at?").fill("Check the withdraw path.");
  await page.getByLabel("Contract source").fill(SOURCE);
  await expect(page.getByText(`${SOURCE.length} / 2,000 characters`)).toBeVisible();
  await page.getByLabel("Maximum budget in USDC (optional)").fill("1.50");
  await page.getByRole("button", { name: "Start task" }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${objectiveId}$`));
  await expect(page.getByRole("status")).toHaveText("Finding the best merchant…");
  expect(submitted).toEqual({
    kind: "smart-contract-audit",
    title: "Vault audit",
    description: "Check the withdraw path.",
    contractSource: SOURCE,
    maxTotal: "1500000",
  });
  expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
});

test("the form refuses a source over the limit before sending anything", async ({ page }) => {
  await ownerSession(page);
  let posted = false;
  await page.route("**/v1/app/objectives", async (route) => {
    posted = true;
    await route.fallback();
  });
  await page.goto("/tasks/new");
  await page.getByLabel("Title").fill("Too long");
  await page.getByLabel("Contract source").fill("a".repeat(2001));
  await page.getByRole("button", { name: "Start task" }).click();
  await expect(
    page.getByText("The source is over 2,000 characters. Use the contract address instead."),
  ).toBeVisible();
  expect(posted).toBe(false);
});

test("Waiting for your approval appears without a reload and links to the approval page", async ({
  page,
}) => {
  await ownerSession(page);
  await taskStates(page, [task("planning"), task("awaiting-approval", { planId })]);
  await page.goto(`/tasks/${objectiveId}`);
  await expect(page.getByRole("status")).toHaveText("Finding the best merchant…");
  await expect(page.getByRole("status")).toHaveText("Waiting for your approval", {
    timeout: 10_000,
  });
  await expect(page.getByRole("link", { name: "Review and approve" })).toHaveAttribute(
    "href",
    `/approve/${planId}`,
  );
});

test("a delivered task shows its result card, and a Bad rating goes through /v1/app/ratings", async ({
  page,
}) => {
  await ownerSession(page);
  await taskStates(page, [task("delivered", { planId })]);
  const card = {
    objectiveId,
    deliveredAt: NOW,
    kind: "list-fill",
    stepCount: 1,
    suppliers: [
      {
        stepIndex: 0,
        merchantLabel: "Czar Lab Quick Audit",
        merchantIsCzar: true,
        receipts: 1,
        effectiveRating: "none",
        canRate: true,
        canCorrect: false,
      },
    ],
    windowClosesAt: "2099-01-01T00:00:00.000Z",
  };
  await page.route("**/v1/app/results*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [card], nextCursor: null }),
    }),
  );
  let rating: Record<string, unknown> | undefined;
  await page.route("**/v1/app/ratings", async (route) => {
    rating = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        ratingId: `rtg_${"0".repeat(26)}`,
        objectiveId,
        stepIndex: 0,
        value: "bad",
        receipts: 1,
        windowClosesAt: "2099-01-01T00:00:00.000Z",
      }),
    });
  });
  await page.goto(`/tasks/${objectiveId}`);
  await expect(page.getByText("Delivered", { exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: `Result ${objectiveId}` })).toBeVisible();
  await page.getByRole("button", { name: "Bad" }).click();
  await expect.poll(() => rating).toEqual({ objectiveId, stepIndex: 0, value: "bad" });
});

test("Home lists browser and device tasks with their origin and a New task button", async ({
  page,
}) => {
  await ownerSession(page);
  await page.route(
    (url) => url.pathname === "/v1/app/objectives",
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            task("awaiting-approval", { planId }),
            {
              ...task("planning"),
              objectiveId: `obj_${"1".repeat(26)}`,
              title: "Vendor pricing",
              kind: "table-fill",
              origin: "device",
            },
          ],
          nextCursor: null,
        }),
      }),
  );
  await emptyHomeData(page);
  await page.goto("/home");
  const tasks = page.getByRole("region", { name: "Your tasks" });
  await expect(tasks.getByRole("link", { name: "New task" })).toHaveAttribute("href", "/tasks/new");
  await expect(tasks.getByText("Vault audit")).toBeVisible();
  await expect(tasks.getByText("Web", { exact: true })).toBeVisible();
  await expect(tasks.getByText("Device", { exact: true })).toBeVisible();
  await expect(tasks.getByText("Waiting for your approval")).toBeVisible();
});
