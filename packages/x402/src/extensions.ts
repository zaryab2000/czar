// Sanitizing untrusted seller extensions and resource metadata (02 §11.3, A3-36). Extensions are data,
// never instructions. Only `payment-identifier` is acted on in Phases 1–2; unknown keys are dropped.
import { Ajv2020 } from "ajv/dist/2020.js";
import { isValidRouteTemplate, sanitizeResourceServiceMetadata } from "@x402/extensions";
import { PAYMENT_IDENTIFIER } from "@x402/extensions/payment-identifier";

export const MAX_SCHEMA_BYTES = 8 * 1024;

export interface SanitizedExtensions {
  /** Present only when the declaration validated against its own schema. */
  readonly paymentIdentifier?: { readonly required: boolean };
  /** Present only when valid; never forwarded to the planner. */
  readonly bazaar?: {
    readonly info: unknown;
    readonly schema: Readonly<Record<string, unknown>>;
    readonly routeTemplate?: string;
  };
  /** Names of declared extensions that were dropped or ignored. */
  readonly dropped: readonly string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True when any `$ref` or `$id` points outside the document (02 §11.3). */
function hasExternalReference(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasExternalReference);
  if (!isObject(node)) return false;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && (typeof value !== "string" || !value.startsWith("#"))) return true;
    if (key === "$id" || key === "$dynamicRef" || key === "$recursiveRef") return true;
    if (hasExternalReference(value)) return true;
  }
  return false;
}

/** `info` must validate against the declared `schema`, with no remote loading. */
function validates(info: unknown, schema: unknown): boolean {
  if (!isObject(schema) || hasExternalReference(schema)) return false;
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_SCHEMA_BYTES) return false;
  try {
    const ajv = new Ajv2020({
      strict: false,
      allErrors: false,
      validateSchema: true,
    });
    const { $schema: _ignored, ...local } = schema;
    return ajv.compile(local)(info) === true;
  } catch {
    return false;
  }
}

export function sanitizeExtensions(extensions: unknown): SanitizedExtensions {
  if (!isObject(extensions)) return { dropped: [] };
  const dropped: string[] = [];
  let paymentIdentifier: SanitizedExtensions["paymentIdentifier"];
  let bazaar: SanitizedExtensions["bazaar"];
  for (const [name, declaration] of Object.entries(extensions)) {
    const ok = isObject(declaration) && validates(declaration["info"], declaration["schema"]);
    if (name === PAYMENT_IDENTIFIER && ok) {
      const info = (declaration as { info: Record<string, unknown> }).info;
      if (typeof info["required"] === "boolean") {
        paymentIdentifier = { required: info["required"] };
        continue;
      }
    }
    if (name === "bazaar" && ok) {
      const route = (declaration as Record<string, unknown>)["routeTemplate"];
      if (route === undefined || (typeof route === "string" && isValidRouteTemplate(route))) {
        bazaar = {
          info: (declaration as Record<string, unknown>)["info"],
          schema: (declaration as Record<string, unknown>)["schema"] as Record<string, unknown>,
          ...(typeof route === "string" ? { routeTemplate: route } : {}),
        };
        continue;
      }
    }
    dropped.push(name);
  }
  return {
    ...(paymentIdentifier ? { paymentIdentifier } : {}),
    ...(bazaar ? { bazaar } : {}),
    dropped,
  };
}

export interface SanitizedResource {
  readonly url: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly serviceName?: string;
  readonly tags?: readonly string[];
  readonly iconUrl?: string;
}

/** `sanitizeResourceServiceMetadata` from @x402/extensions 2.28.0, plus the plain url, description and mime type. */
export function sanitizeResource(resource: Record<string, unknown>): SanitizedResource {
  const metadata = sanitizeResourceServiceMetadata(resource as never) as {
    serviceName?: string;
    tags?: string[];
    iconUrl?: string;
  };
  const text = (key: string) =>
    typeof resource[key] === "string" ? (resource[key] as string) : undefined;
  const out: Record<string, unknown> = { url: text("url") ?? "" };
  for (const key of ["description", "mimeType"]) if (text(key) !== undefined) out[key] = text(key);
  if (metadata.serviceName !== undefined) out["serviceName"] = metadata.serviceName;
  if (metadata.tags !== undefined && metadata.tags.length > 0) out["tags"] = metadata.tags;
  if (metadata.iconUrl !== undefined) out["iconUrl"] = metadata.iconUrl;
  return out as unknown as SanitizedResource;
}
