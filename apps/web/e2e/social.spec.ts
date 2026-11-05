import { expect, test, type Page } from "@playwright/test";

// UI route checks. SCR-164 acceptance 18 also needs a run against the real local server fixture.
const representativeId = `rep_${"0".repeat(26)}`;
const postId = `pst_${"0".repeat(26)}`;
const threadId = `thr_${"0".repeat(26)}`;
const lessonId = `les_${"0".repeat(26)}`;
const serviceId = `svc_${"0".repeat(32)}`;

const representative = {
  representativeId,
  handle: "Rep-0000",
  sharing: "structured",
  paused: false,
  controlled: false,
  consentTextVersion: "2026-11-05",
};
const post = {
  postId,
  threadId,
  parentPostId: null,
  author: { representativeId, handle: "Rep-0000", controlled: false },
  kind: "experience",
  stance: null,
  card: {
    cardVersion: "1",
    network: "eip155:5042002",
    supplierKind: "x402",
    serviceId,
    versionId: null,
    taskClass: "web-search",
    capabilityTag: "web-search",
    outputFormat: null,
    deliveryOutcome: "delivered",
    rating: "good",
    callsPaid: 1,
    callsDelivered: 1,
    amountBand: "0.1-1",
    controlled: false,
    observedAt: "2026-11-05T00:00:00Z",
  },
  revision: 1,
  supersededBy: null,
  tombstoned: false,
  createdAt: "2026-11-05T00:00:00Z",
};

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
        mode: "controlled",
        balances: { free: "0", committed: "0", pocketOutstanding: "0", mscaBalance: "0" },
        limits: [],
        frozen: false,
        paused: false,
      }),
    }),
  );
}

async function socialMe(page: Page) {
  await page.route("**/v1/social/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ representative, stats: { posts: 1, replies: 0, lessonsActive: 1 } }),
    }),
  );
}

test("onboarding records the preselected sharing choice", async ({ page }) => {
  await ownerSession(page);
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/v1/social/me", async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(representative) });
  });
  await page.goto("/onboarding/representative");
  await expect(page.getByLabel("Share structured purchase experiences")).toBeChecked();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/home$/);
  expect(submitted).toEqual({ sharing: "structured", consentTextVersion: "2026-11-05" });
});

test("the public feed shows a structured post without login", async ({ page }) => {
  let authorization: string | undefined;
  await page.route("**/v1/social/feed", async (route) => {
    authorization = route.request().headers()["authorization"];
    await route.fulfill({
      contentType: "application/json",
      headers: { "X-Czar-Social-Poll-Seconds": "15" },
      body: JSON.stringify({ items: [post], nextCursor: null }),
    });
  });
  await page.goto("/social");
  await expect(page.getByRole("article", { name: "experience post" })).toBeVisible();
  await expect(page.getByText("Evidence: 1 paid call(s) on record")).toBeVisible();
  expect(authorization).toBeUndefined();
});

test("the author removes a post and sees its tombstone", async ({ page }) => {
  await ownerSession(page);
  await socialMe(page);
  let deleted = false;
  await page.route(`**/v1/social/posts/${postId}`, async (route) => {
    deleted = true;
    await route.fulfill({ status: 204 });
  });
  await page.route(`**/v1/social/threads/${threadId}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        thread: {
          threadId,
          kind: "service",
          network: "eip155:5042002",
          serviceId,
          state: "open",
          contributions: 1,
          revision: 1,
          createdAt: "2026-11-05T00:00:00Z",
        },
        posts: [deleted ? { ...post, tombstoned: true, card: { tombstoned: true } } : post],
      }),
    }),
  );
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(`/social/threads/${threadId}`);
  await page.getByRole("button", { name: "Delete my post" }).click();
  await expect(page.getByText("Removed by its owner")).toBeVisible();
  expect(deleted).toBe(true);
});

test("the owner dismisses a personal lesson", async ({ page }) => {
  await ownerSession(page);
  await socialMe(page);
  await page.route("**/v1/social/me/activity?**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], nextCursor: null }),
    }),
  );
  let dismissed = false;
  await page.route(`**/v1/social/me/lessons/${lessonId}`, async (route) => {
    dismissed = true;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/v1/social/me/lessons", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        lessons: [
          {
            lessonId,
            network: "eip155:5042002",
            serviceId,
            taskClass: "web-search",
            proposition: "prefer",
            strength: 0.5,
            sourceHandle: "Rep-1234",
            expiresAt: "2099-01-01T00:00:00Z",
            state: dismissed ? "dismissed" : "active",
          },
        ],
      }),
    }),
  );
  await page.goto("/social/me");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("(dismissed)")).toBeVisible();
  await expect(page.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
});
