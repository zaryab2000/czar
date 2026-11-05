#!/usr/bin/env node
// `czar` CLI for the local daemon (CZ-02): status, install, update, uninstall, daemon, config dump.
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Entry } from "@napi-rs/keyring";
import { loadConfig } from "@czar/config";
import type { Config } from "@czar/config";
import { sidecarLayer2Client } from "@czar/redaction";
import { Daemon } from "./daemon.ts";
import { openMemoryDatabase, type MemoryDatabase } from "./database.ts";
import { install, uninstall, update, type InstallDeps } from "./install.ts";
import { KEYCHAIN_ACCOUNTS, osKeychain, type Keychain } from "./keychain.ts";
import { Launchctl, type CommandRunner } from "./launchd.ts";
import { Loginctl, Systemctl } from "./systemd.ts";
import { linuxPaths, macosPaths, type DaemonPaths } from "./paths.ts";
import { readStatus, type ServiceManager } from "./status.ts";
import { pairDevice } from "#src/pairing/pair-device";
import { runManualObjective, runResultCommand } from "#src/objective-command";
import { objectivePreflight } from "#src/objective-preflight";
import { pairedDeviceId, savePairedDevice } from "#src/paired-device";
import { readRatingKey } from "#src/results/rating-key";
import { SidecarSupervisor } from "#src/sidecar";
import { loadCommandConfig, readServerOrigin } from "#src/server-origin";

const runCommand: CommandRunner = (program, args) =>
  new Promise((resolve) => {
    execFile(program, [...args], (error, stdout) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout: String(stdout) });
    });
  });

/**
 * Linux takes its locations from the XDG variables (CZ-02 §3 Linux row, §4 line 221), not from
 * `daemon.socketPath`, whose default is the macOS path.
 */
function platformPaths(config: Config): DaemonPaths {
  return process.platform === "linux"
    ? linuxPaths(homedir(), process.env)
    : macosPaths(homedir(), config.get("daemon.socketPath") as string);
}

/** `czar status` reads the installed state from whichever service manager this platform has. */
function serviceManager(installDeps: InstallDeps): ServiceManager {
  return installDeps.platform === "linux" ? installDeps.systemctl : installDeps.launchctl;
}

function deps(): InstallDeps {
  const config = loadConfig({ env: process.env });
  const paths = platformPaths(config);
  return {
    platform: process.platform,
    paths,
    launchctl: new Launchctl(runCommand, process.getuid?.() ?? -1),
    systemctl: new Systemctl(runCommand),
    loginctl: new Loginctl(runCommand, userInfo().username),
    keychain: createOsKeychain(),
    print: (line) => void process.stdout.write(`${line}\n`),
    fs: {
      mkdir: (path, mode) => mkdirSync(path, { recursive: true, mode }),
      writeFile: (path, contents, mode) => {
        writeFileSync(path, contents, { mode });
        chmodSync(path, mode);
      },
      removeFile: (path) => rmSync(path, { force: true }),
      removeDir: (path) => rmSync(path, { recursive: true, force: true }),
      exists: existsSync,
    },
    programArguments: [process.execPath, fileURLToPath(import.meta.url), "daemon"],
  };
}

function createOsKeychain() {
  return osKeychain((service, account) => new Entry(service, account));
}

function ratingAsk(argv: readonly string[]): ((line: string) => Promise<string>) | undefined {
  if (argv.includes("--no-prompt") || !process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }
  return (line) => readRatingKey(process.stdin, process.stdout, line);
}

function sidecarCommand(): string {
  const local = fileURLToPath(
    new URL("../../redact-sidecar/.venv/bin/czar-redact", import.meta.url),
  );
  return existsSync(local) ? local : "czar-redact";
}

async function promptDeviceName(): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question("Name this device: ")).trim();
  } finally {
    prompt.close();
  }
}

function openPairedSettings(paths: DaemonPaths, keychain: Keychain): MemoryDatabase {
  const key = keychain.get(KEYCHAIN_ACCOUNTS.memoryDbKey);
  if (!key) throw new Error("Czar memory is not initialized. Start czar daemon before pairing.");
  return openMemoryDatabase(paths.databasePath, key);
}

