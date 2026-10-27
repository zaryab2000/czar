#!/usr/bin/env node
// Fails when git tracks a file that could hold key material (T-001, G0-12).
// `.env.example` is the one allowed env file: it holds placeholder names only.
import { execFileSync } from "node:child_process";
import process from "node:process";

const FORBIDDEN = [
  /\.key$/,
  /\.key\.json$/,
  /(^|\/)\.env(?!\.example$)/,
  /(^|\/)keystore\//,
  /\.pem$/,
  /\.p12$/,
];

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const hits = tracked.filter((path) => FORBIDDEN.some((pattern) => pattern.test(path)));

if (hits.length > 0) {
  process.stderr.write(`Tracked files that may hold secrets:\n${hits.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`ok: ${tracked.length} tracked files, none match a secret-file pattern\n`);
