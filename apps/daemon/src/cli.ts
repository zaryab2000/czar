#!/usr/bin/env node
// `czar` CLI for the local daemon (CZ-02): status, install, update, uninstall, daemon, config dump.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Entry } from "@napi-rs/keyring";
import { loadConfig } from "@czar/config";
import { Daemon } from "./daemon.ts";
import { install, uninstall, update, type InstallDeps } from "./install.ts";
import { osKeychain } from "./keychain.ts";
import { Launchctl, type CommandRunner } from "./launchd.ts";
import { macosPaths } from "./paths.ts";
import { readStatus } from "./status.ts";
import { pairDevice } from "#src/pairing/pair-device";

const runCommand: CommandRunner = (program, args) =>
  new Promise((resolve) => {
    execFile(program, [...args], (error, stdout) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout: String(stdout) });
    });
  });

function deps(): InstallDeps {
  const config = loadConfig({ env: process.env });
  const paths = macosPaths(homedir(), config.get("daemon.socketPath") as string);
  return {
    platform: process.platform,
    paths,
    launchctl: new Launchctl(runCommand, process.getuid?.() ?? -1),
    keychain: createOsKeychain(),
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

async function promptDeviceName(): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question("Name this device: ")).trim();
  } finally {
    prompt.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "status": {
      const d = deps();
      const status = await readStatus(d.launchctl, d.paths.socketPath);
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
    case "pair": {
      const code = rest[0];
      if (process.platform !== "darwin") throw new Error("Pairing is supported on macOS only.");
      if (rest.length !== 1 || code === undefined)
        throw new Error("usage: czar pair <8-digit-code>");
      const deviceName = await promptDeviceName();
      const result = await pairDevice({
        code,
        deviceName,
        platform: "macos",
        keychain: createOsKeychain(),
      });
      process.stdout.write(`Paired device ${result.deviceId}.\n`);
      return 0;
    }
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
    "usage: czar status | install | update | uninstall [--delete-memory] | pair <code> | daemon | config dump\n",
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
