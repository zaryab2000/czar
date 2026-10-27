import { afterEach, describe, expect, it, vi } from "vitest";

const validConfig = {
  circleClientUrl: "https://wallet.example.test",
  circleClientKey: "public-e2e-key",
  arcRpcUrl: "https://rpc.example.test",
  bundlerOrder: ["circle", "pimlico", "alchemy", "zerodev"],
  bundlerEndpoints: {},
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("getAppWalletConfig", () => {
  it("loads and validates fresh same-origin config without credentials or caching", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(validConfig), {
          status: 200,
          headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getAppWalletConfig } = await import("#src/app-api");

    await expect(getAppWalletConfig()).resolves.toEqual(validConfig);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/app/wallet-config",
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        mode: "same-origin",
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Accept: "application/json" });
  });

  it("rejects missing values instead of using browser defaults", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ...validConfig, arcRpcUrl: "" }), {
          status: 200,
          headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getAppWalletConfig } = await import("#src/app-api");

    await expect(getAppWalletConfig()).rejects.toThrow(
      "Czar received invalid wallet configuration.",
    );
  });

  it("rejects a response without the no-store policy", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(validConfig), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getAppWalletConfig } = await import("#src/app-api");

    await expect(getAppWalletConfig()).rejects.toThrow("Czar could not load wallet configuration.");
  });
});

describe("manual-return pagination", () => {
  it("collects every page without treating a partial count as the total", async () => {
    const { manualReturnsFixture } = await import("#src/summary-fixtures");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString(), "http://localhost");
      const secondPage = url.searchParams.get("cursor") === "next-page";
      return Response.json({
        items: secondPage ? [manualReturnsFixture[1]] : [manualReturnsFixture[0]],
        nextCursor: secondPage ? null : "next-page",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { appApi } = await import("#src/app-api");

    await expect(appApi.listAllManualReturns()).resolves.toEqual({
      items: [manualReturnsFixture[0], manualReturnsFixture[1]],
      nextCursor: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
