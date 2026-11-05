import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "#server-social-templates": fileURLToPath(
        new URL("../server/src/social/runtime/templates.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["packages/**/*.test.ts", "packages/**/test/**/*.test.ts"] },
});
