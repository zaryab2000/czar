// The Linux install round trip against a real systemd user manager and a real Secret Service
// (CZ-02 §3, B6-07, B6-08): a pinned Debian image boots systemd as PID 1, an unprivileged user gets
// a systemd user session and an unlocked gnome-keyring, and `czar install | status | uninstall` run
// end to end. Skipped unless CZAR_DOCKER=1: it needs a Docker daemon that can reach the registry,
// the Debian mirrors and the npm registry.
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pinned to a Debian point release. Override with CZAR_DOCKER_IMAGE to pin by digest
 * (`debian:12.11-slim@sha256:…`) on a machine that can read the registry.
 */
const DEBIAN_IMAGE = process.env["CZAR_DOCKER_IMAGE"] ?? "debian:12.11-slim";
const CONTAINER_NAME = "czar-daemon-linux-roundtrip";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STEP_TIMEOUT_MS = 600_000;
const TEST_TIMEOUT_MS = 1_800_000;
const CZAR_UID = 1001;

const enabled = process.env["CZAR_DOCKER"] === "1";

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const docker = (args: readonly string[]) =>
  new Promise<Run>((resolve) => {
    execFile(
      "docker",
      [...args],
      { maxBuffer: 32 * 1024 * 1024, timeout: STEP_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** Root step: the packages the daemon needs, an unprivileged user, and a workspace it owns. */
const PROVISION = String.raw`set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  dbus-user-session gnome-keyring libsecret-1-0 ca-certificates curl python3 build-essential >/dev/null
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
apt-get install -y -qq --no-install-recommends nodejs >/dev/null
useradd -m -u ${CZAR_UID} -s /bin/bash czar
loginctl enable-linger czar
mkdir -p /opt/czar
cp -r /repo/apps /repo/packages /repo/package.json /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml /repo/tsconfig.base.json /opt/czar/
find /opt/czar -name node_modules -maxdepth 4 -type d -exec rm -rf {} + 2>/dev/null || true
chown -R czar:czar /opt/czar`;

/**
 * czar step, inside the user's own systemd session: build the daemon's dependencies, unlock the
 * keyring, then the three commands. No secret is passed on a command line — `czar install` makes
 * K16 inside the keyring itself (D78).
 */
const ROUND_TRIP = String.raw`set -eu
export XDG_RUNTIME_DIR=/run/user/${CZAR_UID}
cd /opt/czar
corepack enable >/dev/null 2>&1 || true
corepack pnpm install --frozen-lockfile --filter @czar/daemon... >/dev/null
printf 'czar-test-keyring\n' | gnome-keyring-daemon --unlock --components=secrets >/dev/null
systemctl --user is-system-running --wait >/dev/null 2>&1 || true
node --experimental-strip-types apps/daemon/src/cli.ts install
test -f "$HOME/.config/systemd/user/czar-daemon.service"
systemctl --user is-active czar-daemon.service
node --experimental-strip-types apps/daemon/src/cli.ts status
node --experimental-strip-types apps/daemon/src/cli.ts uninstall
test ! -f "$HOME/.config/systemd/user/czar-daemon.service"
echo CZAR_LINUX_ROUND_TRIP_OK`;

describe.skipIf(!enabled)("Linux install round trip in a pinned Debian container", () => {
  it(
    "installs, reports running and uninstalls under a real systemd user session",
    async () => {
      await docker(["rm", "-f", CONTAINER_NAME]);
      const started = await docker([
        "run",
        "-d",
        "--name",
        CONTAINER_NAME,
        // systemd as PID 1 needs its own writable /run and the host cgroup namespace.
        "--privileged",
        "--cgroupns=host",
        "--tmpfs",
        "/run",
        "--tmpfs",
        "/run/lock",
        "-v",
        `${REPO_ROOT}:/repo:ro`,
        DEBIAN_IMAGE,
        "/sbin/init",
      ]);
      try {
        // `docker run -d` writes image-pull progress to stderr, so only the exit code is asserted.
        expect(started.code, started.stderr).toBe(0);
        const provision = await docker(["exec", CONTAINER_NAME, "bash", "-euc", PROVISION]);
        expect(provision.code, provision.stderr).toBe(0);
        const roundTrip = await docker([
          "exec",
          "--user",
          "czar",
          CONTAINER_NAME,
          "bash",
          "-euc",
          ROUND_TRIP,
        ]);
        expect(`${roundTrip.stdout}${roundTrip.stderr}`).toContain("CZAR_LINUX_ROUND_TRIP_OK");
        expect(roundTrip.stdout).toContain("Czar is installed");
        expect(roundTrip.code).toBe(0);
      } finally {
        await docker(["rm", "-f", CONTAINER_NAME]);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
