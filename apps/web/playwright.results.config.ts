import { defineConfig, devices } from "@playwright/test";

const port = 3107;

export default defineConfig({
  testDir: "e2e-results",
  forbidOnly: true,
  retries: 0,
  use: { baseURL: `http://127.0.0.1:${port}` },
  projects: [{ name: "chromium-desktop", use: devices["Desktop Chrome"] }],
  webServer: {
    command: `pnpm exec next dev --webpack --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    env: { NEXT_TELEMETRY_DISABLED: "1", CZAR_SERVER_URL: "http://127.0.0.1:4310" },
  },
});
