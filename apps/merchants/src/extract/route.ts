// `czar-extract` vanilla x402 route, `POST /v1/extract` body `{url}` → `{title, text, links[], untrusted}`
// (CZ-20 §5.1, §5.7, D84). Every fetch goes through `safeFetch` (`@czar/x402`), which is what enforces
// https only, pinned DNS, blocked private/loopback/link-local/ULA/CGNAT ranges, re-checked redirects and
// the byte and time caps (cross-cutting §2.1, RV-022). There is no way round it and no switch that skips it:
// this route holds no other fetch of any kind.
//
// D84 replaced the `merchants.extractAllowlist` domain list: any public https page may be fetched. A page's
// contents are data (CZ-20 §5.7); the route never acts on anything it reads.
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { Facilitator } from "@czar/merchants/facilitator";
import type { PaymentIdStore } from "@czar/merchants/payment-id-store";
import { isBlockedAddress, type SafeFetch } from "@czar/x402";
import {
  createVanillaRoute,
  readJsonBody,
  type EmitEvent,
  type MerchantService,
  type ParsedInput,
} from "@czar/merchants/vanilla-route";
import { readPage, type PageRead } from "./read-page.ts";

export const EXTRACT_PATH = "/v1/extract";
/** A URL longer than this is refused as input rather than fetched. */
export const MAX_URL_CHARS = 2048;
/** The request body is one short JSON object; nothing larger is parsed. */
export const MAX_BODY_BYTES = 8 * 1024;
const EXAMPLE_URL = "https://example.com/article";

export interface ExtractRouteOptions {
  /** Public URL of this resource, `https://merchants.<env>.czar.dev/v1/extract`. */
  readonly resourceUrl: string;
  readonly network: string;
  /** K10 payout address for czar-extract. */
  readonly payTo: string;
  /** `merchants.extractPriceAtomic`. */
  readonly priceAtomic: string;
  /** `merchants.maxTimeoutSeconds`. */
  readonly maxTimeoutSeconds: number;
  /** `merchants.handlerTimeoutMs`. */
  readonly handlerTimeoutMs: number;
  readonly perPayerPerMin?: number;
  readonly facilitator: Facilitator;
  readonly store: PaymentIdStore;
  readonly emit?: EmitEvent;
  /**
   * The shared `safeFetch`, built with `maxRedirects` = `merchants.extractMaxRedirects`
   * (redirect depth is a safeFetch dependency, not a per-call option).
   */
  readonly safeFetch: SafeFetch;
  /** `merchants.extractMaxChars`. */
  readonly maxChars: number;
  /** `merchants.extractMaxBytes`. */
  readonly maxBytes: number;
  /** `merchants.extractTimeoutMs`. */
  readonly timeoutMs: number;
}

/** The buyer input as `extensions.bazaar` (CZ-20 §4, 02 §12.2): `POST` with one JSON field `url`. */
function extractInputDeclaration(): unknown {
  const { bazaar } = declareDiscoveryExtension({
    bodyType: "json",
    input: { url: EXAMPLE_URL },
    inputSchema: {
      properties: {
        url: { type: "string", format: "uri", minLength: 1, maxLength: MAX_URL_CHARS },
      },
      required: ["url"],
      additionalProperties: false,
    },
  });
  const enrich = bazaarResourceServerExtension.enrichDeclaration;
  if (enrich === undefined) throw new Error("@x402/extensions bazaar has no enrichDeclaration");
  return enrich(bazaar, { method: "POST", adapter: { getPath: () => EXTRACT_PATH } });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The input rule a buyer sees as a 400, before any payment step: https only, no credentials, the default
 * port only, and never an address literal safeFetch would block anyway. safeFetch still runs on every
 * fetch; this only means a buyer is not charged for a URL that could never be fetched.
 */
export function publicHttpsUrl(raw: string): URL | null {
  if (raw.length === 0 || raw.length > MAX_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "" && url.port !== "443") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^[0-9.]+$/.test(host) || host.includes(":")) {
    if (isBlockedAddress(host)) return null;
  }
  return url;
}

/** Input is data: exactly `{url}`, bounded, parsed strictly, unknown keys rejected (CZ-20 §5.7). */
async function parseExtractBody(request: Request): Promise<ParsedInput<string>> {
  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok) return { ok: false, error: "expected a JSON body of at most 8 KiB" };
  const body = read.value;
  if (!isObject(body)) return { ok: false, error: "expected a JSON object body {url}" };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "url" || typeof body["url"] !== "string")
    return { ok: false, error: "expected exactly one body field url (a string)" };
  const url = publicHttpsUrl(body["url"]);
  if (url === null)
    return {
      ok: false,
      error: "url must be a public https page on the default port, with no credentials",
    };
  return { ok: true, input: url.href, hashed: { url: url.href } };
}

export function createExtractRoute(options: ExtractRouteOptions): MerchantService {
  async function handle(url: string): Promise<PageRead> {
    const response = await options.safeFetch(url, {
      method: "GET",
      headers: { accept: "text/html,application/xhtml+xml,text/plain" },
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs,
    });
    if (response.status !== 200) throw new Error("page did not answer 200");
    return readPage({
      html: new TextDecoder("utf-8").decode(response.body),
      baseUrl: response.url,
      maxChars: options.maxChars,
    });
  }

  return createVanillaRoute<string>({
    serviceName: "czar-extract",
    path: EXTRACT_PATH,
    method: "POST",
    description: "Read one public web page as plain text, with its title and links",
    tags: ["extract", "page-extract"],
    bazaar: extractInputDeclaration(),
    resourceUrl: options.resourceUrl,
    network: options.network,
    payTo: options.payTo,
    priceAtomic: options.priceAtomic,
    maxTimeoutSeconds: options.maxTimeoutSeconds,
    handlerTimeoutMs: options.handlerTimeoutMs,
    ...(options.perPayerPerMin === undefined ? {} : { perPayerPerMin: options.perPayerPerMin }),
    facilitator: options.facilitator,
    store: options.store,
    ...(options.emit === undefined ? {} : { emit: options.emit }),
    parse: parseExtractBody,
    handle,
  });
}
