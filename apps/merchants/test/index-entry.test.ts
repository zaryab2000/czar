// CZ-20 §5.8 index entries: one item per route, in the 02 §12.2 shape, with `supportsVanillax402` and
// `supportsCircleGateway` taken from the live 402 of the route rather than typed by hand (p1-D7).
import { createServer } from "node:http";
import { loadConfig } from "@czar/config";
import { createLogger } from "@czar/logging";
import type { Address } from "@czar/hashing";
import { describe, expect, it } from "vitest";
import { createAlphaMerchantServer } from "../src/alpha-services.ts";
import {
  discoveryIndexEntry,
  validateDiscoveryIndexEntry,
  RAIL_VANILLA,
} from "../src/index-entry.ts";
import { EXTRACT_PATH } from "../src/extract/index.ts";
import { SPOT_PATH } from "../src/spot/index.ts";
import { SEARCH_PATH } from "../src/search/index.ts";
import { fakeSafeFetch, testStore } from "./x402-doubles.ts";

const ADDRESSES: Record<string, string> = {
  "K10:czar-search": "0x00000000000000000000000000000000000000A1",
  "K10:czar-spot": "0x00000000000000000000000000000000000000A2",
  "K10:czar-extract": "0x00000000000000000000000000000000000000A3",
};

const LAST_UPDATED = "2026-11-05T12:00:00Z";

async function alphaEntries() {
  const runtime = await createAlphaMerchantServer({
    server: createServer(),
    config: loadConfig({
      envFile: { "merchants.publicOrigin": "https://merchants.testnet.czar.dev" },
    }),
    signer: {
      async keyAddress(_caller: string, keyRef: string) {
        const address = ADDRESSES[keyRef];
        if (address === undefined) throw new Error("no such key");
        return address as Address;
      },
      async sign() {
        return {
          signature: `0x${"11".repeat(65)}` as const,
          digest: `0x${"22".repeat(32)}` as const,
        };
      },
    },
    store: testStore(),
    logger: createLogger({ service: "merchants", component: "CZ-20", sink: () => undefined }),
    port: 0,
    safeFetch: fakeSafeFetch({ pages: { "*": { body: "<html></html>" } } }).safeFetch,
  });
  try {
    return runtime.indexEntries({ lastUpdated: LAST_UPDATED });
  } finally {
    await runtime.stop();
  }
}

