import { expect, test } from "@playwright/test";

test("loads the app shell at /", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("Czar");
  await expect(page.locator("header")).toContainText("Czar");
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
