// Discovery-index entries for the routes this merchant process serves (CZ-20 §5.8, 02 §12.2).
//
// One item per route, in the single shape both readers accept: the x402 SDK's top-level fields plus
// `extensions.bazaar`, and Circle's non-spec `metadata` object. `metadata.supportsVanillax402` and
// `metadata.supportsCircleGateway` are derived from the live 402 of the route, never typed by hand (p1-D7),
// which is why this module takes the `PaymentRequiredV2` the route actually answers with.
//
// Fields 02 §12.2 lists that this process cannot know are left out rather than filled with a guess:
// `extensions.czar.serviceId` (in Phase 1 the operator's `selection.czarRegisteredServices` key, SCR-131),
// `claim`, `evidence`, `card`, and `metadata.provider`. Each is accepted as an input, so the caller that
// does know it can supply it.
import type { PaymentRequiredV2 } from "@czar/x402";
import type { RouteMethod } from "./vanilla-route.ts";

/** `extensions.czar.rail` for a vanilla `exact` route (AM-17). */
export const RAIL_VANILLA = "x402-exact";
/** `extensions.czar.source` for a service Czar runs and registered itself (SL-C2 source 1). */
export const SOURCE_CZAR_REGISTERED = "czar-registered";
/** `extensions.czar.source` for a Czar-run test merchant of the lab (CZ-20 §5.8a, D83). */
export const SOURCE_TEST_MERCHANT = "czar-test-merchant";

export interface ProviderMetadata {
  readonly name: string;
  readonly website?: string;
  readonly docsUrl?: string;
  readonly openApiUrl?: string;
  readonly description?: string;
  readonly category?: string;
  readonly tags?: readonly string[];
}

export interface DiscoveryIndexEntryInput {
  /** The live 402 of this route. */
  readonly paymentRequired: PaymentRequiredV2;
  readonly path: string;
  readonly method: RouteMethod;
  /** RFC 3339 instant the entry was built. */
  readonly lastUpdated: string;
  /** True only when a Gateway route of this service answered its own live 402 (p1-D7). */
  readonly supportsCircleGateway: boolean;
  readonly serviceId?: string;
  readonly provider?: ProviderMetadata;
  /** A lab service (CZ-20 §5.8a): `source` becomes `czar-test-merchant` and `testMerchant` is `true`. */
  readonly testMerchant?: boolean;
}

export type DiscoveryIndexEntry = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function discoveryIndexEntry(input: DiscoveryIndexEntryInput): DiscoveryIndexEntry {
  const resource = input.paymentRequired.resource;
  const bazaar = isObject(input.paymentRequired.extensions)
    ? input.paymentRequired.extensions["bazaar"]
    : undefined;
  const bazaarInput =
    isObject(bazaar) && isObject(bazaar["info"]) ? bazaar["info"]["input"] : undefined;
  const supportsVanillax402 = input.paymentRequired.accepts.some(
    (offer) => offer.scheme === "exact",
  );
  return {
    resource: resource.url,
    type: "http",
    x402Version: 2,
    lastUpdated: input.lastUpdated,
    accepts: input.paymentRequired.accepts,
    description: resource.description,
    mimeType: resource.mimeType,
    serviceName: resource.serviceName,
    tags: resource.tags,
    extensions: {
      ...(bazaar === undefined ? {} : { bazaar }),
      czar: {
        ...(input.serviceId === undefined ? {} : { serviceId: input.serviceId }),
        source: input.testMerchant === true ? SOURCE_TEST_MERCHANT : SOURCE_CZAR_REGISTERED,
        ...(input.testMerchant === true ? { testMerchant: true } : {}),
        rail: RAIL_VANILLA,
        routing: {
          vaultDirect: supportsVanillax402,
          gateway: input.supportsCircleGateway,
          upto: false,
        },
      },
    },
    metadata: {
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      path: input.path,
      method: input.method,
      description: resource.description,
      mimeType: resource.mimeType,
      ...(bazaarInput === undefined ? {} : { input: bazaarInput }),
      siwx: false,
      supportsVanillax402,
      supportsCircleGateway: input.supportsCircleGateway,
    },
  };
}

/**
 * The 02 §12.2 rules this process can check without a reader: every field the table marks as served by
 * both readers, and the Czar and Circle fields CZ-20 §5.8 requires on a `czar-registered` item. Returns
 * one message per broken rule; an empty list means the item is valid.
 */
