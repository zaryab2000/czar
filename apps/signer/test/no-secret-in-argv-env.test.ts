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

// PM-017: the same rule for the cloud entry point. It holds no keystore and no passphrase, but it must
// still refuse to start when its arguments or environment could be carrying a secret (D70, D78), and it
// must never put one there itself.
const CLOUD_MAIN = resolve(import.meta.dirname, "../src/cloud-main.ts");

function runCloudMain(env: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", CLOUD_MAIN],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const snapshot = () => {
    const pid = String(child.pid);
    let argsLine = "";
    let environ = "";
    try {
      argsLine = execFileSync("ps", ["-o", "args=", "-p", pid]).toString();
    } catch {
      // The process already exited; the startup check below still covers the refusal.
    }
    try {
      environ = readFileSync(`/proc/${pid}/environ`, "utf8").replaceAll("\0", "\n");
    } catch {
      // macOS has no /proc.
    }
    return { argsLine, environ };
  };
  const done = new Promise<number>((ok) => child.on("exit", (code) => ok(code ?? -1)));
  return { snapshot, done, output: () => ({ stdout, stderr }) };
}

describe("no secret in argv or env: the signer cloud entry (PM-017)", () => {
  it("carries no secret-looking argument or variable while it runs", async () => {
    const proc = runCloudMain({ ...cleanEnv(), CZAR_CLOUD_CONFIG: "/nonexistent/cloud.toml" });
    const { argsLine, environ } = proc.snapshot();
    await proc.done;
    if (argsLine !== "") {
      expect(argsLine).toContain("cloud-main.ts");
      expect(argsLine).not.toMatch(SECRETISH);
    }
    for (const line of environ.split("\n")) {
      const name = line.split("=")[0] ?? "";
      expect(name).not.toMatch(/PASSPHRASE|MNEMONIC/i);
      expect(name.startsWith("CZAR_") && SECRETISH.test(name)).toBe(false);
    }
  }, 30_000);

  it("refuses to start when the environment carries a CZAR_SIGNER_PASSPHRASE-style variable", async () => {
    const proc = runCloudMain({
      ...cleanEnv(),
      CZAR_CLOUD_CONFIG: "/nonexistent/cloud.toml",
      CZAR_SIGNER_PASSPHRASE: "not-a-real-value",
    });
    expect(await proc.done).not.toBe(0);
    expect(proc.output().stderr).toMatch(/looks like a secret/);
    expect(proc.output().stderr).not.toContain("not-a-real-value");
  }, 30_000);

  it("refuses to start without its config pointer, naming the pointer only", async () => {
    const proc = runCloudMain(cleanEnv());
    expect(await proc.done).not.toBe(0);
    expect(proc.output().stderr).toContain("CZAR_CLOUD_CONFIG");
  }, 30_000);
});
