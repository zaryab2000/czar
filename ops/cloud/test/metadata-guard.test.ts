// PM-011/PM-012: the metadata-server firewall guard (SCR-170 §4).
// Run with: node --test --experimental-strip-types ops/cloud/test/metadata-guard.test.ts
//
// With `network_mode: host` every container shares the host's network stack, so without this
// rule any compromised container could fetch a service-account token from the metadata server
// and call Cloud KMS `asymmetricSign` directly, skipping the signer's policy. Only root (for
// czar-secrets.service, the backup timer and the Ops Agent) and the signer's UID may reach it.
//
// Two kinds of check here, and both are needed:
//   1. A recording stand-in for iptables/ip6tables on PATH, which proves the guard calls them
//      with the arguments it means to, is idempotent, and fails closed.
//   2. A REAL parser check with `iptables-translate`, which proves iptables ACCEPTS those
//      arguments. The stand-in cannot do this: it exits 0 for anything. Without check 2 the
//      spec's own single-rule form passed every test here and would still have been rejected
//      by iptables on the VM, failing the unit and stopping Docker from ever starting.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
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
 * (the existence check) from a state file, so the second run of the guard sees the rules the
 * first run added, exactly as a real host would. `-A` appends, `-D` removes.
 *
 * `parseExit` makes every `-C` exit with that code instead, to stand in for a rule iptables
 * refuses — exit 2 is what a real `iptables -C` returns for a rule that does not parse.
 */
