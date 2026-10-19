import { request } from "node:http";
import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { createLogger } from "@czar/logging";
import { Daemon, describeStatus, KEYCHAIN_ACCOUNTS, macosPaths, STATUS_TEXT } from "@czar/daemon";
import { callSocket } from "@czar/daemon/status";
import { deniedKeychain, memoryKeychain, tempDir } from "./support.ts";

const running: Daemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

function makeDaemon(keychain = memoryKeychain()) {
  const home = tempDir("czar-d-");
  const paths = macosPaths(home, join(home, "s", "czar.sock"));
  const config = loadConfig({ env: { CZAR_DAEMON_HOOK_PORT: "0" } });
  const logs: string[] = [];
  const daemon = new Daemon({
    config,
    paths,
    keychain,
    logger: createLogger({ service: "czard", component: "CZ-02", sink: (line) => logs.push(line) }),
  });
  running.push(daemon);
  return { daemon, paths, keychain, logs };
}

function post(port: number, token: string) {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/hooks",
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

describe("daemon lifecycle (CZ-02 §5.1)", () => {
  it("starts observing: creates K14, opens the DB, serves the hook endpoint and the 0600 socket", async () => {
    const { daemon, paths, keychain } = makeDaemon();
    keychain.set(KEYCHAIN_ACCOUNTS.hookToken, "tok");
    await daemon.start();
    expect(daemon.state).toBe("observing");
    expect(keychain.items.get(KEYCHAIN_ACCOUNTS.memoryDbKey)).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(paths.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(paths.socketPath).isSocket()).toBe(true);
    const status = (await callSocket(paths.socketPath, "status.get")) as {
      state: string;
      hookPort: number;
    };
    expect(status.state).toBe("observing");
    expect(await post(status.hookPort, "tok")).toBe(202);
    expect(daemon.status().eventsReceived).toBe(1);
  });

  it("stays Locked when the keychain is denied; hooks get 503", async () => {
    const { daemon, paths, logs } = makeDaemon(
      deniedKeychain() as ReturnType<typeof memoryKeychain>,
    );
    await daemon.start();
    expect(daemon.state).toBe("locked");
    const status = (await callSocket(paths.socketPath, "status.get")) as { hookPort: number };
    expect(await post(status.hookPort, "anything")).toBe(503);
    expect(describeStatus(true, daemon.status())).toBe(STATUS_TEXT.locked);
    expect(logs.join("\n")).not.toContain("memory-db-key");
  });

  it("pause discards hooks with a count; resume observes again", async () => {
    const { daemon, keychain } = makeDaemon();
    keychain.set(KEYCHAIN_ACCOUNTS.hookToken, "tok");
    await daemon.start();
    daemon.pause(true);
    const port = daemon.status().hookPort as number;
    expect(await post(port, "tok")).toBe(202);
    expect(daemon.status()).toMatchObject({
      state: "paused",
      eventsReceived: 0,
      eventsDiscarded: 1,
    });
    expect(describeStatus(true, daemon.status())).toBe(STATUS_TEXT.paused);
    daemon.pause(false);
    expect(daemon.state).toBe("observing");
  });

  it("reports installed, not paired, until K15 exists", async () => {
    const { daemon, keychain } = makeDaemon();
    await daemon.start();
    expect(describeStatus(true, daemon.status())).toBe(STATUS_TEXT.installedNotPaired);
    keychain.set(KEYCHAIN_ACCOUNTS.deviceToken, "k15");
    expect(daemon.status().paired).toBe(true);
  });

  it("stop closes the socket and the database", async () => {
    const { daemon, paths } = makeDaemon();
    await daemon.start();
    await daemon.stop();
    expect(daemon.state).toBe("stopped");
    expect(daemon.database).toBeNull();
    await expect(callSocket(paths.socketPath, "status.get")).rejects.toThrow();
  });
});

describe("control socket JSON-RPC", () => {
  it("answers unknown methods with -32601", async () => {
    const { daemon, paths } = makeDaemon();
    await daemon.start();
    await expect(callSocket(paths.socketPath, "soul.get")).rejects.toThrow("method not found");
  });
});
