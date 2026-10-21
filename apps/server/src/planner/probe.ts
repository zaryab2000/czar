import type { Config } from "@czar/config";
import { createSafeFetchFromConfig, readPaymentRequired, type SafeFetchError } from "@czar/x402";
import type { PlannerService, ProbeResult } from "#src/planner/ports";

export function createSafeProber(config: Config) {
  const safeFetch = createSafeFetchFromConfig(config, "czar-server/planner");
  return {
    async probe(resource: PlannerService["resource"]): Promise<ProbeResult> {
      try {
        const response = await safeFetch(resource.url, {
          method: resource.method,
          timeoutMs: config.get("planner.probeTimeoutMs") as number,
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
