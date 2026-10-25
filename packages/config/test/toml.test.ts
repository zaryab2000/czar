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

  it("parses quoted TOML inline tables with nested values", () => {
    expect(
      parseParameterToml(
        '"selection.czarRegisteredServices" = {"svc_01":{"serviceName"="czar-search","resource"={"url"="http://127.0.0.1:8787/v1/search","method"="GET"}}}',
      ),
    ).toEqual({
      "selection.czarRegisteredServices": {
        svc_01: {
          serviceName: "czar-search",
          resource: { url: "http://127.0.0.1:8787/v1/search", method: "GET" },
        },
      },
    });
  });

  it("parses formatted multiline inline tables and arrays", () => {
    expect(
      parseParameterToml(
        '"selection.czarRegisteredServices" = {"svc_01" = {"capabilities" = [\n"web-search",\n]}}',
      ),
    ).toEqual({
      "selection.czarRegisteredServices": { svc_01: { capabilities: ["web-search"] } },
    });
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
