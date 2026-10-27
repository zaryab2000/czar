import { defineConfig } from "vitest/config";

// The arc-anvil integration test deploys the contracts and needs minutes, not the default 5 s (07 PRD 14 §9).
const INTEGRATION_TIMEOUT_MS = 600_000;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: INTEGRATION_TIMEOUT_MS,
    hookTimeout: INTEGRATION_TIMEOUT_MS,
  },
});
