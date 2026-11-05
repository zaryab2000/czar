import { describe, expect, it } from "vitest";
import { loadConfig, loadConfigFile, parameterEnvironment, parseParameterToml } from "@czar/config";

describe("parameter TOML overlays", () => {
  it("loads the SCR-183 demo timing values without changing production defaults", async () => {
    const base = loadConfig();
    const demo = await loadConfigFile(
      new URL("../../../env/cloud-demo.example.toml", import.meta.url),
    );
    const expected = {
      "social.incidentEvalMinutes": [60, 1],
      "selection.snapshotRefreshSeconds": [300, 30],
      "selection.ratingRefreshDebounceSeconds": [30, 5],
      "social.housekeepingMinutes": [15, 1],
      "social.routingCooldownMinutes": [60, 1],
      "social.repDailyPostCap": [10, 50],
      "demo.enabled": [false, true],
    } as const;
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      const [production, overlay] = expected[key];
      expect(base.get(key), key).toBe(production);
      expect(demo.get(key), key).toBe(overlay);
    }
    expect(demo.get("social.consumerPollMs")).toBe(base.get("social.consumerPollMs"));
    expect(demo.get("social.runnerPollMs")).toBe(base.get("social.runnerPollMs"));
    expect(demo.get("social.incidentMinOwners")).toBe(base.get("social.incidentMinOwners"));
    expect(demo.get("social.incidentWindowDays")).toBe(base.get("social.incidentWindowDays"));
  });
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

  it("parses formatter-produced multiline arrays with a trailing comma", () => {
    expect(
      parseParameterToml(
        '"fetch.localMerchantOrigins" = [\n"http://127.0.0.1:8787",\n"http://127.0.0.1:8788",\n]',
      ),
    ).toEqual({
      "fetch.localMerchantOrigins": ["http://127.0.0.1:8787", "http://127.0.0.1:8788"],
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
