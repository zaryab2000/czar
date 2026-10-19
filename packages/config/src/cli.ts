#!/usr/bin/env node
// `czar-config dump [--env-file <path>]`: prints every parameter, its value and source as JSON lines.
// The daemon's `czar config dump` calls the same function (cross-cutting §3.2).
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./loader.ts";

export function dumpLines(envFilePath?: string): string {
  const envFile =
    envFilePath === undefined
      ? undefined
      : (JSON.parse(readFileSync(envFilePath, "utf8")) as Record<string, unknown>);
  const config = loadConfig({ ...(envFile === undefined ? {} : { envFile }), env: process.env });
  return config
    .dump()
    .map((entry) => JSON.stringify(entry))
    .join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, flag, path] = process.argv.slice(2);
  if (command !== "dump" || (flag !== undefined && flag !== "--env-file")) {
    process.stderr.write("usage: czar-config dump [--env-file <path>]\n");
    process.exit(2);
  }
  process.stdout.write(`${dumpLines(path)}\n`);
}