function harness(options: { parseExit?: number } = {}): Harness {
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
        'touch "$state"',
        'case "$1" in',
        "  -C)",
        ...(options.parseExit === undefined
          ? ['    shift; grep -Fxq "$*" "$state" && exit 0', "    exit 1"]
          : [`    exit ${options.parseExit}`]),
        "    ;;",
        "  -A)",
        '    shift; echo "$*" >> "$state"',
        "    exit 0",
        "    ;;",
        "  -D)",
        '    shift; grep -Fxv "$*" "$state" > "$state.tmp" || true',
        '    mv "$state.tmp" "$state"',
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

/** The `-A` calls the guard made, as argument lists, with the tool name stripped. */
function appendedRules(used: Harness, tool: string): string[][] {
  return calls(used)
    .filter((line) => line.startsWith(`${tool} -A `))
    .map((line) => line.slice(`${tool} -A `.length).split(" "));
}

test("the guard installs allow-root, allow-signer, then reject-everyone-else, in that order", () => {
  const used = harness();
  const run = runGuard(used, { ipv6: false });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(appendedRules(used, "iptables"), [
    ["OUTPUT", "-d", METADATA_IPV4, "-m", "owner", "--uid-owner", "0", "-j", "ACCEPT"],
    ["OUTPUT", "-d", METADATA_IPV4, "-m", "owner", "--uid-owner", SIGNER_UID, "-j", "ACCEPT"],
    ["OUTPUT", "-d", METADATA_IPV4, "-j", "REJECT"],
  ]);
});

test("no rule carries --uid-owner twice, which iptables refuses", () => {
  // The exact shape SCR-170 §4 writes. `-m owner` accepts `--uid-owner` once only, so a rule
  // with two is a parse error (exit 2), not a rule: it can never be installed.
  const used = harness();
  assert.equal(runGuard(used).status, 0);
  for (const tool of ["iptables", "ip6tables"]) {
    for (const rule of appendedRules(used, tool)) {
      const count = rule.filter((argument) => argument === "--uid-owner").length;
      assert.ok(count <= 1, `two --uid-owner in one rule: ${rule.join(" ")}`);
    }
  }
  // Only the executable lines: the file's header quotes the spec's broken rule on purpose, to
  // record why this script does not use it.
  const code = guardScript
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(code, /--uid-owner[^\n]*--uid-owner/);
});

test("the reject is last and unconditional, so nobody else gets through", () => {
  const used = harness();
  assert.equal(runGuard(used, { ipv6: false }).status, 0);
  const rules = appendedRules(used, "iptables");
  const last = rules.at(-1);
  assert.ok(last, "no rules were appended");
  assert.deepEqual(last.slice(-2), ["-j", "REJECT"]);
  assert.equal(last.includes("--uid-owner"), false, "the final reject is conditional on a UID");
  // Every earlier rule accepts, and only for the two allowed UIDs.
  const allowed = new Set(["0", SIGNER_UID]);
  for (const rule of rules.slice(0, -1)) {
    assert.deepEqual(rule.slice(-2), ["-j", "ACCEPT"]);
    const uid = rule[rule.indexOf("--uid-owner") + 1];
    assert.ok(allowed.has(uid ?? ""), `an unexpected UID is allowed through: ${uid}`);
  }
  // If the reject were appended first it would shadow both accepts and lock root and the
  // signer out, breaking czar-secrets.service, the backups, the Ops Agent and all signing.
  assert.equal(rules.length, 3);
});

test("running the guard twice installs the rules once", () => {
  const used = harness();
  assert.equal(runGuard(used).status, 0);
  const afterFirst = calls(used).filter((line) => line.includes(" -A ")).length;
  assert.equal(afterFirst, 6, "expected three IPv4 and three IPv6 appends on the first run");

  assert.equal(runGuard(used).status, 0);
  const total = calls(used).filter((line) => line.includes(" -A ")).length;
  assert.equal(total, 6, "the second run appended again instead of finding the rules present");
  // Idempotence comes from checking first, never from ignoring a failure.
  assert.ok(calls(used).some((line) => line.includes(" -C ")));
});

test("a partial rule set is rebuilt whole, so the reject cannot end up first", () => {
  const used = harness();
  assert.equal(runGuard(used, { ipv6: false }).status, 0);
  // Drop the first accept, leaving the signer accept and the reject behind.
  const statePath = join(used.stateDir, "iptables.rules");
  const kept = readFileSync(statePath, "utf8")
    .split("\n")
    .filter((line) => line !== "" && !line.includes("--uid-owner 0"));
  writeFileSync(statePath, `${kept.join("\n")}\n`);

  writeFileSync(used.callLog, "");
  assert.equal(runGuard(used, { ipv6: false }).status, 0);
  // The two survivors are deleted and all three are appended again, in order.
  const deleted = calls(used).filter((line) => line.includes(" -D "));
  assert.equal(deleted.length, 2, `expected two deletes, got ${deleted.length}`);
  assert.deepEqual(appendedRules(used, "iptables"), [
    ["OUTPUT", "-d", METADATA_IPV4, "-m", "owner", "--uid-owner", "0", "-j", "ACCEPT"],
    ["OUTPUT", "-d", METADATA_IPV4, "-m", "owner", "--uid-owner", SIGNER_UID, "-j", "ACCEPT"],
    ["OUTPUT", "-d", METADATA_IPV4, "-j", "REJECT"],
  ]);
});

test("a rule iptables will not parse fails the unit, and is never read as 'absent'", () => {
  // This is the regression test for the bug this guard shipped with: `iptables -C` exits 2 for
  // a rule that does not parse and 1 for a rule that is merely absent. Treating 2 as "absent"
  // made the guard try to append an impossible rule, which failed the unit and — because the
  // unit is ordered Before=docker.service — would have stopped Docker from ever starting.
  const used = harness({ parseExit: 2 });
  const run = runGuard(used, { ipv6: false });
  assert.notEqual(run.status, 0, "a rule iptables refuses must stop the boot path");
  assert.match(run.stderr, /does not parse/);
  assert.equal(
    calls(used).filter((line) => line.includes(" -A ")).length,
    0,
    "the guard tried to append a rule iptables had already refused",
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

test("the guard adds the ip6tables rules only when IPv6 is on", () => {
  const withIpv6 = harness();
  assert.equal(runGuard(withIpv6, { ipv6: true }).status, 0);
  assert.deepEqual(appendedRules(withIpv6, "ip6tables"), [
    ["OUTPUT", "-d", METADATA_IPV6, "-m", "owner", "--uid-owner", "0", "-j", "ACCEPT"],
    ["OUTPUT", "-d", METADATA_IPV6, "-m", "owner", "--uid-owner", SIGNER_UID, "-j", "ACCEPT"],
    ["OUTPUT", "-d", METADATA_IPV6, "-j", "REJECT"],
  ]);

  const withoutIpv6 = harness();
  assert.equal(runGuard(withoutIpv6, { ipv6: false }).status, 0);
  assert.deepEqual(
    calls(withoutIpv6).filter((line) => line.startsWith("ip6tables")),
    [],
  );
});

test("iptables itself accepts every rule the guard builds", (t: TestContext) => {
  // The real parser check. `iptables-translate` runs the same argument parser as `iptables` and
  // prints the nft equivalent WITHOUT touching the host firewall: exit 2 is a parse error, exit
  // 0 means the rule is accepted. The stand-in above cannot catch a parse error, because it
  // exits 0 for anything, so this is the check that would have caught the shipped bug.
  const probe = spawnSync("iptables-translate", ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) {
    t.skip("iptables-translate is not installed here");
    return;
  }

  const used = harness();
  assert.equal(runGuard(used).status, 0);
  let checked = 0;
  for (const tool of ["iptables", "ip6tables"]) {
    const rules = appendedRules(used, tool);
    assert.equal(rules.length, 3, `expected three ${tool} rules`);
    for (const rule of rules) {
      const translated = spawnSync(`${tool}-translate`, ["-A", ...rule], { encoding: "utf8" });
      if (translated.error !== undefined) continue;
      assert.notEqual(
        translated.status,
        2,
        `${tool} refuses this rule:\n  ${rule.join(" ")}\n  ${translated.stderr.trim()}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 0, "no rule was parsed by the real iptables parser");
});

test("the spec's single-rule form really is the one iptables refuses", (t: TestContext) => {
  // Pins the reason this file departs from SCR-170 §4 as written. If a future iptables ever
  // accepts two --uid-owner in one match, this test fails and the departure can be revisited.
  const probe = spawnSync("iptables-translate", ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) {
    t.skip("iptables-translate is not installed here");
    return;
  }
  const specRule = [
    "-A",
    "OUTPUT",
    "-d",
    METADATA_IPV4,
    "-m",
    "owner",
    "!",
    "--uid-owner",
    "0",
    "!",
    "--uid-owner",
    SIGNER_UID,
    "-j",
    "REJECT",
  ];
  const translated = spawnSync("iptables-translate", specRule, { encoding: "utf8" });
  assert.equal(translated.status, 2, "iptables now accepts the spec's rule; revisit SCR-170 §4");
  assert.match(translated.stderr, /can only be used once/);
});

test("the guard names only root and the signer UID, and swallows no failure", () => {
  assert.doesNotMatch(guardScript, /--uid-owner 10001/, "the client UID must not be exempt");
  assert.doesNotMatch(guardScript, /\|\| true/, "no failure may be swallowed");
  assert.match(guardScript, /^set -euo pipefail$/m);
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
