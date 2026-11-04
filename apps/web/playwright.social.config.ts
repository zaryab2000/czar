import { defineConfig, devices } from "@playwright/test";

const chromiumPath = process.env["CZAR_CHROMIUM_PATH"];

// The social round trip uses a disposable database and no wallet, bundler, or Arc process.
export default defineConfig({
  testDir: "e2e",
  testMatch: "social-real.spec.ts",
  forbidOnly: true,
  retries: 0,
  use: { baseURL: "http://localhost:3100" },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        ...(chromiumPath === undefined ? {} : { launchOptions: { executablePath: chromiumPath } }),
      },
    },
  ],
  webServer: [
    {
      command:
        "node --experimental-strip-types --disable-warning=ExperimentalWarning e2e/server-fixture.mjs",
      url: "http://127.0.0.1:4310/health",
      reuseExistingServer: false,
      env: {
        CZAR_SOCIAL_E2E_FIXTURE: "1",
        CZAR_APP_CIRCLE_CLIENT_URL: "http://127.0.0.1:4337",
        CZAR_APP_CIRCLE_CLIENT_KEY: "e2e-public-client-key",
        CZAR_APP_ARC_RPC_URL: "http://127.0.0.1:8549",
      },
    },
    {
      command: "pnpm exec next start --hostname localhost --port 3100",
      url: "http://localhost:3100",
      reuseExistingServer: false,
      env: {
        NEXT_TELEMETRY_DISABLED: "1",
        PORT: "3100",
        CZAR_SERVER_URL: "http://127.0.0.1:4310",
      },
    },
  ],
});
