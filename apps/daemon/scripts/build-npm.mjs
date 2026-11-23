#!/usr/bin/env node
// Builds the publishable `czar` npm package from apps/daemon (PM-034). It bundles, writes the
// manifest, and runs `npm pack`. It never publishes: there is no `npm publish`, no login and no
// token anywhere in this file.
//
//   node scripts/build-npm.mjs [--name <package-name>] [--version <semver>] [--pack-dir <dir>]
//
// Output: dist/ (czar.mjs, package.json, README.md, LICENSE) and the tarball in --pack-dir
// (default: dist/pack/, git-ignored with the rest of dist/; the manifest's `files` list keeps it
// out of the tarball).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const DAEMON_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(DAEMON_DIR, "..", "..");
const DIST_DIR = join(DAEMON_DIR, "dist");
const NPM_DIR = join(DAEMON_DIR, "npm");
const DEFAULT_PACKAGE_NAME = "czar-daemon";
const NODE_TARGET = "node22";
/** Native modules stay external: they carry prebuilt binaries chosen by npm at install time. */
const NATIVE_MODULES = ["@napi-rs/keyring", "better-sqlite3-multiple-ciphers"];

function parseFlags(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(
        `usage: build-npm.mjs [--name <name>] [--version <semver>] [--pack-dir <dir>]`,
      );
    }
    flags.set(flag.slice(2), value);
  }
  for (const key of flags.keys()) {
    if (!["name", "version", "pack-dir"].includes(key)) throw new Error(`unknown flag --${key}`);
  }
  return flags;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The manifest is the template with the flags and the exact native versions filled in. */
function manifestFor(template, source, name, version) {
  const dependencies = {};
  for (const module of NATIVE_MODULES) {
    const pinned = source.dependencies?.[module];
    if (typeof pinned !== "string" || !/^\d+\.\d+\.\d+$/.test(pinned)) {
      throw new Error(`${module} must be pinned to an exact version in apps/daemon/package.json`);
    }
    dependencies[module] = pinned;
  }
  return { ...template, name, version, dependencies };
}

async function assertNoSecretFiles(directory) {
  const { FORBIDDEN } = await import(
    pathToFileURL(join(REPO_ROOT, "scripts", "secret-file-patterns.mjs")).href
  );
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1));
  const hits = files.filter((path) => FORBIDDEN.some((pattern) => pattern.test(path)));
  if (hits.length > 0) throw new Error(`secret-pattern files in the package:\n${hits.join("\n")}`);
}

/**
 * `@czar/schemas` and `@czar/api-contract` read the JSON schemas and the OpenAPI documents from
 * `docs/specs/02-data-and-protocol/` when they load, by a path relative to their own source. Inside
 * an installed package that path does not exist. Those packages are generated and not edited here,
 * so this plugin points the two reads at a `spec/` copy that the package ships beside the bundle.
 */
const SPEC_SOURCE_DIR = join(REPO_ROOT, "docs", "specs", "02-data-and-protocol");
const SPEC_SOURCE_URL_PREFIX = "../../../docs/specs/02-data-and-protocol/";
const SPEC_PACKAGE_URL_PREFIX = "./spec/";
const SPEC_REWRITES = [
  join(REPO_ROOT, "packages", "schemas", "src", "schema-source.ts"),
  join(REPO_ROOT, "packages", "api-contract", "src", "openapi.ts"),
];

const specPathPlugin = {
  name: "pm-034-spec-path",
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /(schema-source|openapi)\.ts$/ }, (args) => {
      if (!SPEC_REWRITES.includes(args.path)) return undefined;
      const text = readFileSync(args.path, "utf8");
      if (!text.includes(SPEC_SOURCE_URL_PREFIX)) {
        throw new Error(`${args.path} no longer reads the specs from ${SPEC_SOURCE_URL_PREFIX}`);
      }
      return {
        contents: text.replaceAll(SPEC_SOURCE_URL_PREFIX, SPEC_PACKAGE_URL_PREFIX),
        loader: "ts",
      };
    });
  },
};

/** Copies only what the two readers open: the `*.schema.json` files and the two OpenAPI documents. */
function copySpecData(destination) {
  const copies = [
    ...readdirSync(join(SPEC_SOURCE_DIR, "schemas"))
      .filter((file) => file.endsWith(".schema.json"))
      .map((file) => join("schemas", file)),
    join("api", "openapi.yaml"),
    join("api", "local-openapi.yaml"),
  ];
  for (const relative of copies) {
    mkdirSync(dirname(join(destination, relative)), { recursive: true });
    copyFileSync(join(SPEC_SOURCE_DIR, relative), join(destination, relative));
  }
}

const flags = parseFlags(process.argv.slice(2));
const source = readJson(join(DAEMON_DIR, "package.json"));
const name = flags.get("name") ?? DEFAULT_PACKAGE_NAME;
const version = flags.get("version") ?? source.version;
const packDir = resolve(flags.get("pack-dir") ?? join(DIST_DIR, "pack"));

rmSync(DIST_DIR, { recursive: true, force: true });
mkdirSync(DIST_DIR, { recursive: true });
mkdirSync(packDir, { recursive: true });

await build({
  entryPoints: [join(DAEMON_DIR, "src", "cli.ts")],
  outfile: join(DIST_DIR, "czar.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: NODE_TARGET,
  external: NATIVE_MODULES,
  plugins: [specPathPlugin],
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  // Bundled CommonJS dependencies call `require`, which an ES module does not define.
  banner: {
    js: "import { createRequire as __czarCreateRequire } from 'node:module';\nconst require = __czarCreateRequire(import.meta.url);",
  },
});

copySpecData(join(DIST_DIR, "spec"));

const template = readJson(join(NPM_DIR, "package.template.json"));
writeFileSync(
  join(DIST_DIR, "package.json"),
  `${JSON.stringify(manifestFor(template, source, name, version), null, 2)}\n`,
);
copyFileSync(join(NPM_DIR, "README.md"), join(DIST_DIR, "README.md"));
copyFileSync(join(NPM_DIR, "LICENSE"), join(DIST_DIR, "LICENSE"));

await assertNoSecretFiles(DIST_DIR);

execFileSync("npm", ["pack", "--pack-destination", packDir, "--silent"], {
  cwd: DIST_DIR,
  stdio: ["ignore", "inherit", "inherit"],
});
process.stdout.write(`packed ${name}@${version} into ${packDir}\n`);
