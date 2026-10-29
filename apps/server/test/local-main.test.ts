import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { listenOnLoopback, readLocalLauncherPointers } from "#src/local-main";

describe("local server launcher pointers", () => {
  it("reads only the six approved local launcher variables", () => {
    expect(
      readLocalLauncherPointers({
        CZAR_LOCAL_CONFIG: "env/local.toml",
        CZAR_DATABASE_URL: "postgres://local",
        CZAR_ARC_RPC_URL: "http://127.0.0.1:8545",
        CZAR_SERVER_PORT: "3000",
        CZAR_LOCAL_OBJECT_STORE_PATH: "/tmp/czar-objects",
        CZAR_INDEXER_URL: "http://127.0.0.1:42069",
        CZAR_PRIVATE_KEY: "must-not-be-read",
        OTHER_SETTING: "ignored",
      }),
    ).toEqual({
      configPath: "env/local.toml",
      databaseUrl: "postgres://local",
      rpcUrl: "http://127.0.0.1:8545",
      serverPort: "3000",
      objectStorePath: "/tmp/czar-objects",
      indexerUrl: "http://127.0.0.1:42069",
    });
  });
});

describe("local server listener", () => {
  it("accepts connections on the IPv4 loopback address its local clients use", async () => {
    const server = createServer((_request, response) => response.end("ok"));
    await listenOnLoopback(server, 0);
    try {
      const address = server.address() as AddressInfo;
      expect(address.address).toBe("127.0.0.1");
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(await response.text()).toBe("ok");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