export function validateDiscoveryIndexEntry(item: unknown): readonly string[] {
  if (!isObject(item)) return ["item must be an object"];
  const problems: string[] = [];
  const url = item["resource"];
  if (typeof url !== "string" || !/^https?:\/\//.test(url))
    problems.push("resource must be an https or http url string");
  if (item["type"] !== "http") problems.push('type must be "http"');
  if (item["x402Version"] !== 2) problems.push("x402Version must be 2");
  if (typeof item["lastUpdated"] !== "string" || !RFC3339.test(item["lastUpdated"]))
    problems.push("lastUpdated must be an RFC 3339 instant");
  const accepts = item["accepts"];
  if (!Array.isArray(accepts) || accepts.length === 0)
    problems.push("accepts must hold at least one offer");
  else
    for (const offer of accepts) {
      if (!isObject(offer)) {
        problems.push("every accepts entry must be a PaymentRequirements object");
        continue;
      }
      for (const field of ["scheme", "network", "amount", "asset", "payTo"])
        if (typeof offer[field] !== "string")
          problems.push(`accepts[].${field} must be a string (02 §11.1)`);
      if (typeof offer["amount"] === "string" && !/^(0|[1-9][0-9]*)$/.test(offer["amount"]))
        problems.push("accepts[].amount must be an Amount6 integer string");
      if (typeof offer["maxTimeoutSeconds"] !== "number")
        problems.push("accepts[].maxTimeoutSeconds must be a number");
    }
  for (const field of ["description", "mimeType", "serviceName"])
    if (typeof item[field] !== "string") problems.push(`${field} must be a string`);
  if (!Array.isArray(item["tags"])) problems.push("tags must be an array of strings");

  const metadata = item["metadata"];
  if (!isObject(metadata)) {
    problems.push("metadata must be an object the Circle CLI can read");
  } else {
    if (typeof metadata["path"] !== "string" || !metadata["path"].startsWith("/"))
      problems.push("metadata.path must be the route path");
    if (metadata["method"] !== "GET" && metadata["method"] !== "POST")
      problems.push("metadata.method must be the route method");
    if (typeof metadata["siwx"] !== "boolean") problems.push("metadata.siwx must be a boolean");
    if (typeof metadata["supportsVanillax402"] !== "boolean")
      problems.push("metadata.supportsVanillax402 must be a boolean");
    if (typeof metadata["supportsCircleGateway"] !== "boolean")
      problems.push("metadata.supportsCircleGateway must be a boolean");
    if (metadata["provider"] !== undefined && !isObject(metadata["provider"]))
      problems.push("metadata.provider must be an object when present");
  }

  const extensions = item["extensions"];
  const czar = isObject(extensions) ? extensions["czar"] : undefined;
  if (!isObject(czar)) {
    problems.push("extensions.czar must be an object");
    problems.push('extensions.czar.source must be "czar-registered" for a Czar-run service');
  } else {
    const testMerchant = czar["source"] === SOURCE_TEST_MERCHANT;
    if (czar["source"] !== SOURCE_CZAR_REGISTERED && !testMerchant)
      problems.push('extensions.czar.source must be "czar-registered" for a Czar-run service');
    if (testMerchant && czar["testMerchant"] !== true)
      problems.push(
        'extensions.czar.testMerchant must be true when source is "czar-test-merchant"',
      );
    if (!testMerchant && czar["testMerchant"] !== undefined)
      problems.push(
        'extensions.czar.testMerchant is only allowed when source is "czar-test-merchant"',
      );
    if (
      czar["rail"] !== undefined &&
      czar["rail"] !== RAIL_VANILLA &&
      czar["rail"] !== "gateway-batched"
    )
      problems.push('extensions.czar.rail must be "x402-exact" or "gateway-batched" (AM-17)');
    const routing = czar["routing"];
    if (!isObject(routing)) problems.push("extensions.czar.routing must be an object");
    else
      for (const field of ["vaultDirect", "gateway", "upto"])
        if (typeof routing[field] !== "boolean")
          problems.push(`extensions.czar.routing.${field} must be a boolean`);
    if (czar["serviceId"] !== undefined && !/^svc_[0-9a-f]{32}$/.test(String(czar["serviceId"])))
      problems.push("extensions.czar.serviceId must be an SL ServiceId (svc_ plus 32 hex)");
  }
  return problems;
}
