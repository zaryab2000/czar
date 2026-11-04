import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { install, renderUserUnit, Systemctl, uninstall, update } from "@czar/daemon";
import { Loginctl } from "@czar/daemon";
import { fakeSystemctl, linuxInstallDeps } from "./support.ts";

const GOLDEN = fileURLToPath(new URL("./golden/czar-daemon.service", import.meta.url));

describe("systemd user unit (CZ-02 §3, B6-07, B6-08)", () => {
  const unit = renderUserUnit({
    programArguments: ["/usr/local/bin/node", "/opt/czar/cli.ts", "daemon"],
    workingDirectory: "%h/.local/share/czar",
    logsDir: "%h/.local/share/czar/logs",
  });

  it("renders the golden unit byte for byte", () => {
    expect(unit).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("restarts on failure, throttled like the plist, and writes the two log files", () => {
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=10");
    expect(unit).toContain("StandardOutput=append:%h/.local/share/czar/logs/daemon.out.log");
    expect(unit).toContain("StandardError=append:%h/.local/share/czar/logs/daemon.err.log");
  });

  it("never asks for root and keeps every path under %h", () => {
    expect(unit).not.toMatch(/^User=/m);
    expect(unit).not.toMatch(/^Group=/m);
    expect(unit).not.toContain("root");
    expect(unit).not.toContain("sudo");
    expect(unit).toContain("WorkingDirectory=%h/");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("is a user unit, so it carries no secret in Environment=", () => {
    expect(unit).not.toContain("Environment");
  });

  it("quotes ExecStart arguments and escapes systemd specifiers", () => {
    expect(
      renderUserUnit({
        programArguments: ["/o/n o/de", 'a"b', "100%"],
        workingDirectory: "/w",
        logsDir: "/l",
      }),
    ).toContain('ExecStart="/o/n o/de" "a\\"b" "100%%"');
  });
});

describe("systemctl --user wrapper (B6-07)", () => {
  it("is-active, enable --now, restart, disable --now and daemon-reload all stay in --user", async () => {
    const fake = fakeSystemctl();
    const systemctl = new Systemctl(fake.run);
    expect(await systemctl.isLoaded()).toBe(false);
    await systemctl.daemonReload();
    await systemctl.enableNow();
    expect(await systemctl.isLoaded()).toBe(true);
    await systemctl.restart();
    await systemctl.disableNow();
    expect(await systemctl.isLoaded()).toBe(false);
    expect(fake.calls).toEqual([
      ["/usr/bin/systemctl", "--user", "is-active", "czar-daemon.service"],
      ["/usr/bin/systemctl", "--user", "daemon-reload"],
      ["/usr/bin/systemctl", "--user", "enable", "--now", "czar-daemon.service"],
      ["/usr/bin/systemctl", "--user", "is-active", "czar-daemon.service"],
      ["/usr/bin/systemctl", "--user", "restart", "czar-daemon.service"],
      ["/usr/bin/systemctl", "--user", "disable", "--now", "czar-daemon.service"],
      ["/usr/bin/systemctl", "--user", "is-active", "czar-daemon.service"],
    ]);
    expect(fake.calls.flat()).not.toContain("--system");
    expect(fake.calls.flat()).not.toContain("sudo");
  });

  it("reports a failing systemctl call", async () => {
    const systemctl = new Systemctl(async () => ({ code: 5, stdout: "" }));
    await expect(systemctl.enableNow()).rejects.toThrow("exit code 5");
  });

  it("enable-linger answers true when granted and false when refused", async () => {
    const granted = fakeSystemctl();
    expect(await new Loginctl(granted.run, "czaruser").enableLinger()).toBe(true);
    expect(granted.calls).toEqual([["/usr/bin/loginctl", "enable-linger", "czaruser"]]);
    const refused = fakeSystemctl({ linger: false });
    expect(await new Loginctl(refused.run, "czaruser").enableLinger()).toBe(false);
  });
});

/** Every recorded call as "<arguments>", so an expectation reads like the command line. */
const verbs = (calls: readonly string[][]) =>
  calls.map((call) => call.slice(1).join(" ")).filter((line) => line !== "");

describe("the ordered systemctl calls of install, update and uninstall", () => {
  it("install: unit written, then daemon-reload, enable --now, enable-linger", async () => {
    const { deps, systemd } = linuxInstallDeps();
    await install(deps);
    expect(verbs(systemd.calls)).toEqual([
      "--user is-active czar-daemon.service",
      "--user daemon-reload",
      "--user enable --now czar-daemon.service",
      "enable-linger czaruser",
    ]);
  });

  it("reinstall disables the running unit first, as macOS boots the old agent out", async () => {
    const { deps, systemd } = linuxInstallDeps();
    await install(deps);
    await install(deps);
    expect(verbs(systemd.calls).slice(4)).toEqual([
      "--user is-active czar-daemon.service",
      "--user disable --now czar-daemon.service",
      "--user daemon-reload",
      "--user enable --now czar-daemon.service",
      "enable-linger czaruser",
    ]);
  });

  it("update: is-active then restart", async () => {
    const { deps, systemd } = linuxInstallDeps();
    await install(deps);
    systemd.calls.length = 0;
    await update(deps);
    expect(verbs(systemd.calls)).toEqual([
      "--user is-active czar-daemon.service",
      "--user restart czar-daemon.service",
    ]);
  });

  it("update refuses when the unit is not running", async () => {
    const { deps } = linuxInstallDeps();
    await expect(update(deps)).rejects.toThrow("Czar is not installed");
  });

  it("uninstall: disable --now then daemon-reload once the unit file is gone", async () => {
    const { deps, systemd } = linuxInstallDeps();
    await install(deps);
    systemd.calls.length = 0;
    await uninstall(deps, { deleteMemory: false });
    expect(verbs(systemd.calls)).toEqual([
      "--user is-active czar-daemon.service",
      "--user disable --now czar-daemon.service",
      "--user daemon-reload",
    ]);
  });
});
