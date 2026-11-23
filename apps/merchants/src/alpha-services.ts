// The public-alpha service list: `czar-search`, `czar-spot` and `czar-extract` (CZ-20 §5.1), the two audit
// merchants `czar-audit-quick` and `czar-audit-deep` when each is switched on (SCR-182 §1), plus the
// test-merchant lab (CZ-20 §5.8a) when the caller asks for it.
//
// This is the composition the cloud entry and the tests call. `local-main.ts` does not: it keeps calling
// `createMerchantServer` with no service list, which serves `czar-search` alone, because the local signer
// knows only that one K10 service (`apps/signer/src/local-main.ts:58`) and the local process would
// otherwise stop at startup with `merchant_signer_unavailable`. Putting the new services into the local
// stack needs new K10 entries under `ops/local/**`, which this task does not own.
import { readFile } from "node:fs/promises";
import type { Config } from "@czar/config";
import { createSafeFetch, type SafeFetch } from "@czar/x402";
import {
  AUDIT_KINDS,
  AUDIT_SERVICES,
  auditApiKeyReader,
  createAnthropicAuditModel,
  createAuditModelFetch,
  createAuditRoute,
  type AuditKind,
  type AuditModel,
} from "./audit/index.ts";
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

/**
 * The service ids this process can serve, in registration order; each needs its own `K10:<id>` key. The
 * audit services are served, and their keys looked up, only when switched on.
 */
export const ALPHA_SERVICE_IDS = [
  "czar-search",
  "czar-spot",
  "czar-extract",
  AUDIT_SERVICES.quick.serviceName,
  AUDIT_SERVICES.deep.serviceName,
] as const;

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

/**
 * `czar-audit-quick` or `czar-audit-deep` (SCR-182 §1–§4). A contract address is looked up through the
 * shared `safeFetch`, and only when `merchants.audit.addressLookupEnabled` is on.
 */
export function auditServiceSpec(
  kind: AuditKind,
  model: AuditModel,
  safeFetch: SafeFetch,
): MerchantServiceSpec {
  return {
    serviceName: AUDIT_SERVICES[kind].serviceName,
    build: (context) =>
      createAuditRoute({
        kind,
        resourceUrl: context.resourceUrl(AUDIT_SERVICES[kind].path),
        network: context.network,
        payTo: context.payTo,
        priceAtomic: String(context.config.get(`merchants.audit.${kind}.priceAtomic`)),
        maxTimeoutSeconds: Number(context.config.get("merchants.maxTimeoutSeconds")),
        perPayerPerMin: Number(context.config.get("merchants.perPayerPerMin")),
        facilitator: context.facilitator,
        store: context.store,
        emit: context.emit,
        model,
        modelId: String(context.config.get(`merchants.audit.${kind}.model`)),
        maxFindings: Number(context.config.get(`merchants.audit.${kind}.maxFindings`)),
        maxInputChars: Number(context.config.get("merchants.audit.maxInputChars")),
        maxOutputTokens: Number(context.config.get("merchants.audit.maxOutputTokens")),
        handlerTimeoutMs: Number(context.config.get("merchants.audit.handlerTimeoutMs")),
        dailyModelCallCap: Number(context.config.get("merchants.audit.dailyModelCallCap")),
        ...(context.config.get("merchants.audit.addressLookupEnabled") === true
          ? {
              addressLookup: {
                safeFetch,
                urlTemplate: String(context.config.get("merchants.audit.sourceLookupUrlTemplate")),
                maxSourceChars: Number(context.config.get("merchants.extractMaxChars")),
              },
            }
          : {}),
      }),
  };
}

/** The switched-on audit services, checked before anything listens. */
function enabledAuditKinds(config: Config): AuditKind[] {
  const kinds = AUDIT_KINDS.filter(
    (kind) => config.get(`merchants.audit.${kind}.enabled`) === true,
  );
  if (kinds.length > 0 && config.get("merchants.audit.addressLookupEnabled") === true) {
    const template = String(config.get("merchants.audit.sourceLookupUrlTemplate"));
    if (!template.startsWith("https://") || !template.includes("{address}"))
      throw new Error(
        "merchants.audit.sourceLookupUrlTemplate must be an https URL containing {address} when the address lookup is on",
      );
  }
  return kinds;
}

/**
 * The Anthropic client the audit services share (SCR-182 §4): its own no-redirect safeFetch, the key read
 * from `merchants.audit.anthropicApiKeyFile` in the merchants' credential folder on the first call. The
 * reply is bounded by `merchants.extractMaxBytes`, the merchants' existing fetch byte cap.
 */
function anthropicAuditModel(
  config: Config,
  credentialFolder: string | undefined,
  version: string,
): AuditModel {
  if (credentialFolder === undefined)
    throw new Error(
      "the audit merchants need the merchants' credential folder for their API key file",
    );
  return createAnthropicAuditModel({
    safeFetch: createAuditModelFetch({
      maxBytes: Number(config.get("merchants.extractMaxBytes")),
      timeoutMs: Number(config.get("merchants.audit.handlerTimeoutMs")),
      version,
    }),
    baseUrl: String(config.get("models.anthropic.baseUrl")),
    readApiKey: auditApiKeyReader({
      folder: credentialFolder,
      fileName: String(config.get("merchants.audit.anthropicApiKeyFile")),
      readFile: (path) => readFile(path, "utf8"),
    }),
  });
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
  /** The audit merchants' model client. Left out, an Anthropic client is built from config. */
  readonly auditModel?: AuditModel;
  /**
   * The merchants' own folder in `deploy.credentialFilesDir` (SCR-170 §4), which holds the audit API key
   * file. Needed only when an audit service is switched on and no `auditModel` is given.
   */
  readonly credentialFolder?: string;
}

export async function createAlphaMerchantServer(
  options: AlphaMerchantServerOptions,
): Promise<MerchantRuntime> {
  const {
    safeFetch: given,
    version,
    lab,
    auditModel: givenModel,
    credentialFolder,
    ...serverOptions
  } = options;
  const auditKinds = enabledAuditKinds(options.config);
  const auditModel =
    auditKinds.length === 0
      ? undefined
      : (givenModel ?? anthropicAuditModel(options.config, credentialFolder, version ?? "0.0.0"));
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
      ...(auditModel === undefined
        ? []
        : auditKinds.map((kind) => auditServiceSpec(kind, auditModel, safeFetch))),
      ...labServices,
    ],
  });
}
