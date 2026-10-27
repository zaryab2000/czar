import { describe, expect, it } from "vitest";
import { readLocalLauncherPointers } from "#src/local-main";

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
