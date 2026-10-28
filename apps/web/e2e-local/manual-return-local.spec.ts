// SCR-150 §5 run 6 (SCR-146 §3.3): the manual-return UI (SCR-133, CZ-22 §12 wording) served by
// the real server route `GET /v1/pockets/manual-returns` with AppSession auth. That route is never
// stubbed. The Home test answers only `/v1/me` (a chain-state mirror; see the test comment).
import { expect, test, type Page } from "@playwright/test";
import { RUN6 } from "./run6-data.ts";

const SERVER = `http://127.0.0.1:${RUN6.serverPort}`;

function token(name: "CZAR_RUN6_TOKEN_A" | "CZAR_RUN6_TOKEN_B"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run with playwright.local-server.config.ts.`);
  return value;
}

async function signIn(page: Page, sessionToken: string): Promise<void> {
  const expiresAt = new Date(Date.now() + RUN6.sessionMinutes * 60_000).toISOString();
  await page.addInitScript(
    ([value, expiry]) => {
      sessionStorage.setItem("czar.appSession", value);
      sessionStorage.setItem("czar.appSessionExpiresAt", expiry);
    },
    [sessionToken, expiresAt] as const,
  );
}

test("the route is AppSession-only and scoped to the signed-in owner", async ({ request }) => {
  const anonymous = await request.get(`${SERVER}/v1/pockets/manual-returns`);
  expect(anonymous.status()).toBe(401);

  const response = await request.get(`${SERVER}/v1/pockets/manual-returns`, {
    headers: { Authorization: `Bearer ${token("CZAR_RUN6_TOKEN_A")}` },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: { returnTx: string; vault: string }[] };
  expect(body.items.map((item) => item.returnTx).toSorted()).toEqual(
    RUN6.ownerA.manualReturns.map((row) => row.returnTx).toSorted(),
  );
  expect(body.items.every((item) => item.vault === RUN6.ownerA.vault)).toBe(true);
});

test("Home shows the count of returns waiting to be recorded", async ({ page }) => {
  await signIn(page, token("CZAR_RUN6_TOKEN_A"));
  // Only /v1/me is answered here: it mirrors on-chain vault state, which needs deployed Czar
  // contracts that this hermetic run does not have. The manual-returns route stays real.
  await page.route("**/v1/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        userId: RUN6.ownerA.userId,
        msca: RUN6.ownerA.msca,
        vault: RUN6.ownerA.vault,
        vaultCreated: true,
        network: RUN6.network,
        mode: "live",
        balances: {
          vaultBalance: "0",
          free: "0",
          committed: "0",
          mscaBalance: "0",
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
  const manualReturns = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/pockets/manual-returns") &&
      response.request().method() === "GET",
  );
  await page.goto("/home");
  expect((await manualReturns).status()).toBe(200);
  // Owner A has two rows in manual-return-required; the other user's rows are not counted.
  await expect(page.getByText("2 pocket returns to record")).toBeVisible({ timeout: 20_000 });
});

test("the envelope shows pending, recorded and expired returns with CZ-22 wording", async ({
  page,
}) => {
  await signIn(page, token("CZAR_RUN6_TOKEN_B"));
  await page.goto(`/envelopes/${encodeURIComponent(RUN6.ownerB.envelopeRef)}`);

  await expect(page.getByRole("heading", { name: "Money to record" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByText(
      "$1.234 came back from a pocket wallet by the slow 7-day route. Record it so your vault's books match.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Record $1.234" })).toBeEnabled();
  await expect(page.getByText("Recorded $1.80")).toBeVisible();
  await expect(
    page.getByText(
      "This pocket closed before the return was recorded. The money is already in your vault.",
    ),
  ).toBeVisible();
  // Another user's return on the same envelope reference never appears.
  await expect(page.getByText("$9.876", { exact: false })).toHaveCount(0);
});
