// T-080: the app loads and routes in desktop Safari and Chrome (WebKit and Chromium at a desktop viewport).
import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
// Local runs may point Chromium at a preinstalled browser; CI installs both engines.
const chromiumPath = process.env["CZAR_CHROMIUM_PATH"];

export default defineConfig({
  testDir: "e2e",
  forbidOnly: true,
  retries: 0,
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: DESKTOP_VIEWPORT,
        ...(chromiumPath === undefined ? {} : { launchOptions: { executablePath: chromiumPath } }),
      },
    },
    { name: "webkit-desktop", use: { ...devices["Desktop Safari"], viewport: DESKTOP_VIEWPORT } },
  ],
  webServer: [
    {
      command: "node e2e/mock-bundler.mjs",
      url: "http://127.0.0.1:4337/health",
      reuseExistingServer: false,
      env: { CZAR_ARC_RPC_URL: "http://127.0.0.1:8549" },
    },
    {
      command:
        "node --experimental-strip-types --disable-warning=ExperimentalWarning e2e/indexer-fixture.mjs",
      url: "http://127.0.0.1:42070/health",
      reuseExistingServer: false,
      env: {
        CZAR_ARC_RPC_URL: "http://127.0.0.1:8549",
      },
    },
    {
      command:
        "node --experimental-strip-types --disable-warning=ExperimentalWarning e2e/server-fixture.mjs",
      url: "http://127.0.0.1:4310/health",
      reuseExistingServer: false,
      env: {
        CZAR_ARC_RPC_URL: "http://127.0.0.1:8549",
        CZAR_INDEXER_URL: "http://127.0.0.1:42070",
      },
    },
    {
      command: `pnpm exec next start --hostname localhost --port ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: false,
      env: {
        NEXT_TELEMETRY_DISABLED: "1",
        CZAR_SERVER_URL: "http://127.0.0.1:4310",
      },
    },
  ],
});
