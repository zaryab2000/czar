import { expect, test } from "@playwright/test";

// The server fixture seeds a fresh, disposable database when this flag is set.
test.skip(process.env["CZAR_SOCIAL_E2E_FIXTURE"] !== "1", "Requires the local social fixture");
test.afterEach(async ({ request }) => {
  const cleanup = await request.post("http://127.0.0.1:4310/__e2e/dispose");
  expect(cleanup.status()).toBe(204);
});

const threadId = `thr_${"1".repeat(26)}`;
const serviceId = `svc_${"1".repeat(32)}`;
const token = Buffer.alloc(32, 19).toString("base64url");

test("controlled social round trip uses the real local server", async ({ page }) => {
  await page.addInitScript((sessionToken) => {
    sessionStorage.setItem("czar.appSession", sessionToken);
    sessionStorage.setItem("czar.appSessionExpiresAt", "2099-01-01T00:00:00.000Z");
  }, token);

  // The account summary needs Arc RPC; all social requests use the real createApp and database.
  await page.route("**/v1/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ network: "eip155:5042002" }),
    }),
  );

  await page.goto("/onboarding/representative");
  await expect(page.getByLabel("Share structured purchase experiences")).toBeChecked();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/home$/);

  const ownerResponse = await page.request.get("/v1/social/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(ownerResponse.status()).toBe(200);
  const owner = (await ownerResponse.json()) as { representative: { sharing: string } };
  expect(owner.representative.sharing).toBe("structured");

  let publicAuth: string | undefined;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/social/feed") {
      publicAuth = request.headers()["authorization"];
    }
  });
  await page.goto("/social");
  await expect(page.getByRole("article", { name: "experience post" })).toBeVisible();
  await expect(page.getByText("Evidence: 1 paid call(s) on record")).toBeVisible();
  await expect(page.getByText("Controlled representative")).toBeVisible();
  expect(publicAuth).toBeUndefined();

  await page.goto("/social/me");
  await expect(page.getByText(`Rep-1111: prefer ${serviceId} for web-search`)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("(dismissed)")).toBeVisible();

  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(`/social/threads/${threadId}`);
  await expect(page.getByRole("button", { name: "Delete my post" })).toBeVisible();
  await page.getByRole("button", { name: "Delete my post" }).click();
  await expect(page.getByText("Removed by its owner")).toBeVisible();
  const threadResponse = await page.request.get(`/v1/social/threads/${threadId}`);
  expect(threadResponse.status()).toBe(200);
  const thread = (await threadResponse.json()) as { posts: { tombstoned: boolean }[] };
  expect(thread.posts[0]?.tombstoned).toBe(true);
});
