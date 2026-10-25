import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("owner issues a pairing code, lists a paired device, then revokes it", async ({
  page,
  browserName,
}) => {
  test.setTimeout(60_000);
  test.skip(browserName !== "chromium", "Playwright CDP virtual authenticator requires Chromium.");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });

  await page.goto("/onboarding/passkey");
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(
    page.getByText("Passkey created. Your Czar account is ready to set up."),
  ).toBeVisible({
    timeout: 20_000,
  });
  await page.goto("/settings/privacy");
  await page.getByRole("link", { name: "Manage paired devices" }).click();
  await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pair a computer" }).click();
  const codeMessage = page.getByText(/Enter this code in Czar on your computer:/);
  await expect(codeMessage).toBeVisible();
  const code = (await codeMessage.innerText()).match(/\b\d{8}\b/)?.[0];
  expect(code).toMatch(/^\d{8}$/);

  const paired = await page.request.post("http://127.0.0.1:4310/v1/devices/pair", {
    headers: { "Idempotency-Key": randomUUID() },
    data: { pairingCode: code, deviceName: "E2E desktop", platform: "macos" },
  });
  expect(paired.status()).toBe(201);
  const pairResponse = (await paired.json()) as { deviceId: string; deviceToken: string };
  await page.getByRole("button", { name: "Refresh devices" }).click();
  await expect(page.getByRole("heading", { name: "E2E desktop" })).toBeVisible();
  await page.getByRole("button", { name: "Revoke E2E desktop" }).click();
  await expect(
    page.getByRole("alertdialog").getByText("Stop E2E desktop from sending work to Czar?"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  const revokedToken = await page.request.get("http://127.0.0.1:4310/v1/objectives", {
    headers: { Authorization: `Bearer ${pairResponse.deviceToken}` },
  });
  expect(revokedToken.status()).toBe(401);
  await expect(revokedToken.json()).resolves.toMatchObject({ czarCode: "device-revoked" });
  await cdp.detach();
});
