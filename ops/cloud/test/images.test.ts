// Acceptance tests for the Czar cloud images (PM-013).
//
// Preconditions: a container runtime, and the five images built at the current
// HEAD commit:
//
//   ops/cloud/docker/build-all.sh
//
// Run from the repository root:
//
//   npx vitest run ops/cloud/test/images.test.ts
//
// (ops/ is not a workspace package, so these do not run under `pnpm -r test`,
// the same way ops/local/process-compose.test.ts does not. They are an explicit
// acceptance gate, run against built images.)
//
// There is deliberately no environment variable that makes this suite pass when
// the images are missing. A missing image fails here with the command to build it:
// the secret-file check below is the gate for "no credential is in any layer", and
// a gate that can be switched off is not a gate.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { beforeAll, describe, expect, it } from "vitest";
// The one list, shared with scripts/check-no-secret-files.mjs, so the tracked-file
// check and the image-layer check can never drift apart.
import { FORBIDDEN } from "../../../scripts/secret-file-patterns.mjs";

const run = promisify(execFile);

const NODE_VERSION = "v22.22.0";
const SIGNER_CLIENT_GID = 10010;

/** The images, with the UID each must run as (SCR-170 §4). */
const IMAGES = [
  { app: "server", uid: 10001 },
  { app: "merchants", uid: 10001 },
  { app: "indexer", uid: 10001 },
  { app: "web", uid: 10001 },
  { app: "signer", uid: 10002 },
] as const;

/**
 * Paths exempt from the secret-file scan: the base image's public CA trust store.
 * These hold published root certificates, which are not credentials — a TLS client
 * needs them and nothing can be signed with them.
 *
 * The exemption is a prefix list, never a pattern, and it covers nothing under
 * app/. Everything Czar puts in an image is scanned with no exemption at all.
 */
const TRUST_STORE_PREFIXES = ["etc/ssl/", "usr/lib/ssl/", "usr/share/ca-certificates/"];

const isExempt = (path: string): boolean =>
  TRUST_STORE_PREFIXES.some((prefix) => path.startsWith(prefix));

let gitSha = "";

const tagFor = (app: string): string => `czar-${app}:${gitSha}`;

/** Every path in an image, from `docker export` piped through `tar -t`. */
const filesIn = async (tag: string): Promise<string[]> => {
  // An explicit command is passed so this works on any image, whether or not it
  // declares a CMD. The container is only ever exported, never started, so the
  // command is never run and does not need to exist.
  const { stdout } = await run("docker", ["create", tag, "/nonexistent-never-started"], {
    encoding: "utf8",
  });
  const container = stdout.trim();
  try {
    const exporter = spawn("docker", ["export", container], { stdio: ["ignore", "pipe", "pipe"] });
    const lister = spawn("tar", ["-tf", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    exporter.stdout.pipe(lister.stdin);

    // The listing is streamed line by line: a full image export is hundreds of
    // megabytes and must not be buffered.
    const paths: string[] = [];
    const lines = createInterface({ input: lister.stdout, crlfDelay: Infinity });
    for await (const line of lines) if (line !== "") paths.push(line);

    const code = await new Promise<number>((resolve) => lister.on("close", resolve));
    if (code !== 0) throw new Error(`tar -t exited ${code} for ${tag}`);
    return paths;
  } finally {
    await run("docker", ["rm", "-f", container], { encoding: "utf8" });
  }
};

beforeAll(async () => {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
  } catch {
    throw new Error(
      "No container runtime: `docker info` failed. These are acceptance tests over " +
        "built images and cannot be checked without one.",
    );
  }

  const { stdout } = await run("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  gitSha = stdout.trim();

  const missing: string[] = [];
  for (const { app } of IMAGES) {
    try {
      await run("docker", ["image", "inspect", tagFor(app)], { encoding: "utf8" });
    } catch {
      missing.push(tagFor(app));
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Images not built at this commit: ${missing.join(", ")}. ` +
        "Build them with ops/cloud/docker/build-all.sh and run this suite again.",
    );
  }
}, 120_000);

describe.each(IMAGES)("czar-$app image", ({ app, uid }) => {
  it(`runs as UID ${uid} in group ${SIGNER_CLIENT_GID}`, async () => {
    // --entrypoint clears the image's CMD, so this runs `id` and nothing else.
    const { stdout } = await run("docker", ["run", "--rm", "--entrypoint", "id", tagFor(app)], {
      encoding: "utf8",
    });
    expect(stdout).toContain(`uid=${uid}`);
    // Not root, by UID and by name.
    expect(stdout).not.toContain("uid=0(");
    // Every app image joins the signer-client group, so a client can open the
    // signer's 0660 socket (SCR-170 §4).
    expect(stdout).toMatch(new RegExp(`\\b(gid|groups)=.*\\b${SIGNER_CLIENT_GID}\\b`));
  }, 120_000);

  it(`reports Node ${NODE_VERSION}`, async () => {
    const { stdout } = await run(
      "docker",
      ["run", "--rm", "--entrypoint", "node", tagFor(app), "--version"],
      { encoding: "utf8" },
    );
    expect(stdout.trim()).toBe(NODE_VERSION);
  }, 120_000);

  it("holds no file matching a secret-file pattern", async () => {
    const paths = await filesIn(tagFor(app));
    // A sanity check on the listing itself: an empty or truncated export would
    // otherwise make the scan below pass for the wrong reason.
    expect(paths.length).toBeGreaterThan(1000);
    expect(paths.some((path) => path.startsWith("app/"))).toBe(true);

    const hits = paths.filter(
      (path) => !isExempt(path) && FORBIDDEN.some((pattern) => pattern.test(path)),
    );
    expect(hits).toStrictEqual([]);
  }, 600_000);
});

describe("czar-web image", () => {
  it("holds a completed Next.js build", async () => {
    const paths = await filesIn(tagFor("web"));
    expect(paths).toContain("app/apps/web/.next/BUILD_ID");
  }, 600_000);
});
