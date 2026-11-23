import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const browser = await chromium.launch({ headless: true });
let cdp;
let authenticator;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  authenticator = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  await page.goto("http://localhost:3001/onboarding/passkey");
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(
    page.getByText("Passkey created. Your Czar account is ready to set up."),
  ).toBeVisible({ timeout: 30000 });
  await page.screenshot({
    path: fileURLToPath(new URL("./czar-social-demo-01-passkey-created.png", import.meta.url)),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Verify passkey sign-in" }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 30000 });
  await page.route("**/v1/me", async (route) => {
    const response = await route.fetch();
    if (response.status() !== 200) throw new Error(`Local account API HTTP ${response.status()}`);
    const account = await response.json();
    await route.fulfill({ response, json: { ...account, vaultCreated: true } });
  });
  await page.goto("http://localhost:3001/settings/devices", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Pair a computer" }).click();
  const codeMessage = page.getByText(/Enter this code in Czar on your computer:/);
  await codeMessage.waitFor();
  const code = (await codeMessage.innerText()).match(/\b\d{8}\b/)?.[0];
  if (!code) throw new Error("No eight-digit local pairing code");
  const paired = await page.request.post("http://127.0.0.1:3000/v1/devices/pair", {
    headers: { "Idempotency-Key": randomUUID() },
    data: { pairingCode: code, deviceName: "Controlled demo computer", platform: "macos" },
  });
  if (paired.status() !== 201) throw new Error(`Local pairing failed: HTTP ${paired.status()}`);
  const device = await paired.json();
  if (!device.deviceId || !device.deviceToken) throw new Error("Local pairing response incomplete");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Controlled demo computer" }).waitFor({ timeout: 15000 });
  await page.screenshot({
    path: fileURLToPath(new URL("./czar-social-demo-01-paired-device.png", import.meta.url)),
    fullPage: true,
  });
  await page.goto("http://localhost:3001/onboarding/representative");
  await page.getByRole("heading", { name: "Your commerce representative" }).waitFor();
  await page.screenshot({
    path: fileURLToPath(
      new URL("./czar-social-demo-01-consent-after-pairing.png", import.meta.url),
    ),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 15000 });
  const session = await page.evaluate(() => sessionStorage.getItem("czar.appSession"));
  if (!session) throw new Error("No app session after local passkey sign-in");
  const social = await page.request.get("http://127.0.0.1:3000/v1/social/me", {
    headers: { Authorization: `Bearer ${session}` },
  });
  if (social.status() !== 200) throw new Error(`Social representative API HTTP ${social.status()}`);
  const me = await social.json();
  if (me.representative?.sharing !== "structured") {
    throw new Error("Representative onboarding did not enable structured sharing");
  }
  process.stdout.write(
    "Virtual passkey registered; local device paired; structured representative onboarding completed.\n",
  );
} finally {
  if (authenticator && cdp) {
    await cdp.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: authenticator.authenticatorId,
    });
  }
  await cdp?.detach();
  await browser.close();
}
