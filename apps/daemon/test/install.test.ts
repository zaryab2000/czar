import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  install,
  KEYCHAIN_ACCOUNTS,
  KeyringServiceMissingError,
  Launchctl,
  linuxPaths,
  Loginctl,
  macosPaths,
  readStatus,
  STATUS_TEXT,
  Systemctl,
  uninstall,
  update,
  UnsupportedPlatformError,
} from "@czar/daemon";
import { openMemoryDatabase } from "#src/database";
import { loadOrCreateDbKey } from "#src/keychain";
import {
  deniedKeychain,
  fakeLaunchctl,
  fakeSystemctl,
  linuxInstallDeps,
  memoryKeychain,
  nodeInstallFs,
  tempDir,
} from "./support.ts";

function setup(platform: NodeJS.Platform = "darwin") {
  const home = tempDir("czar-home-");
  const paths = macosPaths(home, "~/Library/Application Support/Czar/czar.sock");
  const fake = fakeLaunchctl();
  const systemd = fakeSystemctl();
  const keychain = memoryKeychain();
  const deps = {
    platform,
    paths,
    launchctl: new Launchctl(fake.run, 501),
    systemctl: new Systemctl(systemd.run),
    loginctl: new Loginctl(systemd.run, "czaruser"),
    keychain,
    fs: nodeInstallFs(),
    programArguments: ["/usr/local/bin/node", "/opt/czar/cli.ts", "daemon"],
    print: () => undefined,
  };
  return { home, paths, fake, systemd, keychain, deps };
}

describe("install / update / uninstall on macOS (mocked launchctl and keychain)", () => {
  it("installs the login agent and `czar status` reports the installed state", async () => {
    const { paths, fake, keychain, deps } = setup();
    expect((await readStatus(deps.launchctl, paths.socketPath)).text).toBe(
      STATUS_TEXT.notInstalled,
    );
    await install(deps);
    expect(readFileSync(paths.launchAgentPlist, "utf8")).toContain("dev.czar.daemon");
    expect(statSync(paths.supportDir).mode & 0o777).toBe(0o700);
    expect(keychain.items.get(KEYCHAIN_ACCOUNTS.hookToken)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fake.calls).toContainEqual([
      "/bin/launchctl",
      "bootstrap",
      "gui/501",
      paths.launchAgentPlist,
    ]);
    const status = await readStatus(deps.launchctl, paths.socketPath);
    expect(status.installed).toBe(true);
    expect(status.text).toBe(STATUS_TEXT.notRunning);
  });

  it("update restarts the agent with kickstart -k", async () => {
    const { fake, deps } = setup();
    await install(deps);
    await update(deps);
    expect(fake.calls.at(-1)).toEqual([
      "/bin/launchctl",
      "kickstart",
      "-k",
      "gui/501/dev.czar.daemon",
    ]);
  });

  it("reinstall boots the old agent out first", async () => {
    const { fake, deps } = setup();
    await install(deps);
    await install(deps);
    const verbs = fake.calls.map((call) => call[1]);
    expect(verbs.filter((verb) => verb === "bootout")).toHaveLength(1);
    expect(verbs.filter((verb) => verb === "bootstrap")).toHaveLength(2);
  });

  it("uninstall removes the agent, keeps memory and its key unless asked (PM-037)", async () => {
    const { paths, keychain, deps } = setup();
    await install(deps);
    keychain.set(KEYCHAIN_ACCOUNTS.memoryDbKey, "a".repeat(64));
    keychain.set(KEYCHAIN_ACCOUNTS.deviceToken, "dev-token");
    writeFileSync(join(paths.supportDir, "memory.db"), "x");
    await uninstall(deps, { deleteMemory: false });
    expect(await deps.launchctl.isLoaded()).toBe(false);
    expect(existsSync(paths.launchAgentPlist)).toBe(false);
    // K14 stays, or the kept memory could never be opened again; K15 and K16 go.
    expect(keychain.items.get(KEYCHAIN_ACCOUNTS.memoryDbKey)).toBe("a".repeat(64));
    expect(keychain.items.has(KEYCHAIN_ACCOUNTS.deviceToken)).toBe(false);
    expect(keychain.items.has(KEYCHAIN_ACCOUNTS.hookToken)).toBe(false);
    expect(keychain.items.size).toBe(1);
    expect(existsSync(join(paths.supportDir, "memory.db"))).toBe(true);
    await uninstall(deps, { deleteMemory: true });
    expect(keychain.items.size).toBe(0);
    expect(existsSync(paths.supportDir)).toBe(false);
  });

  it("memory kept through an uninstall still opens after reinstall (PM-037)", async () => {
    const { paths, keychain, deps } = setup();
    await install(deps);
    const key = loadOrCreateDbKey(keychain);
    const before = openMemoryDatabase(paths.databasePath, key);
    before.prepare("INSERT INTO settings (key, value_json) VALUES ('paused', 'false')").run();
    before.close();

    await uninstall(deps, { deleteMemory: false });
    await install(deps);

    const stored = keychain.items.get(KEYCHAIN_ACCOUNTS.memoryDbKey);
    expect(stored).toBe(key);
    expect(loadOrCreateDbKey(keychain)).toBe(key);
    const after = openMemoryDatabase(paths.databasePath, stored as string);
    expect(after.prepare("SELECT value_json FROM settings WHERE key = 'paused'").get()).toEqual({
      value_json: "false",
    });
    after.close();
  });

  it("refuses to install on other platforms (D67)", async () => {
    const { deps } = setup("win32");
    await expect(install(deps)).rejects.toBeInstanceOf(UnsupportedPlatformError);
  });

  it("names both supported systems when it refuses, and refuses update and uninstall too", async () => {
    const { deps } = setup("win32");
    await expect(install(deps)).rejects.toThrow("runs on macOS and Linux; this machine is win32");
    await expect(update(deps)).rejects.toBeInstanceOf(UnsupportedPlatformError);
    await expect(uninstall(deps, { deleteMemory: false })).rejects.toBeInstanceOf(
      UnsupportedPlatformError,
    );
  });
});