describe("discovery-index entries", () => {
  it("builds one valid 02 §12.2 item per vanilla route", async () => {
    const entries = await alphaEntries();
    expect(entries.map((entry) => entry["resource"])).toEqual([
      `https://merchants.testnet.czar.dev${SEARCH_PATH}`,
      `https://merchants.testnet.czar.dev${SPOT_PATH}`,
      `https://merchants.testnet.czar.dev${EXTRACT_PATH}`,
    ]);
    for (const entry of entries) expect(validateDiscoveryIndexEntry(entry)).toEqual([]);
  });

  it("carries the spec fields both readers need", async () => {
    const entries = await alphaEntries();
    const spot = entries.find((entry) => String(entry["resource"]).endsWith(SPOT_PATH));
    expect(spot).toMatchObject({
      type: "http",
      x402Version: 2,
      lastUpdated: LAST_UPDATED,
      serviceName: "czar-spot",
      mimeType: "application/json",
      accepts: [
        expect.objectContaining({
          scheme: "exact",
          amount: "50000",
          payTo: ADDRESSES["K10:czar-spot"],
        }),
      ],
      extensions: {
        czar: {
          source: "czar-registered",
          rail: RAIL_VANILLA,
          routing: { vaultDirect: true, gateway: false, upto: false },
        },
      },
      metadata: {
        path: SPOT_PATH,
        method: "GET",
        mimeType: "application/json",
        siwx: false,
        supportsVanillax402: true,
        supportsCircleGateway: false,
      },
    });
    expect((spot as Record<string, unknown>)["extensions"]).toHaveProperty("bazaar");
  });

  it("records the POST method and body input for czar-extract", async () => {
    const entries = await alphaEntries();
    const extract = entries.find((entry) => String(entry["resource"]).endsWith(EXTRACT_PATH));
    expect(extract).toMatchObject({
      serviceName: "czar-extract",
      metadata: { path: EXTRACT_PATH, method: "POST" },
    });
    expect(
      ((extract as Record<string, unknown>)["metadata"] as Record<string, unknown>)["input"],
    ).toMatchObject({ type: "http", method: "POST", bodyType: "json" });
  });

  it("derives supportsVanillax402 and supportsCircleGateway from the live 402, not by hand", () => {
    const paymentRequired = {
      x402Version: 2 as const,
      error: "payment required",
      resource: {
        url: "https://merchants.testnet.czar.dev/v1/spot",
        description: "d",
        mimeType: "application/json",
        serviceName: "czar-spot",
        tags: ["price"],
      },
      accepts: [],
      extensions: {},
    };
    const noOffer = discoveryIndexEntry({
      paymentRequired,
      path: "/v1/spot",
      method: "GET",
      lastUpdated: LAST_UPDATED,
      supportsCircleGateway: false,
    });
    expect((noOffer["metadata"] as Record<string, unknown>)["supportsVanillax402"]).toBe(false);
    expect(validateDiscoveryIndexEntry(noOffer)).toContain("accepts must hold at least one offer");

    const withGateway = discoveryIndexEntry({
      paymentRequired: {
        ...paymentRequired,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:5042002",
            amount: "50000",
            asset: "0x3600000000000000000000000000000000000000",
            payTo: ADDRESSES["K10:czar-spot"] as string,
            maxTimeoutSeconds: 300,
            extra: { name: "USDC", version: "2" },
          },
        ],
      },
      path: "/v1/spot",
      method: "GET",
      lastUpdated: LAST_UPDATED,
      supportsCircleGateway: true,
    });
    const metadata = withGateway["metadata"] as Record<string, unknown>;
    expect(metadata["supportsVanillax402"]).toBe(true);
    expect(metadata["supportsCircleGateway"]).toBe(true);
    expect(
      ((withGateway["extensions"] as Record<string, unknown>)["czar"] as Record<string, unknown>)[
        "routing"
      ],
    ).toEqual({ vaultDirect: true, gateway: true, upto: false });
    expect(validateDiscoveryIndexEntry(withGateway)).toEqual([]);
  });

  it("carries an operator-supplied serviceId and provider block when given, and omits them otherwise", async () => {
    const entries = await alphaEntries();
    const czar = (entries[0] as Record<string, unknown>)["extensions"] as Record<string, unknown>;
    expect(czar["czar"]).not.toHaveProperty("serviceId");
    expect(entries[0]).not.toHaveProperty("metadata.provider");

    const withIds = discoveryIndexEntry({
      paymentRequired: {
        x402Version: 2,
        error: "payment required",
        resource: {
          url: "https://merchants.testnet.czar.dev/v1/spot",
          description: "d",
          mimeType: "application/json",
          serviceName: "czar-spot",
          tags: ["price"],
        },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:5042002",
            amount: "50000",
            asset: "0x3600000000000000000000000000000000000000",
            payTo: ADDRESSES["K10:czar-spot"] as string,
            maxTimeoutSeconds: 300,
            extra: { name: "USDC", version: "2" },
          },
        ],
        extensions: {},
      },
      path: "/v1/spot",
      method: "GET",
      lastUpdated: LAST_UPDATED,
      supportsCircleGateway: false,
      serviceId: "svc_7f3a1b2c3d4e5f60718293a4b5c6d7e8",
      provider: {
        name: "Czar Merchants",
        website: "https://merchants.testnet.czar.dev",
        description: "Czar's own testnet merchants",
        category: "FINANCIAL_ANALYSIS",
        tags: ["price"],
      },
    });
    expect(
      ((withIds["extensions"] as Record<string, unknown>)["czar"] as Record<string, unknown>)[
        "serviceId"
      ],
    ).toBe("svc_7f3a1b2c3d4e5f60718293a4b5c6d7e8");
    expect((withIds["metadata"] as Record<string, unknown>)["provider"]).toMatchObject({
      name: "Czar Merchants",
    });
    expect(validateDiscoveryIndexEntry(withIds)).toEqual([]);
  });

  it("names every rule it checks when the item is malformed", () => {
    expect(validateDiscoveryIndexEntry(null)).toContain("item must be an object");
    expect(validateDiscoveryIndexEntry({})).toEqual(
      expect.arrayContaining([
        "resource must be an https or http url string",
        'type must be "http"',
        "x402Version must be 2",
        "lastUpdated must be an RFC 3339 instant",
        "accepts must hold at least one offer",
        "description must be a string",
        "mimeType must be a string",
        "serviceName must be a string",
        "tags must be an array of strings",
        "metadata must be an object the Circle CLI can read",
        "extensions.czar must be an object",
        'extensions.czar.source must be "czar-registered" for a Czar-run service',
      ]),
    );
  });

  it("names the metadata and czar rules a half-built item breaks", () => {
    const problems = validateDiscoveryIndexEntry({
      resource: "https://merchants.testnet.czar.dev/v1/spot",
      type: "http",
      x402Version: 2,
      lastUpdated: LAST_UPDATED,
      accepts: [{ scheme: "exact", network: "eip155:5042002", amount: "50.0", payTo: 7 }],
      description: "d",
      mimeType: "application/json",
      serviceName: "czar-spot",
      tags: [],
      metadata: { path: "v1/spot", method: "PUT", siwx: "no" },
      extensions: {
        czar: { source: "circle-live", rail: "carrier-pigeon", routing: {}, serviceId: "svc_nope" },
      },
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        "accepts[].asset must be a string (02 §11.1)",
        "accepts[].payTo must be a string (02 §11.1)",
        "accepts[].amount must be an Amount6 integer string",
        "accepts[].maxTimeoutSeconds must be a number",
        "metadata.path must be the route path",
        "metadata.method must be the route method",
        "metadata.siwx must be a boolean",
        "metadata.supportsVanillax402 must be a boolean",
        "metadata.supportsCircleGateway must be a boolean",
        'extensions.czar.source must be "czar-registered" for a Czar-run service',
        'extensions.czar.rail must be "x402-exact" or "gateway-batched" (AM-17)',
        "extensions.czar.routing.vaultDirect must be a boolean",
        "extensions.czar.serviceId must be an SL ServiceId (svc_ plus 32 hex)",
      ]),
    );
  });
});
