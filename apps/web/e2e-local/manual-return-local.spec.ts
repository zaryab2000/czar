// SCR-150 §5 run 6 (SCR-146 §3.3): the manual-return UI (SCR-133, CZ-22 §12 wording) served by
// the real server route `GET /v1/pockets/manual-returns` with AppSession auth. That route is never
// stubbed, and neither is `/v1/me`: it reads the CzarVaultFactory and vaults the fixture deploys
// on the run 6 arc-anvil with contracts/script/deploy.sh.
import { expect, test, type Page } from "@playwright/test";
import { keccak256, type Address } from "viem";
import { czarVaultFactoryAbi } from "@czar/vault-client";
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

async function vaults(): Promise<Record<string, string>> {
  return RUN6.deployedVaults(RUN6.readDeployment().factory);
}

async function vaultFor(msca: string): Promise<string> {
  const vault = (await vaults())[msca];
  if (vault === undefined) throw new Error(`No predicted vault for seeded owner ${msca}.`);
  return vault;
}

test("the vault factory is the deployed CzarVaultFactory", async () => {
  const { factory, factoryRuntimeHash } = RUN6.readDeployment();
  const code = await RUN6.chainClient.getCode({ address: factory });
  expect(code === undefined ? undefined : keccak256(code)).toBe(factoryRuntimeHash);

  const predicted = await vaults();
  expect(new Set(Object.values(predicted)).size).toBe(3);
  for (const owner of [RUN6.ownerA, RUN6.ownerB]) {
    const created = await RUN6.chainClient.readContract({
      address: factory,
      abi: czarVaultFactoryAbi,
      functionName: "vaultOf",
      args: [owner.msca as Address],
    });
    expect(created.toLowerCase()).toBe(predicted[owner.msca]);
  }
});

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
  const vaultA = await vaultFor(RUN6.ownerA.msca);
  expect(body.items.every((item) => item.vault === vaultA)).toBe(true);
});

test("Home shows the count of returns waiting to be recorded", async ({ page }) => {
  await signIn(page, token("CZAR_RUN6_TOKEN_A"));
  const me = page.waitForResponse(
    (response) => response.url().endsWith("/v1/me") && response.request().method() === "GET",
  );
  const manualReturns = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/pockets/manual-returns") &&
      response.request().method() === "GET",
  );
  await page.goto("/home");
  const meResponse = await me;
  expect(meResponse.status()).toBe(200);
  const meBody = (await meResponse.json()) as { vault: string; vaultCreated: boolean };
  expect({ vault: meBody.vault.toLowerCase(), vaultCreated: meBody.vaultCreated }).toEqual({
    vault: await vaultFor(RUN6.ownerA.msca),
    vaultCreated: true,
  });
  expect((await manualReturns).status()).toBe(200);
  // Owner A has two rows in manual-return-required; the other user's rows are not counted.
  await expect(page.getByText("2 pocket returns to record")).toBeVisible({ timeout: 20_000 });
});

test("the envelope shows pending, recorded and expired returns with CZ-22 wording", async ({
  page,
}) => {
  await signIn(page, token("CZAR_RUN6_TOKEN_B"));
  const envelopeRef = RUN6.envelopeRef(await vaultFor(RUN6.ownerB.msca), 1);
  await page.goto(`/envelopes/${encodeURIComponent(envelopeRef)}`);

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
