import { describe, expect, it } from "vitest";
import { parameterEnvironment, parseParameterToml } from "@czar/config";

describe("parameter TOML overlays", () => {
  it("parses dotted parameter keys and JSON-compatible TOML values", () => {
    expect(
      parseParameterToml(
        '# Local-only origins\n"fetch.localMerchantOrigins" = ["http://127.0.0.1:8787"]\n',
      ),
    ).toEqual({ "fetch.localMerchantOrigins": ["http://127.0.0.1:8787"] });
  });

  it("rejects malformed, duplicate, and non-JSON-compatible values", () => {
    expect(() => parseParameterToml("fetch.localMerchantOrigins = []")).toThrow(/line 1/);
    expect(() => parseParameterToml('"api.pageMinLimit" = 1\n"api.pageMinLimit" = 2')).toThrow(
      /line 2/,
    );
    expect(() => parseParameterToml('"api.pageMinLimit" = 1_000')).toThrow(/JSON-compatible/);
  });

  it("keeps runtime-only environment variables out of parameter validation", () => {
    expect(
      parameterEnvironment({ CZAR_SERVER_PORT: "3000", CZAR_DAEMON_HOOK_PORT: "48000" }),
    ).toEqual({ CZAR_DAEMON_HOOK_PORT: "48000" });
  });
});
