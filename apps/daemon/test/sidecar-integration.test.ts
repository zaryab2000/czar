// T-064 end to end: the daemon's supervisor starts the real bundled helper (CZAR_TEST_SIDECAR_CMD,
// built by scripts/bundle-redact-sidecar.sh in CI) and layer 2 returns Presidio markers; with the helper
// stopped, the regex fallback runs and forces review (D45). Skipped when no bundle is given.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sidecarLayer2Client } from "@czar/redaction";
import { SidecarSupervisor } from "@czar/daemon/sidecar";
import { tempDir } from "./support.ts";

const command = process.env["CZAR_TEST_SIDECAR_CMD"] ?? "";

describe.skipIf(command === "")("bundled czar-redact helper", () => {
  it("redacts names and contact details, then falls back with forced review once stopped", async () => {
    const socketPath = join(tempDir("czar-real-"), "czar-redact.sock");
    const supervisor = new SidecarSupervisor({
      command,
      socketPath,
      // Empty environment: the bundle must not depend on a system Python or PATH.
      spawn: (program, args) => spawn(program, [...args], { stdio: "ignore", env: {} }),
      idleMs: 600_000,
      startTimeoutMs: 120_000,
    });
    const client = sidecarLayer2Client({
      socketPath,
      timeoutMs: 30_000,
      ensureRunning: () => supervisor.ensureRunning(),
    });
    try {
      const result = await client.redact(
        "Ask Jonathan Whitaker at jw@example.org or 415-555-0142",
        { language: "en" },
      );
      expect(result.forcedReview).toBe(false);
      expect(result.text).not.toContain("Jonathan Whitaker");
      expect(result.text).not.toContain("jw@example.org");
      expect(result.text).toContain("[[R:P:PERSON#1]]");
    } finally {
      await supervisor.stop();
    }
    const offline = sidecarLayer2Client({ socketPath, timeoutMs: 500 });
    const fallback = await offline.redact("mail jw@example.org", { language: "en" });
    expect(fallback).toEqual({
      text: "mail [[R:P:EMAIL_ADDRESS#1]]",
      entities: [{ type: "EMAIL_ADDRESS", count: 1 }],
      forcedReview: true,
    });
  }, 240_000);
});
