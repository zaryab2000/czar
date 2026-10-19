import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sidecarLayer2Client } from "@czar/redaction";
import {
  RESTARTS_PER_MINUTE,
  SidecarSupervisor,
  SidecarUnavailableError,
} from "@czar/daemon/sidecar";
import { tempDir } from "./support.ts";

const supervisors: SidecarSupervisor[] = [];
afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop();
});

// A stand-in helper: a tiny Node process that serves analyze_anonymize on the given socket.
const FAKE_HELPER = `
const net = require("node:net");
const path = process.argv[process.argv.indexOf("--socket") + 1];
net.createServer((s) => { s.setEncoding("utf8"); s.on("data", (f) => {
  const r = JSON.parse(f); s.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: { text: "[[R:P:PERSON#1]]", entities: [{ type: "PERSON", count: 1 }] } }) + "\\n");
}); }).listen(path);
`;

const crashing = () => spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });

function fakeSpawn(spawned: ChildProcess[]) {
  return (_command: string, args: readonly string[]) => {
    const child = spawn(process.execPath, ["-e", FAKE_HELPER, "--", ...args], { stdio: "ignore" });
    spawned.push(child);
    return child;
  };
}

describe("sidecar supervisor", () => {
  it("starts the helper lazily on the first call and serves layer 2", async () => {
    const spawned: ChildProcess[] = [];
    const socketPath = join(tempDir("czar-sc-"), "czar-redact.sock");
    const supervisor = new SidecarSupervisor({
      command: "czar-redact",
      socketPath,
      spawn: fakeSpawn(spawned),
      idleMs: 60_000,
      startTimeoutMs: 5000,
    });
    supervisors.push(supervisor);
    expect(spawned).toHaveLength(0);
    const client = sidecarLayer2Client({
      socketPath,
      timeoutMs: 2000,
      ensureRunning: () => supervisor.ensureRunning(),
    });
    const result = await client.redact("Ada Lovelace", { language: "en" });
    expect(result).toMatchObject({ text: "[[R:P:PERSON#1]]", forcedReview: false });
    expect(spawned).toHaveLength(1);
    await client.redact("again", { language: "en" });
    expect(spawned).toHaveLength(1);
  });

  it("stops after the idle period", async () => {
    const socketPath = join(tempDir("czar-sc-"), "czar-redact.sock");
    const supervisor = new SidecarSupervisor({
      command: "x",
      socketPath,
      spawn: fakeSpawn([]),
      idleMs: 200,
      startTimeoutMs: 5000,
    });
    supervisors.push(supervisor);
    await supervisor.ensureRunning();
    expect(supervisor.running).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(supervisor.running).toBe(false);
    // Start-up may take up to startTimeoutMs on a loaded machine; leave room above it.
  }, 15_000);

  it("falls back with forced review when the helper cannot start, and caps restarts at 5 a minute", async () => {
    const socketPath = join(tempDir("czar-sc-"), "czar-redact.sock");
    let clock = 0;
    const supervisor = new SidecarSupervisor({
      command: "x",
      socketPath,
      spawn: crashing,
      idleMs: 60_000,
      startTimeoutMs: 2000,
      now: () => clock,
    });
    supervisors.push(supervisor);
    const client = sidecarLayer2Client({
      socketPath,
      timeoutMs: 500,
      ensureRunning: () => supervisor.ensureRunning(),
    });
    expect((await client.redact("mail ada@example.com", { language: "en" })).forcedReview).toBe(
      true,
    );
    for (let i = 0; i < RESTARTS_PER_MINUTE; i += 1)
      await supervisor.ensureRunning().catch(() => undefined);
    await expect(supervisor.ensureRunning()).rejects.toBeInstanceOf(SidecarUnavailableError);
    expect(supervisor.restartsInLastMinute).toBe(RESTARTS_PER_MINUTE);
    clock += 61_000;
    expect(supervisor.restartsInLastMinute).toBe(0);
  }, 30_000);
});
