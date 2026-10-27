import type { Config } from "@czar/config";
import { createSafeFetchFromConfig, readPaymentRequired, type SafeFetchError } from "@czar/x402";
import type { PlannerService, ProbeResult } from "#src/planner/ports";

export function createSafeProber(config: Config) {
  const safeFetch = createSafeFetchFromConfig(config, "czar-server/planner");
  return {
    async probe(
      resource: PlannerService["resource"],
      probeInput?: PlannerService["probeInput"],
    ): Promise<ProbeResult> {
      try {
        const url = new URL(resource.url);
        if (resource.method === "GET") {
          for (const [key, value] of Object.entries(probeInput?.query ?? {}))
            url.searchParams.set(key, value);
        }
        const body = resource.method === "POST" ? probeInput?.body : undefined;
        const response = await safeFetch(url.toString(), {
          method: resource.method,
          timeoutMs: config.get("planner.probeTimeoutMs") as number,
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: Buffer.from(JSON.stringify(body)),
              }),
        });
        const parsed = readPaymentRequired({
          status: response.status,
          headers: response.headers,
          body: Buffer.from(response.body).toString("utf8"),
        });
        return parsed.ok
          ? { ok: true, offers: parsed.paymentRequired.accepts }
          : { ok: false, reason: "malformed" };
      } catch (error) {
        return {
          ok: false,
          reason: isTimeout(error) ? "timeout" : "unavailable",
        };
      }
    },
  };
}

function isTimeout(error: unknown): error is SafeFetchError {
  return typeof error === "object" && error !== null && "rule" in error && error.rule === "timeout";
}
