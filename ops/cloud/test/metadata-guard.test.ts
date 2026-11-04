// PM-011/PM-012: the metadata-server firewall guard (SCR-170 §4).
// Run with: node --test --experimental-strip-types ops/cloud/test/metadata-guard.test.ts
//
// With `network_mode: host` every container shares the host's network stack, so without this
// rule any compromised container could fetch a service-account token from the metadata server
// and call Cloud KMS `asymmetricSign` directly, skipping the signer's policy. Only root (for
// czar-secrets.service, the backup timer and the Ops Agent) and the signer's UID may reach it.
//
// No real iptables runs here: a recording stand-in for iptables and ip6tables goes on PATH.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cloudRoot = new URL("../", import.meta.url);
const guardScriptPath = fileURLToPath(new URL("systemd/metadata-guard.sh", cloudRoot));
const guardScript = readFileSync(guardScriptPath, "utf8");
const guardUnit = readFileSync(new URL("systemd/czar-metadata-guard.service", cloudRoot), "utf8");

const METADATA_IPV4 = "169.254.169.254";
const METADATA_IPV6 = "fd00:ec2::254";
const SIGNER_UID = "10002";

type Harness = { binDir: string; callLog: string; stateDir: string };

/**
 * Puts a recording stand-in for iptables and ip6tables on PATH. The stand-in answers `-C`
 * (the existence check) from a state file, so the second run of the guard sees the rule the
 * first run added, exactly as a real host would.
 */
function harness(): Harness {
  const binDir = mkdtempSync(join(tmpdir(), "czar-guard-bin-"));
  const stateDir = mkdtempSync(join(tmpdir(), "czar-guard-state-"));
  const callLog = join(binDir, "calls.log");
  for (const name of ["iptables", "ip6tables"]) {
    const stub = join(binDir, name);
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        `echo "${name} $*" >> ${JSON.stringify(callLog)}`,
        `state=${JSON.stringify(stateDir)}/${name}.rules`,
        'case "$1" in',
        "  -C)",
        '    shift; [ -f "$state" ] && grep -Fxq "$*" "$state" && exit 0',
        "    exit 1",
        "    ;;",
        "  -A)",
        '    shift; echo "$*" >> "$state"',
        "    exit 0",
        "    ;;",
        "esac",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);
  }
  return { binDir, callLog, stateDir };
}

function runGuard(
  used: Harness,
  options: { ipv6: boolean } = { ipv6: true },
): { status: number; stdout: string; stderr: string } {
  const inet6 = join(used.stateDir, "if_inet6");
  if (options.ipv6 && !existsSync(inet6)) writeFileSync(inet6, "");
  const result = spawnSync("bash", [guardScriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${used.binDir}:${process.env.PATH ?? ""}`,
      CZAR_IF_INET6_PATH: options.ipv6 ? inet6 : join(used.stateDir, "absent"),
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function calls(used: Harness): string[] {
  if (!existsSync(used.callLog)) return [];
  return readFileSync(used.callLog, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

test("the guard renders the exact rule SCR-170 §4 names", () => {
  const used = harness();
  const run = runGuard(used, { ipv6: false });
  assert.equal(run.status, 0, run.stderr);
  const added = calls(used).filter((line) => line.startsWith("iptables -A"));
  assert.deepEqual(added, [
    `iptables -A OUTPUT -d ${METADATA_IPV4} -m owner ! --uid-owner 0 ! --uid-owner ${SIGNER_UID} -j REJECT`,
  ]);
});

test("running the guard twice adds the rule once", () => {
  const used = harness();
  assert.equal(runGuard(used).status, 0);
  assert.equal(runGuard(used).status, 0);
  const added = calls(used).filter((line) => line.includes(" -A "));
  assert.equal(added.length, 2, `expected one IPv4 and one IPv6 add, got ${added.join(" | ")}`);
  assert.equal(added.filter((line) => line.startsWith("iptables")).length, 1);
  assert.equal(added.filter((line) => line.startsWith("ip6tables")).length, 1);
  // Idempotence comes from checking first, never from ignoring a failure.
  const checks = calls(used).filter((line) => line.includes(" -C "));
  assert.equal(checks.length, 4, "the guard does not check before adding on both runs");
});

test("the guard adds the ip6tables rule only when IPv6 is on", () => {
  const withIpv6 = harness();
  assert.equal(runGuard(withIpv6, { ipv6: true }).status, 0);
  assert.deepEqual(
    calls(withIpv6).filter((line) => line.startsWith("ip6tables -A")),
    [
      `ip6tables -A OUTPUT -d ${METADATA_IPV6} -m owner ! --uid-owner 0 ! --uid-owner ${SIGNER_UID} -j REJECT`,
    ],
  );

  const withoutIpv6 = harness();
  assert.equal(runGuard(withoutIpv6, { ipv6: false }).status, 0);
  assert.deepEqual(
    calls(withoutIpv6).filter((line) => line.startsWith("ip6tables")),
    [],
  );
});

test("the guard fails closed when iptables is missing", () => {
  const used = harness();
  const empty = mkdtempSync(join(tmpdir(), "czar-guard-empty-"));
  const result = spawnSync("bash", [guardScriptPath], {
    encoding: "utf8",
    env: { ...process.env, PATH: empty, CZAR_IF_INET6_PATH: join(used.stateDir, "absent") },
  });
  assert.notEqual(result.status, 0, "a missing iptables must stop the boot path, not be ignored");
});

test("the guard names only root and the signer UID, and never widens the rule", () => {
  assert.doesNotMatch(guardScript, /--uid-owner 10001/, "the client UID must not be exempt");
  assert.doesNotMatch(guardScript, /-j ACCEPT/, "the guard only rejects");
  assert.doesNotMatch(guardScript, /\|\| true/, "no failure may be swallowed");
  assert.match(guardScript, /^set -euo pipefail$/m);
  // Exactly two UIDs are exempt, and they are named once each as constants.
  assert.match(guardScript, /^readonly ROOT_UID=0\b/m);
  assert.match(guardScript, new RegExp(`^readonly SIGNER_UID=${SIGNER_UID}\\b`, "m"));
  const literalUids = [...guardScript.matchAll(/\b(\d{5})\b/g)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(literalUids)].toSorted(),
    [SIGNER_UID],
    "the guard names a UID other than the signer's",
  );
});

test("the unit runs the guard before Docker, every boot, and fails the boot if it cannot", () => {
  assert.match(guardUnit, /^Before=.*docker\.service/m);
  assert.match(guardUnit, /^Before=.*containerd\.service/m);
  assert.match(guardUnit, /^Type=oneshot$/m);
  assert.match(guardUnit, /^RemainAfterExit=yes$/m);
  assert.match(guardUnit, /^ExecStart=\/opt\/czar\/bin\/metadata-guard\.sh$/m);
  assert.match(guardUnit, /^WantedBy=multi-user\.target$/m);
  // docker.service must not be able to start if the guard failed.
  assert.doesNotMatch(guardUnit, /^ExecStart=-/m, "a leading - would ignore a guard failure");
});
