import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  install,
  KEYCHAIN_ACCOUNTS,
  Launchctl,
  macosPaths,
  readStatus,
  STATUS_TEXT,
  uninstall,
  update,
  UnsupportedPlatformError,
} from "@czar/daemon";
import { openMemoryDatabase } from "#src/database";
import { loadOrCreateDbKey } from "#src/keychain";
import { fakeLaunchctl, memoryKeychain, tempDir } from "./support.ts";

function setup(platform: NodeJS.Platform = "darwin") {
  const home = tempDir("czar-home-");
  const paths = macosPaths(home, "~/Library/Application Support/Czar/czar.sock");
  const fake = fakeLaunchctl();
  const keychain = memoryKeychain();
  const deps = {
    platform,
    paths,
    launchctl: new Launchctl(fake.run, 501),
    keychain,
    fs: {
      mkdir: (path: string, mode: number) => mkdirSync(path, { recursive: true, mode }),
      writeFile: (path: string, contents: string, mode: number) =>
        writeFileSync(path, contents, { mode }),
      removeFile: (path: string) => rmSync(path, { force: true }),
      removeDir: (path: string) => rmSync(path, { recursive: true, force: true }),
      exists: existsSync,
    },
    programArguments: ["/usr/local/bin/node", "/opt/czar/cli.ts", "daemon"],
  };
  return { home, paths, fake, keychain, deps };
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
    const { deps } = setup("linux");
    await expect(install(deps)).rejects.toBeInstanceOf(UnsupportedPlatformError);
  });
});
