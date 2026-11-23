// MR-04 / SCR-182 §7: the audit merchants' catalog entries in env/local.toml and env/cloud.example.toml
// point at the routes the merchants serve, carry SL §5.1 service ids, and each entry's probe gets exactly
// one valid 402 offer on the Arc testnet. No network calls.
import { describe, expect, it } from "vitest";
import { loadConfigFile } from "@czar/config";
import { readPaymentRequired, USDC_ADDRESS } from "@czar/x402";
import { keccak256, toBytes } from "viem";
import { AUDIT_KINDS, AUDIT_SERVICES, createAuditRoute } from "../src/audit/index.ts";
import { mockFacilitator, NETWORK, PAY_TO, testStore } from "./x402-doubles.ts";

interface Registration {
  readonly serviceName: string;
  readonly resource: { readonly url: string; readonly method: string };
  readonly probeInput: { readonly body?: Record<string, unknown> };
  readonly capabilities: readonly string[];
}

/** The registration time both files' audit ids were derived with (see the comments in each file). */
const REGISTERED_AT = "2026-11-05T13:41:25.000Z";
const FILES = {
  "env/local.toml": new URL("../../../env/local.toml", import.meta.url),
  "env/cloud.example.toml": new URL("../../../env/cloud.example.toml", import.meta.url),
};

/** SL §5.1 (SCR-137): "svc_" + hex(keccak256(utf8(origin ‖ method ‖ path ‖ first_seen_ts)))[0:32]. */
const slServiceId = (origin: string, method: string, path: string, at: string) =>
  `svc_${keccak256(toBytes(`${origin}${method}${path}${at}`)).slice(2, 34)}`;

async function auditEntries(file: URL) {
  const config = await loadConfigFile(file);
  const services = config.get("selection.czarRegisteredServices") as Record<string, Registration>;
  const entries = Object.entries(services).filter(([, entry]) =>
    entry.serviceName.startsWith("czar-audit-"),
  );
  return { config, origin: String(config.get("merchants.publicOrigin")), entries };
}

describe.each(Object.entries(FILES))("audit catalog entries in %s (SCR-182 §7)", (_name, file) => {
  it("registers each audit service once, at its route, with the code-review capability and the probe input", async () => {
    const { origin, entries } = await auditEntries(file);
    expect(entries.map(([, entry]) => entry.serviceName).toSorted()).toEqual(
      AUDIT_KINDS.map((kind) => AUDIT_SERVICES[kind].serviceName).toSorted(),
    );
    for (const [serviceId, entry] of entries) {
      const service = Object.values(AUDIT_SERVICES).find(
        (candidate) => candidate.serviceName === entry.serviceName,
      );
      if (service === undefined) throw new Error(`unknown service ${entry.serviceName}`);
      expect(entry).toEqual({
        serviceName: service.serviceName,
        resource: { url: `${origin}${service.path}`, method: "POST" },
        probeInput: { body: { contract: "contract Probe {}" } },
        capabilities: ["code-review"],
      });
      expect(serviceId).toBe(slServiceId(origin, "POST", service.path, REGISTERED_AT));
    }
  });

  it("each entry's probe gets exactly one valid 402 offer, at the configured price, on the Arc testnet", async () => {
    const { config, entries } = await auditEntries(file);
    for (const kind of AUDIT_KINDS) {
      const service = AUDIT_SERVICES[kind];
      const entry = entries.find(([, candidate]) => candidate.serviceName === service.serviceName);
      if (entry === undefined) throw new Error(`no entry for ${service.serviceName}`);
      const [, registration] = entry;
      const merchant = createAuditRoute({
        kind,
        resourceUrl: registration.resource.url,
        network: NETWORK,
        payTo: PAY_TO,
        priceAtomic: String(config.get(`merchants.audit.${kind}.priceAtomic`)),
        maxTimeoutSeconds: 300,
        facilitator: mockFacilitator().facilitator,
        store: testStore(),
        model: {
          complete: async () => {
            throw new Error("a probe never reaches the model");
          },
        },
        modelId: String(config.get(`merchants.audit.${kind}.model`)),
        maxFindings: Number(config.get(`merchants.audit.${kind}.maxFindings`)),
        maxInputChars: Number(config.get("merchants.audit.maxInputChars")),
        maxOutputTokens: Number(config.get("merchants.audit.maxOutputTokens")),
        handlerTimeoutMs: Number(config.get("merchants.audit.handlerTimeoutMs")),
        dailyModelCallCap: Number(config.get("merchants.audit.dailyModelCallCap")),
      });
      const response = await merchant.handle(
        new Request(registration.resource.url, {
          method: registration.resource.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(registration.probeInput.body),
        }),
      );
      expect(response.status).toBe(402);
      const read = readPaymentRequired({
        status: response.status,
        headers: response.headers,
        body: await response.text(),
      });
      if (!read.ok) throw new Error(`probe 402 did not parse: ${read.reason}`);
      expect(read.paymentRequired.accepts).toHaveLength(1);
      expect(read.paymentRequired.accepts[0]).toMatchObject({
        scheme: "exact",
        network: "eip155:5042002",
        asset: USDC_ADDRESS,
        amount: String(config.get(`merchants.audit.${kind}.priceAtomic`)),
      });
    }
  });
});