async function runPair(argv: readonly string[]): Promise<number> {
  const [code] = argv;
  if (process.platform !== "darwin") throw new Error("Pairing is supported on macOS only.");
  if (argv.length !== 1 || code === undefined) throw new Error("usage: czar pair <8-digit-code>");
  const commandConfig = await loadCommandConfig(process.env);
  const serverOrigin = readServerOrigin(commandConfig);
  const config = commandConfig.config;
  const paths = macosPaths(homedir(), config.get("daemon.socketPath") as string);
  const keychain = createOsKeychain();
  const db = openPairedSettings(paths, keychain);
  try {
    const result = await pairDevice({
      code,
      deviceName: await promptDeviceName(),
      platform: "macos",
      serverOrigin,
      keychain,
    });
    const token = keychain.get(KEYCHAIN_ACCOUNTS.deviceToken);
    if (!token) throw new Error("Paired token was not saved; request a new pairing code.");
    try {
      savePairedDevice(db, result.deviceId, token);
    } catch {
      throw new Error("Paired device ID could not be saved. Fix Czar memory and pair again.");
    }
    process.stdout.write(`Paired device ${result.deviceId}.\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function runObjective(argv: readonly string[]): Promise<number> {
  if (process.platform !== "darwin") throw new Error("Objectives are supported on macOS only.");
  const commandConfig = await loadCommandConfig(process.env);
  const serverOrigin = readServerOrigin(commandConfig);
  const config: Config = commandConfig.config;
  const paths = macosPaths(homedir(), config.get("daemon.socketPath") as string);
  const keychain = createOsKeychain();
  const preflight = objectivePreflight(
    argv.filter((arg) => arg !== "--no-prompt"),
    keychain,
    config.get("drives.capabilityTaxonomy"),
  );
  const db = openPairedSettings(paths, keychain);
  const sidecarSocket = join(dirname(paths.socketPath), "czar-redact.sock");
  const supervisor = new SidecarSupervisor({
    command: sidecarCommand(),
    socketPath: sidecarSocket,
    spawn: (command, args) => spawn(command, [...args], { stdio: "ignore" }),
    idleMs: (config.get("redaction.sidecarIdleS") as number) * 1000,
    startTimeoutMs: config.get("redaction.layer2TimeoutMs") as number,
  });
  try {
    const ask = ratingAsk(argv);
    await runManualObjective(preflight.options, {
      database: db,
      deviceId: pairedDeviceId(db, preflight.token),
      deviceToken: preflight.token,
      keychain,
      config,
      serverOrigin,
      cwd: process.cwd(),
      layer2: sidecarLayer2Client({
        socketPath: sidecarSocket,
        timeoutMs: config.get("redaction.layer2TimeoutMs") as number,
        ensureRunning: () =>
          existsSync(sidecarSocket) ? Promise.resolve() : supervisor.ensureRunning(),
      }),
      pollSeconds: config.get("daemon.objectivePollSeconds") as number,
      print: (line) => process.stdout.write(`${line}\n`),
      ...(ask === undefined ? {} : { ratingAsk: ask }),
      confirmFallback: async (goal) => {
        if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
        process.stdout.write(`${goal}\n`);
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return (await prompt.question("Send? [y/N] ")).trim() === "y";
        } finally {
          prompt.close();
        }
      },
    });
    return 0;
  } finally {
    await supervisor.stop();
    db.close();
  }
}

async function runResult(argv: readonly string[]): Promise<number> {
  const args = argv.filter((arg) => arg !== "--no-prompt");
  const [objectiveId] = args;
  if (process.platform !== "darwin") throw new Error("Results are supported on macOS only.");
  if (args.length !== 1 || objectiveId === undefined) {
    throw new Error("usage: czar result <objectiveId> [--no-prompt]");
  }
  const commandConfig = await loadCommandConfig(process.env);
  const serverOrigin = readServerOrigin(commandConfig);
  const config = commandConfig.config;
  const paths = macosPaths(homedir(), config.get("daemon.socketPath") as string);
  const keychain = createOsKeychain();
  const token = keychain.get(KEYCHAIN_ACCOUNTS.deviceToken);
  if (!token) throw new Error("This computer is not paired. Run czar pair <code> first.");
  const db = openPairedSettings(paths, keychain);
  try {
    const ask = ratingAsk(argv);
    await runResultCommand(objectiveId, {
      database: db,
      deviceToken: token,
      keychain,
      config,
      serverOrigin,
      cwd: process.cwd(),
      pollSeconds: config.get("daemon.objectivePollSeconds") as number,
      print: (line) => process.stdout.write(`${line}\n`),
      ...(ask === undefined ? {} : { ratingAsk: ask }),
    });
    return 0;
  } finally {
    db.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "status": {
      const d = deps();
      const status = await readStatus(serviceManager(d), d.paths.socketPath);
      process.stdout.write(`${status.text}\n`);
      return status.installed ? 0 : 3;
    }
    case "install":
      await install(deps());
      return 0;
    case "update":
      await update(deps());
      return 0;
    case "uninstall":
      await uninstall(deps(), { deleteMemory: rest.includes("--delete-memory") });
      return 0;
    case "pair":
      return runPair(rest);
    case "objective":
      return runObjective(rest);
    case "result":
      return runResult(rest);
    case "daemon": {
      const d = deps();
      const daemon = new Daemon({
        config: loadConfig({ env: process.env }),
        paths: d.paths,
        keychain: d.keychain,
      });
      await daemon.start();
      const shutdown = () => void daemon.stop().then(() => process.exit(0));
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      return new Promise<number>(() => undefined);
    }
    case "config":
      if (rest[0] === "dump") {
        for (const entry of loadConfig({ env: process.env }).dump())
          process.stdout.write(`${JSON.stringify(entry)}\n`);
        return 0;
      }
      break;
    default:
      break;
  }
  process.stderr.write(
    "usage: czar status | install | update | uninstall [--delete-memory] | pair <code> | " +
      "objective <goal> [options] | result <objectiveId> | daemon | config dump\n",
  );
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "czar failed"}\n`);
      process.exit(1);
    },
  );
}
