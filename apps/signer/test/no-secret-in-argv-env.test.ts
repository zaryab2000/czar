// T-105 acceptance: the key-creation process carries no passphrase in its arguments or environment.
// Spawns the script in dry-run mode and reads its argv and environment while it runs.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "../scripts/create-keys.ts");
const SECRETISH = /passphrase|password|mnemonic|private|secret|seed/i;

function run(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const snapshot = () => {
    const pid = String(child.pid);
    const argsLine = execFileSync("ps", ["-o", "args=", "-p", pid]).toString();
    let environ = "";
    try {
      environ = readFileSync(`/proc/${pid}/environ`, "utf8").replaceAll("\0", "\n");
    } catch {
      // macOS has no /proc; the script's own startup check covers the environment there.
    }
    return { argsLine, environ };
  };
  const done = new Promise<number>((ok) => child.on("exit", (code) => ok(code ?? -1)));
  return { snapshot, done, output: () => ({ stdout, stderr }) };
}

const cleanEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "LANG", "TMPDIR"])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
};

describe("no secret in argv or env (T-105)", () => {
  it("the running key-creation process has no passphrase in ps args or its environment", async () => {
    const proc = run(["--dry-run"], cleanEnv());
    const { argsLine, environ } = proc.snapshot();
    const code = await proc.done;
    expect(code, proc.output().stderr).toBe(0);
    expect(argsLine).toContain("create-keys.ts");
    expect(argsLine).not.toMatch(SECRETISH);
    for (const line of environ.split("\n")) {
      const name = line.split("=")[0] ?? "";
      expect(name).not.toMatch(/PASSPHRASE|MNEMONIC/i);
      expect(name.startsWith("CZAR_") && SECRETISH.test(name)).toBe(false);
    }
    expect(proc.output().stdout).toMatch(/^DRY RUN/);
  }, 30_000);

  it("refuses to run when the environment carries a CZAR_SIGNER_PASSPHRASE-style variable", async () => {
    const proc = run(["--dry-run"], { ...cleanEnv(), CZAR_SIGNER_PASSPHRASE: "not-a-real-value" });
    expect(await proc.done).toBe(1);
    expect(proc.output().stderr).toMatch(/looks like a secret/);
    expect(proc.output().stderr).not.toContain("not-a-real-value");
  }, 30_000);

  it("refuses any argument other than --dry-run", async () => {
    const proc = run(["--passphrase", "x"], cleanEnv());
    expect(await proc.done).not.toBe(0);
  }, 30_000);
});
