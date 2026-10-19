import { describe, expect, it } from "vitest";
import { Launchctl, renderLaunchAgentPlist } from "@czar/daemon";
import { fakeLaunchctl } from "./support.ts";

describe("launch agent plist (CZ-02 §3, B6-02)", () => {
  const plist = renderLaunchAgentPlist({
    programArguments: ["/usr/local/bin/node", "/Applications/Czar.app/czar.js", "daemon"],
    workingDirectory: "/Users/u/Library/Application Support/Czar",
    logsDir: "/Users/u/Library/Logs/Czar",
  });

  it("has the keys the spec lists", () => {
    expect(plist).toContain("<key>Label</key><string>dev.czar.daemon</string>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>ProcessType</key><string>Background</string>");
    expect(plist).toContain("<key>ThrottleInterval</key><integer>10</integer>");
    expect(plist).toContain("<string>/Users/u/Library/Logs/Czar/daemon.out.log</string>");
    expect(plist).toContain("<string>/Users/u/Library/Logs/Czar/daemon.err.log</string>");
    expect(plist).toContain(
      "<key>WorkingDirectory</key><string>/Users/u/Library/Application Support/Czar</string>",
    );
    expect(plist).toContain("<string>daemon</string>");
  });

  it("does not set RunAtLoad (KeepAlive implies it)", () => {
    expect(plist).not.toContain("RunAtLoad");
  });

  it("escapes XML in arguments", () => {
    expect(
      renderLaunchAgentPlist({
        programArguments: ["a&b<c>"],
        workingDirectory: "/",
        logsDir: "/l",
      }),
    ).toContain("<string>a&amp;b&lt;c&gt;</string>");
  });
});

describe("launchctl (B6-01, B6-03)", () => {
  it("uses bootstrap, kickstart -k and bootout in gui/$UID, never load", async () => {
    const fake = fakeLaunchctl();
    const launchctl = new Launchctl(fake.run, 501);
    await launchctl.bootstrap("/Users/u/Library/LaunchAgents/dev.czar.daemon.plist");
    expect(await launchctl.isLoaded()).toBe(true);
    await launchctl.kickstart();
    await launchctl.bootout();
    expect(await launchctl.isLoaded()).toBe(false);
    expect(fake.calls).toEqual([
      [
        "/bin/launchctl",
        "bootstrap",
        "gui/501",
        "/Users/u/Library/LaunchAgents/dev.czar.daemon.plist",
      ],
      ["/bin/launchctl", "print", "gui/501/dev.czar.daemon"],
      ["/bin/launchctl", "kickstart", "-k", "gui/501/dev.czar.daemon"],
      ["/bin/launchctl", "bootout", "gui/501/dev.czar.daemon"],
      ["/bin/launchctl", "print", "gui/501/dev.czar.daemon"],
    ]);
    expect(fake.calls.flat()).not.toContain("load");
  });

  it("reports a failing launchctl call", async () => {
    const launchctl = new Launchctl(async () => ({ code: 5, stdout: "" }), 501);
    await expect(launchctl.bootstrap("/p")).rejects.toThrow("exit code 5");
  });
});
