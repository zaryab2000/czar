import { expect, test, type Page } from "@playwright/test";

const objectiveId = "obj_01J00000000000000000000000";
const ratingIds = ["rtg_01J00000000000000000000000", "rtg_01J00000000000000000000001"];

async function stubAccount(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem("czar.appSession", "fixture-session");
    sessionStorage.setItem("czar.appSessionExpiresAt", "2099-01-01T00:00:00.000Z");
  });
  await page.route("**/v1/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        userId: "usr_01J00000000000000000000000",
        vaultCreated: true,
        mode: "controlled",
        balances: { free: "0", committed: "0", pocketOutstanding: "0", mscaBalance: "0" },
        limits: [],
        frozen: false,
        paused: false,
      }),
    }),
  );
  for (const path of ["approvals", "ledger/receipts", "pockets/manual-returns"]) {
    await page.route(`**/v1/${path}**`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      }),
    );
  }
}

async function stubRatings(page: Page, windowClosesAt = "2099-01-01T00:00:00.000Z") {
  const posted: { value: "good" | "bad"; supersedes?: string }[] = [];
  await page.route("**/v1/app/results?**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            objectiveId,
            deliveredAt: new Date().toISOString(),
            kind: "research",
            stepCount: 1,
            suppliers: [
              {
                stepIndex: 0,
                merchantLabel: "supplier.example",
                merchantIsCzar: false,
                receipts: 1,
                effectiveRating: posted.at(-1)?.value ?? "none",
                ...(posted.length > 0 ? { ratingId: ratingIds[posted.length - 1] } : {}),
                canRate: posted.length === 0 && Date.parse(windowClosesAt) > Date.now(),
                canCorrect: posted.length === 1 && Date.parse(windowClosesAt) > Date.now(),
              },
            ],
            windowClosesAt,
          },
        ],
        nextCursor: null,
      }),
    }),
  );
  await page.route("**/v1/app/ratings", async (route) => {
    const body = route.request().postDataJSON() as {
      value: "good" | "bad";
      supersedes?: string;
    };
    if (posted.length === 2) {
      await route.fulfill({ status: 422, body: JSON.stringify({ czarCode: "bad-supersedes" }) });
      return;
    }
    posted.push(body);
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        ratingId: ratingIds[posted.length - 1],
        objectiveId,
        stepIndex: 0,
        value: body.value,
        receipts: 1,
        windowClosesAt,
      }),
    });
  });
  return posted;
}

test("Receipts rates Good, changes to Bad, then offers no third rating", async ({ page }) => {
  await stubAccount(page);
  const posted = await stubRatings(page);
  await page.goto("/receipts");

  const card = page.getByRole("article", { name: `Result ${objectiveId}` });
  await expect(card.getByRole("button", { name: "Good" })).toBeVisible();
  await card.getByRole("button", { name: "Good" }).click();
  await expect(card.getByRole("button", { name: "Change" })).toBeVisible();
  await expect(
    card.getByText("Thanks. Czar will rank supplier.example higher for tasks like this."),
  ).toBeVisible();
  await card.getByRole("button", { name: "Change" }).click();
  await card.getByRole("button", { name: "Bad" }).click();
  await expect(
    card.getByText("Thanks. Czar will rank supplier.example lower for tasks like this."),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Change" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Good" })).toHaveCount(0);
  await expect(card.getByText("Rating closed")).toHaveCount(0);
  expect(posted).toEqual([
    { objectiveId, stepIndex: 0, value: "good" },
    { objectiveId, stepIndex: 0, value: "bad", supersedes: ratingIds[0] },
  ]);
});

test("Home shows only this week's results and the same rating control", async ({ page }) => {
  await stubAccount(page);
  await stubRatings(page);
  await page.goto("/home");

  const week = page.getByRole("region", { name: "This week" });
  await expect(week.getByText("Czar did 1 tasks this week. Rate any you looked at.")).toBeVisible();
  await expect(week.getByRole("button", { name: "Good" })).toBeVisible();
});

test("Home keeps balances and owner controls when results fail", async ({ page }) => {
  await stubAccount(page);
  await page.route("**/v1/app/results?**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({ detail: "Results are temporarily unavailable." }),
    }),
  );
  await page.goto("/home");

  await expect(page.getByRole("heading", { name: "Your Czar account" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Balances" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account controls" })).toBeVisible();
  const week = page.getByRole("region", { name: "This week" });
  await expect(week.getByRole("alert")).toBeVisible();
  await expect(week.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a lost rating response retries with the same idempotency key", async ({ page }) => {
  await stubAccount(page);
  const posted = await stubRatings(page);
  const keys: string[] = [];
  await page.route("**/v1/app/ratings", async (route) => {
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    if (keys.length === 1) {
      posted.push(route.request().postDataJSON() as { value: "good" | "bad" });
      await route.abort("failed");
      return;
    }
    if (keys[1] !== keys[0]) {
      await route.fulfill({
        status: 422,
        contentType: "application/problem+json",
        body: JSON.stringify({ detail: "A rating already exists.", czarCode: "supersedes-required" }),
      });
      return;
    }
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        ratingId: ratingIds[0],
        objectiveId,
        stepIndex: 0,
        value: "good",
        receipts: 1,
        windowClosesAt: "2099-01-01T00:00:00.000Z",
      }),
    });
  });
  await page.goto("/receipts");

  const card = page.getByRole("article", { name: `Result ${objectiveId}` });
  await card.getByRole("button", { name: "Good" }).click();
  await expect(card.getByRole("alert")).toBeVisible();
  await card.getByRole("button", { name: "Good" }).click();
  await expect(card.getByRole("button", { name: "Change" })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});

test("an expired result shows Rating closed without rating controls", async ({ page }) => {
  await stubAccount(page);
  await stubRatings(page, "2026-10-01T00:00:00.000Z");
  await page.goto("/receipts");

  const card = page.getByRole("article", { name: `Result ${objectiveId}` });
  await expect(card.getByText("Rating closed")).toBeVisible();
  await expect(card.getByRole("button", { name: "Good" })).toHaveCount(0);
});