describe("install / update / uninstall on Linux (mocked systemctl, loginctl and keyring)", () => {
  it("installs the user unit and `czar status` reports the installed state", async () => {
    const { paths, systemd, keychain, deps } = linuxInstallDeps();
    expect((await readStatus(deps.systemctl, paths.socketPath)).text).toBe(
      STATUS_TEXT.notInstalled,
    );
    await install(deps);
    expect(readFileSync(paths.systemdUnit, "utf8")).toContain("WantedBy=default.target");
    expect(statSync(paths.supportDir).mode & 0o777).toBe(0o700);
    expect(keychain.items.get(KEYCHAIN_ACCOUNTS.hookToken)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(systemd.calls).toContainEqual([
      "/usr/bin/systemctl",
      "--user",
      "enable",
      "--now",
      "czar-daemon.service",
    ]);
    const status = await readStatus(deps.systemctl, paths.socketPath);
    expect(status.installed).toBe(true);
    expect(status.text).toBe(STATUS_TEXT.notRunning);
  });

  it("writes the unit under XDG config and the data, logs and socket under XDG", () => {
    const paths = linuxPaths("/home/z", {
      XDG_DATA_HOME: "/home/z/.local/share",
      XDG_CONFIG_HOME: "/home/z/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(paths).toEqual({
      supportDir: "/home/z/.local/share/czar",
      logsDir: "/home/z/.local/share/czar/logs",
      databasePath: "/home/z/.local/share/czar/memory.db",
      socketPath: "/run/user/1000/czar.sock",
      systemdUnit: "/home/z/.config/systemd/user/czar-daemon.service",
      unitWorkingDirectory: "%h/.local/share/czar",
      unitLogsDir: "%h/.local/share/czar/logs",
    });
  });

  it("falls back to the XDG defaults when the variables are unset", () => {
    const paths = linuxPaths("/home/z", {});
    expect(paths.supportDir).toBe("/home/z/.local/share/czar");
    expect(paths.systemdUnit).toBe("/home/z/.config/systemd/user/czar-daemon.service");
    expect(paths.socketPath).toBe("/home/z/.local/share/czar/czar.sock");
  });

  it("update restarts the unit", async () => {
    const { systemd, deps } = linuxInstallDeps();
    await install(deps);
    await update(deps);
    expect(systemd.calls.at(-1)).toEqual([
      "/usr/bin/systemctl",
      "--user",
      "restart",
      "czar-daemon.service",
    ]);
  });

  it("reinstall disables the old unit first", async () => {
    const { systemd, deps } = linuxInstallDeps();
    await install(deps);
    await install(deps);
    const verbs = systemd.calls.map((call) => call[2]);
    expect(verbs.filter((verb) => verb === "disable")).toHaveLength(1);
    expect(verbs.filter((verb) => verb === "enable")).toHaveLength(2);
  });

  it("uninstall removes the unit, keeps memory and its key unless asked (PM-037)", async () => {
    const { paths, keychain, deps } = linuxInstallDeps();
    await install(deps);
    keychain.set(KEYCHAIN_ACCOUNTS.memoryDbKey, "a".repeat(64));
    keychain.set(KEYCHAIN_ACCOUNTS.deviceToken, "dev-token");
    writeFileSync(join(paths.supportDir, "memory.db"), "x");
    await uninstall(deps, { deleteMemory: false });
    expect(await deps.systemctl.isLoaded()).toBe(false);
    expect(existsSync(paths.systemdUnit)).toBe(false);
    // K14 stays, or the kept memory could never be opened again; K15 and K16 go.
    expect(keychain.items.get(KEYCHAIN_ACCOUNTS.memoryDbKey)).toBe("a".repeat(64));
    expect(keychain.items.has(KEYCHAIN_ACCOUNTS.deviceToken)).toBe(false);
    expect(keychain.items.has(KEYCHAIN_ACCOUNTS.hookToken)).toBe(false);
    expect(keychain.items.size).toBe(1);
    expect(existsSync(join(paths.supportDir, "memory.db"))).toBe(true);
    await uninstall(deps, { deleteMemory: true });
    expect(keychain.items.size).toBe(0);
    expect(existsSync(paths.supportDir)).toBe(false);
  });

  it("memory kept through an uninstall still opens after reinstall (PM-037)", async () => {
    const { paths, keychain, deps } = linuxInstallDeps();
    await install(deps);
    const key = loadOrCreateDbKey(keychain);
    const before = openMemoryDatabase(paths.databasePath, key);
    before.prepare("INSERT INTO settings (key, value_json) VALUES ('paused', 'false')").run();
    before.close();

    await uninstall(deps, { deleteMemory: false });
    await install(deps);

    const stored = keychain.items.get(KEYCHAIN_ACCOUNTS.memoryDbKey);
    expect(stored).toBe(key);
    const after = openMemoryDatabase(paths.databasePath, stored as string);
    expect(after.prepare("SELECT value_json FROM settings WHERE key = 'paused'").get()).toEqual({
      value_json: "false",
    });
    after.close();
  });

  it("install succeeds and says the daemon stops at logout when enable-linger is refused (B6-07)", async () => {
    const { paths, systemd, lines, deps } = linuxInstallDeps({ linger: false });
    await install(deps);
    expect(existsSync(paths.systemdUnit)).toBe(true);
    expect(systemd.calls).toContainEqual(["/usr/bin/loginctl", "enable-linger", "czaruser"]);
    expect(lines).toEqual([
      "Czar is installed, but it will stop when you log out: enabling user lingering was refused.",
    ]);
  });

  it("stops with a plain keyring message and leaves no unit file when there is no Secret Service", async () => {
    const { paths, systemd, deps } = linuxInstallDeps({ keychain: deniedKeychain() });
    await expect(install(deps)).rejects.toBeInstanceOf(KeyringServiceMissingError);
    await expect(install(deps)).rejects.toThrow(
      "Czar needs a keyring service (GNOME Keyring or KWallet) on Linux",
    );
    expect(existsSync(paths.systemdUnit)).toBe(false);
    expect(existsSync(paths.supportDir)).toBe(false);
    expect(systemd.calls).toEqual([]);
  });
});
