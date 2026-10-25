import { expect, test } from "@playwright/test";

test("loads the app shell at /", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("Czar");
  await expect(
    page.getByRole("heading", { name: "Let Czar take care of the busywork." }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Create your account" })).toBeVisible();
});

test("loads public wallet config from the same-origin server", async ({ page }) => {
  await page.goto("/");

  const config = await page.evaluate(async () => {
    const response = await fetch("/v1/app/wallet-config", { cache: "no-store" });
    return {
      status: response.status,
      cacheControl: response.headers.get("Cache-Control"),
      body: await response.json(),
    };
  });

  expect(config.status).toBe(200);
  expect(config.cacheControl).toContain("no-store");
  expect(config.body).toMatchObject({
    circleClientUrl: "http://127.0.0.1:4337",
    circleClientKey: "e2e-public-client-key",
    arcRpcUrl: "http://127.0.0.1:8549",
    bundlerOrder: ["circle", "pimlico", "alchemy", "zerodev"],
    bundlerEndpoints: {},
  });
});

test("routes an unknown path to the not-found page with 404", async ({ page }) => {
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("ships no web manifest or service worker (D69)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  expect(await page.evaluate(() => navigator.serviceWorker?.controller ?? null)).toBeNull();
});

test("keeps the first-load JavaScript transfer within the 300 KB budget", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const transferredBytes = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.endsWith(".js"))
      .reduce((total, entry) => total + (entry as PerformanceResourceTiming).encodedBodySize, 0),
  );
  expect(transferredBytes).toBeLessThanOrEqual(300 * 1024);
});

test("navigation reaches the owner home and privacy explanation", async ({ page }) => {
  await page.route("**/v1/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        userId: "usr_01J00000000000000000000000",
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
      }),
    }),
  );
  await page.route("**/v1/approvals**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], nextCursor: null }),
    }),
  );
  await page.route("**/v1/ledger/receipts**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], nextCursor: null }),
    }),
  );
  await page.goto("/home");
  await expect(page.getByRole("heading", { name: "Your Czar account" })).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Privacy" })).toBeVisible();
  await expect(page.getByText(/Raw work data stays on your computer/)).toBeVisible();
});

test("pending approvals update the tab title from the server count", async ({ page }) => {
  await page.route("**/v1/approvals?status=pending", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: {
        "X-Czar-Pending-Poll-Seconds": "15",
        "X-Czar-Approval-Confirm-Timeout-Seconds": "120",
      },
      body: JSON.stringify({
        items: [
          {
            planId: "pln_01J00000000000000000000000",
            objectiveId: "obj_01J00000000000000000000000",
            goal: "Research prices",
            cap: "1000000",
            capDisplay: "$1.00",
            category: "research",
            stepCount: 1,
            createdAt: "2026-10-21T00:00:00Z",
            expiresAt: "2026-10-22T00:00:00Z",
            status: "pending",
          },
        ],
        nextCursor: null,
      }),
    }),
  );
  await page.goto("/approvals");
  await expect(page.getByRole("link", { name: "Research prices" })).toBeVisible();
  await expect(page).toHaveTitle("(1) Czar");
});

test("submitted approvals show their network wait state without an approve action", async ({
  page,
}) => {
  await page.route("**/v1/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        userId: "usr_01J00000000000000000000000",
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
      }),
    }),
  );
  await page.route("**/v1/approvals?status=pending", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: {
        "X-Czar-Pending-Poll-Seconds": "15",
        "X-Czar-Approval-Confirm-Timeout-Seconds": "120",
      },
      body: JSON.stringify({
        items: [
          {
            planId: "pln_01J00000000000000000000001",
            objectiveId: "obj_01J00000000000000000000001",
            goal: "Submitted research",
            cap: "1000000",
            capDisplay: "$1.00",
            category: "research",
            stepCount: 1,
            createdAt: "2026-10-21T00:00:00Z",
            expiresAt: "2026-10-22T00:00:00Z",
            status: "submitted",
          },
          {
            planId: "pln_01J00000000000000000000002",
            objectiveId: "obj_01J00000000000000000000002",
            goal: "New research",
            cap: "2000000",
            capDisplay: "$2.00",
            category: "research",
            stepCount: 1,
            createdAt: "2026-10-21T00:00:00Z",
            expiresAt: "2026-10-22T00:00:00Z",
            status: "pending",
          },
        ],
        nextCursor: null,
      }),
    }),
  );
  await page.route("**/v1/ledger/receipts**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], nextCursor: null }),
    }),
  );

  await page.goto("/approvals");
  await expect(
    page.getByText("Approval sent. Waiting for the network to confirm it.").first(),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Submitted research" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "New research" })).toBeVisible();
  await expect(page).toHaveTitle("(1) Czar");

  await page.goto("/home");
  await expect(
    page.getByText("Approval sent. Waiting for the network to confirm it.").first(),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Submitted research" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "New research" })).toBeVisible();
});

