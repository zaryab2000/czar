import { describe, expect, it } from "vitest";
import { loadConfig, PARAMETERS } from "@czar/config";

describe("SCR-187 Circle discovery parameters", () => {
  it("keeps discovery off by default with the specified bounds", () => {
    const config = loadConfig();
    expect(config.get("selection.circleDiscovery.enabled")).toBe(false);
    expect(config.get("selection.circleDiscovery.baseUrl")).toBe(
      "https://api.circle.com/v2/x402/discovery/resources",
    );
    expect(config.get("selection.circleDiscovery.pageLimit")).toBe(200);
    expect(config.get("selection.circleDiscovery.maxPages")).toBe(5);
    expect(config.get("selection.circleDiscovery.timeoutMs")).toBe(3000);
    expect(config.get("selection.circleDiscovery.maxResponseBytes")).toBe(2_000_000);
    expect(config.get("selection.circleDiscovery.cacheSeconds")).toBe(3600);
    expect(config.get("selection.circleDiscovery.maxCandidates")).toBe(20);
    expect(config.get("acceptance.genericMaxBytes")).toBe(1_000_000);
  });

  it("maps only specified capabilities and cites the accepted SCR", () => {
    const config = loadConfig();
    const map = config.get("selection.circleDiscovery.capabilityMap") as Record<string, unknown>;
    expect(map["code-review"]).toEqual({ query: "audit" });
    expect(map["page-extract"]).toEqual({ category: "WEB_SEARCH_RESEARCH", query: "extract" });
    expect(map["table-build"]).toBeUndefined();
    expect(
      PARAMETERS.filter((parameter) =>
        parameter.key.startsWith("selection.circleDiscovery."),
      ).every((parameter) => parameter.source.includes("SCR-187")),
    ).toBe(true);
  });
});
