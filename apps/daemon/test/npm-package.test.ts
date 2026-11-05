// The npm package build (PM-034): bundle, pack, install the tarball into a temporary prefix and run
// it. Skipped unless CZAR_PACK=1 because it runs npm install against the registry (the two native
// dependencies) and takes a minute. Nothing here publishes.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DAEMON_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(DAEMON_DIR, "..", "..");
const STEP_TIMEOUT_MS = 600_000;
const PACK_NAME = "czar-daemon";
const PACK_VERSION = "0.0.0-pack.1";
const NOT_INSTALLED_EXIT_CODE = 3;

const enabled = process.env["CZAR_PACK"] === "1";

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** czar rejects unknown CZAR_* variables as config, so the test's own switch must not reach it. */
const childEnv = (home?: string): NodeJS.ProcessEnv => {
  const { CZAR_PACK: _switch, ...rest } = process.env;
  return home === undefined ? rest : { ...rest, HOME: home, XDG_RUNTIME_DIR: "" };
};

const run = (program: string, args: readonly string[], cwd: string, home?: string) =>
  new Promise<Run>((resolve) => {
    execFile(
      program,
      [...args],
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        timeout: STEP_TIMEOUT_MS,
        env: childEnv(home),
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

describe.skipIf(!enabled)("daemon npm package", () => {
  let scratch = "";
  let tarball = "";
  let listing: readonly string[] = [];

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "pm-034-"));
    const built = await run(
      "node",
      [
        "scripts/build-npm.mjs",
        "--name",
        PACK_NAME,
        "--version",
        PACK_VERSION,
        "--pack-dir",
        scratch,
      ],
      DAEMON_DIR,
    );
    expect(built.code, built.stderr).toBe(0);
    tarball = join(scratch, `${PACK_NAME}-${PACK_VERSION}.tgz`);
    const tar = await run("tar", ["-tzf", tarball], scratch);
    expect(tar.code, tar.stderr).toBe(0);
    listing = tar.stdout.split("\n").filter((line) => line !== "");
  }, STEP_TIMEOUT_MS);

  afterAll(() => {
    if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  });

  it("holds only the bundle, the manifest, the README, the LICENSE and the spec data files", () => {
    const top = listing.filter((path) => !path.startsWith("package/spec/") && !path.endsWith("/"));
    expect([...top].toSorted()).toEqual([
      "package/LICENSE",
      "package/README.md",
      "package/czar.mjs",
      "package/package.json",
    ]);
    const spec = listing.filter((path) => path.startsWith("package/spec/") && !path.endsWith("/"));
    expect(spec.length).toBeGreaterThan(0);
    expect(spec.filter((path) => !/\.(schema\.json|yaml)$/.test(path))).toEqual([]);
  });

  it("holds no TypeScript source, source map, test fixture or secret-pattern file", async () => {
    const { FORBIDDEN } = (await import(
      pathToFileURL(join(REPO_ROOT, "scripts", "secret-file-patterns.mjs")).href
    )) as { FORBIDDEN: readonly RegExp[] };
    expect(listing.filter((path) => /\.(ts|mts|cts|map)$/.test(path))).toEqual([]);
    expect(listing.filter((path) => /(^|\/)(test|fixtures?)\//.test(path))).toEqual([]);
    expect(listing.filter((path) => FORBIDDEN.some((pattern) => pattern.test(path)))).toEqual([]);
  });

  it("carries a manifest with the czar bin, the engine range and only the native dependencies", async () => {
    const source = JSON.parse(readFileSync(join(DAEMON_DIR, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const unpacked = join(scratch, "unpacked");
    mkdirSync(unpacked, { recursive: true });
    const extracted = await run(
      "tar",
      ["-xzf", tarball, "-C", unpacked, "package/package.json"],
      scratch,
    );
    expect(extracted.code, extracted.stderr).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(unpacked, "package", "package.json"), "utf8"),
    ) as {
      name: string;
      version: string;
      bin: Record<string, string>;
      engines: Record<string, string>;
      dependencies: Record<string, string>;
      private?: boolean;
    };
    expect(manifest.name).toBe(PACK_NAME);
    expect(manifest.version).toBe(PACK_VERSION);
    expect(manifest.bin).toEqual({ czar: "./czar.mjs" });
    expect(manifest.engines["node"]).toBe(">=22.18 <23");
    expect(manifest.private).toBeUndefined();
    expect(manifest.dependencies).toEqual({
      "@napi-rs/keyring": source.dependencies["@napi-rs/keyring"],
      "better-sqlite3-multiple-ciphers": source.dependencies["better-sqlite3-multiple-ciphers"],
    });
  });

  it(
    "installs into a temporary prefix and runs czar --version and czar status",
    async () => {
      const prefix = join(scratch, "prefix");
      const home = join(scratch, "home");
      mkdirSync(home, { recursive: true });
      const installed = await run("npm", ["install", "-g", "--prefix", prefix, tarball], scratch);
      expect(installed.code, installed.stderr).toBe(0);
      const czar = join(prefix, "bin", "czar");

      const version = await run(czar, ["--version"], scratch, home);
      expect(version.code, version.stderr).toBe(0);
      expect(version.stdout.trim()).toBe(PACK_VERSION);

      const status = await run(czar, ["status"], scratch, home);
      expect(status.code, status.stderr).toBe(NOT_INSTALLED_EXIT_CODE);
      expect(status.stdout.toLowerCase()).toContain("not installed");
    },
    STEP_TIMEOUT_MS,
  );
});
