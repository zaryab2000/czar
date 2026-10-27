import { defineConfig, devices } from "@playwright/test";

const PORT = 3101;

export default defineConfig({
  testDir: "e2e",
  testMatch: "approval-performance.spec.ts",
  forbidOnly: true,
  retries: 0,
  workers: 1,
  projects: [
    {
      name: "chromium-desktop",
      use: {
        baseURL: `http://localhost:${PORT}`,
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "webkit-desktop",
      use: {
        baseURL: `http://localhost:${PORT}`,
        ...devices["Desktop Safari"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: `pnpm exec next start --hostname localhost --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
  },
});
