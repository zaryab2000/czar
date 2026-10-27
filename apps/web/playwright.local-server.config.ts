// SCR-150 §5 run 6: the manual-return UI against the real local server, with no route stub.
// Run: pnpm --filter @czar/web e2e:local-server (needs Postgres on 127.0.0.1:15432 and the
// pinned arc-anvil on PATH or in CZAR_ARC_ANVIL_BIN).
import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import { RUN6 } from "./e2e-local/run6-data.ts";

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const chromiumPath = process.env["CZAR_CHROMIUM_PATH"];
const arcAnvil = process.env["CZAR_ARC_ANVIL_BIN"] ?? "arc-anvil";

// One session token per seeded owner, shared with the spec through the worker environment.
process.env["CZAR_RUN6_TOKEN_A"] ??= randomBytes(32).toString("base64url");
process.env["CZAR_RUN6_TOKEN_B"] ??= randomBytes(32).toString("base64url");

export default defineConfig({
  testDir: "e2e-local",
  forbidOnly: true,
  retries: 0,
  workers: 1,
  use: { baseURL: RUN6.webOrigin },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: DESKTOP_VIEWPORT,
        ...(chromiumPath === undefined ? {} : { launchOptions: { executablePath: chromiumPath } }),
      },
    },
  ],
  webServer: [
    {
      command: `${arcAnvil} --network arc --host 127.0.0.1 --port ${RUN6.anvilPort} --silent`,
      port: RUN6.anvilPort,
      reuseExistingServer: false,
    },
    {
      command:
        "node --experimental-strip-types --disable-warning=ExperimentalWarning e2e-local/local-server-fixture.mjs",
      url: `http://127.0.0.1:${RUN6.serverPort}/health`,
      reuseExistingServer: false,
      env: {
        CZAR_RUN6_TOKEN_A: process.env["CZAR_RUN6_TOKEN_A"],
        CZAR_RUN6_TOKEN_B: process.env["CZAR_RUN6_TOKEN_B"],
      },
    },
    {
      command: `pnpm exec next start --hostname localhost --port ${RUN6.webPort}`,
      url: RUN6.webOrigin,
      reuseExistingServer: false,
      env: {
        NEXT_TELEMETRY_DISABLED: "1",
        PORT: String(RUN6.webPort),
        CZAR_SERVER_URL: `http://127.0.0.1:${RUN6.serverPort}`,
      },
    },
  ],
});