test("approval review shows the plan path and payment details", async ({ page }) => {
  await page.route("**/v1/approvals?status=pending", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            planId: "pln_01J00000000000000000000000",
            objectiveId: "obj_01J00000000000000000000000",
            goal: "Research prices",
            cap: "1000000",
            capDisplay: "$1.00",
            category: "research",
            stepCount: 1,
            newPayees: 1,
            createdAt: "2026-10-21T00:00:00Z",
            expiresAt: "2026-10-22T00:00:00Z",
            status: "pending",
          },
        ],
        nextCursor: null,
      }),
    }),
  );
  await page.route("**/v1/approvals/pln_01J00000000000000000000000", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "X-Czar-Large-Cap-Warn-Bps": "5000" },
      body: JSON.stringify({
        schemaVersion: "1.2",
        planId: "pln_01J00000000000000000000000",
        objectiveId: "obj_01J00000000000000000000000",
        objectiveHash: `0x${"1".repeat(64)}`,
        planHash: `0x${"2".repeat(64)}`,
        network: "eip155:5042002",
        category: "research",
        cap: "1000000",
        slackBps: 0,
        maxStepAmount: "1000000",
        pocketCapBps: 0,
        expiresAt: "2026-10-22T00:00:00Z",
        steps: [
          {
            stepIndex: 0,
            stepId: "step-1",
            kind: "erc8183-job",
            capability: "web-search",
            payee: "0x0000000000000000000000000000000000000001",
            resource: { url: "https://prices.example/search", method: "GET" },
            unitAmount: "1000000",
            expectedCalls: 1,
            stepCap: "1000000",
            routingReason: "vault-direct",
            acceptanceProfileId: "json",
            contextNotice: "task-description-only",
            why: { fills: ["price"], summary: "It checked current prices.", alternativesLost: [] },
          },
        ],
        payeeLeaves: [
          {
            payee: "0x0000000000000000000000000000000000000001",
            kind: 2,
            stepIndex: 0,
            stepCap: "1000000",
          },
        ],
        payeeRoot: `0x${"3".repeat(64)}`,
        shadow: false,
        createdAt: "2026-10-21T00:00:00Z",
        taskSpec: {
          schemaVersion: "1.1",
          kind: "table-fill",
          topic: "vendor pricing",
          fileName: "budget.md",
          subjects: [{ label: "Vendor A", sourceLine: 12 }],
          fields: ["price"],
          sourceTrust: "user-file",
        },
      }),
    }),
  );
  await page.goto("/approve/pln_01J00000000000000000000000");
  await expect(
    page.getByText("Spend up to $1.00 (1000000 USDC) on “vendor pricing”"),
  ).toBeVisible();
  await expect(page.getByText("Payee: prices.example")).toBeVisible();
  await expect(page.getByText("New payee")).toBeVisible();
  await expect(page.getByText("Network fee: paid from your network fee reserve")).toBeVisible();
  await expect(page.getByText("Held in escrow, money back if rejected")).toBeVisible();
  await expect(
    page.getByText(
      "This job gets only the task description and up to 2,000 characters of context, no files.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve $1.00" })).toBeVisible();
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByRole("dialog")).toContainText("Decline this plan?");
  await page.getByRole("button", { name: "Confirm decline" }).click();
  await expect(page).toHaveURL(/\/approvals$/);
  await expect(page.getByText("Declined. Czar won't spend on this.")).toBeVisible();
});
