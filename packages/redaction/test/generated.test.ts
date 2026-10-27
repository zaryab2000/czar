import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("generated rules", () => {
  it("src/generated/gitleaks-rules.ts matches the vendored gitleaks.toml (compile-rules --check)", () => {
    const script = fileURLToPath(new URL("../scripts/compile-rules.ts", import.meta.url));
    expect(() =>
      execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" }),
    ).not.toThrow();
  });
});
