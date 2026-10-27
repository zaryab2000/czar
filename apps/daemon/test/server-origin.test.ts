import { loadConfig } from "@czar/config";
import { describe, expect, it } from "vitest";
import { localOverlayPath, readServerOrigin } from "#src/server-origin";

function withOrigin(value?: string) {
  return loadConfig({
    envFile: value === undefined ? {} : { "daemon.serverOrigin": value },
  });
}

describe("daemon.serverOrigin (SCR-149 §1)", () => {
  it("names the env var when unset", () => {
    expect(() => readServerOrigin({ config: withOrigin() })).toThrow(/CZAR_DAEMON_SERVER_ORIGIN/);
  });

  it("accepts an https origin", () => {
    expect(readServerOrigin({ config: withOrigin("https://czar.example") }).origin).toBe(
      "https://czar.example",
    );
  });

  it("accepts a loopback origin only with the local overlay", () => {
    const config = withOrigin("http://127.0.0.1:3000");
    expect(readServerOrigin({ config, overlayPath: localOverlayPath() }).origin).toBe(
      "http://127.0.0.1:3000",
    );
    expect(
      readServerOrigin({
        config: withOrigin("http://localhost:3000"),
        overlayPath: localOverlayPath(),
      }).origin,
    ).toBe("http://localhost:3000");
  });

  it("refuses a loopback origin without the local overlay", () => {
    expect(() => readServerOrigin({ config: withOrigin("http://127.0.0.1:3000") })).toThrow(
      /local overlay/,
    );
    expect(() =>
      readServerOrigin({
        config: withOrigin("http://127.0.0.1:3000"),
        overlayPath: "/tmp/other.toml",
      }),
    ).toThrow(/local overlay/);
  });

  it("refuses a value with a path, a non-loopback http origin, or a loopback without a port", () => {
    expect(() => readServerOrigin({ config: withOrigin("https://czar.example/api") })).toThrow(
      /without a path/,
    );
    expect(() => readServerOrigin({ config: withOrigin("http://czar.example") })).toThrow(/https/);
    expect(() =>
      readServerOrigin({ config: withOrigin("http://127.0.0.1"), overlayPath: localOverlayPath() }),
    ).toThrow(/https/);
  });
});

describe("server-contacting modules use daemon.serverOrigin", () => {
  it("has no hard-coded server origin left in pairing or objective HTTP", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["../src/pairing/pair-device.ts", "../src/objective-http.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/SERVER_ORIGIN\s*=|["']http:\/\/localhost/);
    }
  });
});
