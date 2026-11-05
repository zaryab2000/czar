// The public-alpha service list: `czar-search`, `czar-spot` and `czar-extract` (CZ-20 §5.1), plus the
// test-merchant lab (CZ-20 §5.8a) when the caller asks for it.
//
// This is the composition the cloud entry and the tests call. `local-main.ts` does not: it keeps calling
// `createMerchantServer` with no service list, which serves `czar-search` alone, because the local signer
// knows only that one K10 service (`apps/signer/src/local-main.ts:58`) and the local process would
// otherwise stop at startup with `merchant_signer_unavailable`. Putting the new services into the local
// stack needs new K10 entries under `ops/local/**`, which this task does not own.
import { createSafeFetch, type SafeFetch } from "@czar/x402";
import { createExtractRoute, EXTRACT_PATH } from "./extract/index.ts";
import { resolveLabServices, type LabRegistration } from "./lab/register.ts";
import { createSpotRoute, SPOT_PATH } from "./spot/index.ts";
import {
  createMerchantServer,
  searchServiceSpec,
  type MerchantRuntime,
  type MerchantServerOptions,
  type MerchantServiceSpec,
} from "./runtime.ts";

/** The service ids this process serves, in registration order; each needs its own `K10:<id>` key. */
export const ALPHA_SERVICE_IDS = ["czar-search", "czar-spot", "czar-extract"] as const;

/**
 * `czar-spot` (CZ-20 §5.1, D49). The public source is read through `safeFetch`, so the price fetch obeys
 * the same https-only, no-private-range rules as every other outbound call.
 */
export function spotServiceSpec(safeFetch: SafeFetch): MerchantServiceSpec {
  return {
    serviceName: "czar-spot",
    build: (context) =>
      createSpotRoute({
        resourceUrl: context.resourceUrl(SPOT_PATH),
        network: context.network,
        payTo: context.payTo,
        priceAtomic: String(context.config.get("merchants.spotPriceAtomic")),
        maxTimeoutSeconds: Number(context.config.get("merchants.maxTimeoutSeconds")),
        handlerTimeoutMs: Number(context.config.get("merchants.handlerTimeoutMs")),
        perPayerPerMin: Number(context.config.get("merchants.perPayerPerMin")),
        facilitator: context.facilitator,
        store: context.store,
        emit: context.emit,
        safeFetch,
        sourceUrlTemplate: String(context.config.get("merchants.spotSourceUrl")),
        pairs: context.config.get("merchants.spotPairs") as readonly string[],
        refreshSeconds: Number(context.config.get("merchants.spotRefreshSeconds")),
      }),
  };
}

/** `czar-extract` (CZ-20 §5.1, §5.7, D84). Every fetch goes through `safeFetch`; there is no other path. */
export function extractServiceSpec(safeFetch: SafeFetch): MerchantServiceSpec {
  return {
    serviceName: "czar-extract",
    build: (context) =>
      createExtractRoute({
        resourceUrl: context.resourceUrl(EXTRACT_PATH),
        network: context.network,
        payTo: context.payTo,
        priceAtomic: String(context.config.get("merchants.extractPriceAtomic")),
        maxTimeoutSeconds: Number(context.config.get("merchants.maxTimeoutSeconds")),
        handlerTimeoutMs: Number(context.config.get("merchants.handlerTimeoutMs")),
        perPayerPerMin: Number(context.config.get("merchants.perPayerPerMin")),
        facilitator: context.facilitator,
        store: context.store,
        emit: context.emit,
        safeFetch,
        maxChars: Number(context.config.get("merchants.extractMaxChars")),
        maxBytes: Number(context.config.get("merchants.extractMaxBytes")),
        timeoutMs: Number(context.config.get("merchants.extractTimeoutMs")),
      }),
  };
}

export interface AlphaMerchantServerOptions extends Omit<MerchantServerOptions, "services"> {
  /**
   * The shared `safeFetch`. It must be built with `maxRedirects` = `merchants.extractMaxRedirects`
   * (redirect depth is a safeFetch dependency, not a per-call option). Left out, one is built from the
   * `merchants.extract*` keys with no loopback origin allowed.
   */
  readonly safeFetch?: SafeFetch;
  /** `User-Agent: Czar/<version>` for the shared `safeFetch`. */
  readonly version?: string;
  /**
   * Asks for the test-merchant lab (CZ-20 §5.8a). Left out, the lab is not registered and no lab key is
   * looked up. Even when asked for, it stays off if `merchants.lab.enabled` is `false` or the payment network
   * is not a test chain.
   */
  readonly lab?: LabRegistration;
}

export async function createAlphaMerchantServer(
  options: AlphaMerchantServerOptions,
): Promise<MerchantRuntime> {
  const { safeFetch: given, version, lab, ...serverOptions } = options;
  const safeFetch =
    given ??
    createSafeFetch({
      // No loopback origin is allowed: a merchant fetches public https pages only (D84).
      localMerchantOrigins: [],
      maxRedirects: Number(options.config.get("merchants.extractMaxRedirects")),
      maxBytes: Number(options.config.get("merchants.extractMaxBytes")),
      timeoutMs: Number(options.config.get("merchants.extractTimeoutMs")),
      version: version ?? "0.0.0",
    });
  const labServices = await resolveLabServices({
    config: options.config,
    signer: options.signer,
    logger: options.logger,
    safeFetch,
    lab,
  });
  return createMerchantServer({
    ...serverOptions,
    services: [
      searchServiceSpec,
      spotServiceSpec(safeFetch),
      extractServiceSpec(safeFetch),
      ...labServices,
    ],
  });
}
