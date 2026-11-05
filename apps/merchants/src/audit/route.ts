// The audit merchants, `czar-audit-quick` (A) and `czar-audit-deep` (B), on the shared vanilla x402
// lifecycle, unchanged (SCR-182 §1–§4; MR-01, MR-02, MR-05). `POST <path>` body `{contract}` → an
// `audit-report` the merchant validates before returning. A model error, a timeout or an invalid report is
// a handler failure, so nothing is settled and the buyer is not charged (A3-09).
//
// Checks that answer before any payment step: the body must be exactly `{contract}` within
// `merchants.audit.maxInputChars`; an address is refused when the lookup is off; and once a service has used
// `merchants.audit.dailyModelCallCap` model calls in the current UTC day it answers 503 with Retry-After.
// Only the service name, the input hash, the model id, token counts and the outcome are logged.
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { H, type Hash32 } from "@czar/hashing";
import { validateSchema } from "@czar/schemas";
import { readPaymentSignature, type PaymentRequiredV2, type SafeFetch } from "@czar/x402";
import { extractAndValidatePaymentIdentifier } from "@x402/extensions/payment-identifier";
import type { Facilitator } from "@czar/merchants/facilitator";
import { fingerprint, type PaymentIdStore } from "@czar/merchants/payment-id-store";
import {
  createVanillaRoute,
  readJsonBody,
  type EmitEvent,
  type MerchantService,
  type ParsedInput,
} from "@czar/merchants/vanilla-route";
import type { AuditModel, AuditModelReply } from "./model.ts";
import { auditOutputSchema, auditSystemPrompt, auditUserMessage } from "./prompt.ts";
import { AUDIT_SERVICES, type AuditKind } from "./services.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The probe input of the catalog entry (SCR-182 §2), also the discovery example. */
const EXAMPLE_CONTRACT = "contract Probe {}";
/** JSON escaping turns one character into at most six bytes (`\uXXXX`). */
const MAX_JSON_BYTES_PER_CHAR = 6;
/** The `{"contract":""}` wrapper and whitespace around it. */
const BODY_WRAPPER_BYTES = 64;
/** UTF-8 uses at most four bytes per character of a fetched source. */
const MAX_UTF8_BYTES_PER_CHAR = 4;
const MS_PER_DAY = 86_400_000;
const MS_PER_SECOND = 1000;

export interface AuditAddressLookup {
  /** The shared safeFetch; the verified source is read through it and nothing else. */
  readonly safeFetch: SafeFetch;
  /** `merchants.audit.sourceLookupUrlTemplate`; `{address}` is replaced by the address. */
  readonly urlTemplate: string;
  /**
   * The longest verified source the lookup reads. Address mode exists for contracts over the buyer's input
   * limit (SCR-181 §3), so this is not `merchants.audit.maxInputChars`. SCR-182 names no key for it; the
   * composition passes `merchants.extractMaxChars`, the merchants' existing bound on text read from a
   * fetched source.
   */
  readonly maxSourceChars: number;
}

export interface AuditRouteOptions {
  readonly kind: AuditKind;
  /** `merchants.publicOrigin` + the service path. */
  readonly resourceUrl: string;
  readonly network: string;
  /** The service's K10 payout address, from the signer. */
  readonly payTo: string;
  /** `merchants.audit.<kind>.priceAtomic`. */
  readonly priceAtomic: string;
  /** `merchants.maxTimeoutSeconds`. */
  readonly maxTimeoutSeconds: number;
  /** `merchants.perPayerPerMin`. */
  readonly perPayerPerMin?: number;
  readonly facilitator: Facilitator;
  readonly store: PaymentIdStore;
  readonly emit?: EmitEvent;
  readonly model: AuditModel;
  /** `merchants.audit.<kind>.model`. */
  readonly modelId: string;
  /** `merchants.audit.<kind>.maxFindings`. */
  readonly maxFindings: number;
  /** `merchants.audit.maxInputChars`. */
  readonly maxInputChars: number;
  /** `merchants.audit.maxOutputTokens`. */
  readonly maxOutputTokens: number;
  /** `merchants.audit.handlerTimeoutMs`: the whole handler, model call included. */
  readonly handlerTimeoutMs: number;
  /** `merchants.audit.dailyModelCallCap`. */
  readonly dailyModelCallCap: number;
  /** Present only when `merchants.audit.addressLookupEnabled` is true. */
  readonly addressLookup?: AuditAddressLookup;
  readonly now?: () => number;
}

const sameAddress = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** The buyer input as `extensions.bazaar` (02 §12.2): `POST` with exactly one string field, `contract`. */
function auditInputDeclaration(path: string, maxInputChars: number): unknown {
  const { bazaar } = declareDiscoveryExtension({
    bodyType: "json",
    input: { contract: EXAMPLE_CONTRACT },
    inputSchema: {
      properties: { contract: { type: "string", minLength: 1, maxLength: maxInputChars } },
      required: ["contract"],
      additionalProperties: false,
    },
  });
  const enrich = bazaarResourceServerExtension.enrichDeclaration;
  if (enrich === undefined) throw new Error("@x402/extensions bazaar has no enrichDeclaration");
  return enrich(bazaar, { method: "POST", adapter: { getPath: () => path } });
}

/** Keeps the known finding fields only; the schema check then decides. */
function findingsOf(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((finding) => {
    if (!isObject(finding)) return finding;
    return Object.fromEntries(
      ["severity", "location", "issue", "fix"]
        .filter((field) => finding[field] !== undefined)
        .map((field) => [field, finding[field]]),
    );
  });
}

/** Reads a contract's verified source through the shared safeFetch, within the lookup's own limit. */
async function readVerifiedSource(lookup: AuditAddressLookup, address: string) {
  const response = await lookup.safeFetch(lookup.urlTemplate.replace("{address}", address), {
    maxBytes: lookup.maxSourceChars * MAX_UTF8_BYTES_PER_CHAR,
  });
  if (response.status !== 200) throw new Error("verified source not found");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
  if (source.length === 0 || source.length > lookup.maxSourceChars)
    throw new Error("verified source is empty or longer than the lookup limit");
  return source;
}

export function createAuditRoute(options: AuditRouteOptions): MerchantService {
  const service = AUDIT_SERVICES[options.kind];
  const emit = options.emit ?? (() => undefined);
  const now = options.now ?? Date.now;

  // The daily cap counts model calls per UTC day, in this process.
  let day = Number.NaN;
  let used = 0;
  const today = () => Math.floor(now() / MS_PER_DAY);
  const capReached = () => {
    if (today() !== day) {
      day = today();
      used = 0;
    }
    return used >= options.dailyModelCallCap;
  };
  const secondsToNextDay = () =>
    String(Math.ceil(((today() + 1) * MS_PER_DAY - now()) / MS_PER_SECOND));

  /** Input is data: exactly `{contract}`, bounded, parsed strictly, unknown keys rejected (CZ-20 §5.7). */
  async function parse(request: Request): Promise<ParsedInput<string>> {
    const read = await readJsonBody(
      request,
      options.maxInputChars * MAX_JSON_BYTES_PER_CHAR + BODY_WRAPPER_BYTES,
    );
    if (!read.ok) return { ok: false, error: "expected a JSON body {contract}" };
    const body = read.value;
    if (!isObject(body)) return { ok: false, error: "expected a JSON object body {contract}" };
    const keys = Object.keys(body);
    const contract = body["contract"];
    if (keys.length !== 1 || keys[0] !== "contract" || typeof contract !== "string")
      return { ok: false, error: "expected exactly one body field contract (a string)" };
    if (contract.length === 0 || contract.length > options.maxInputChars)
      return {
        ok: false,
        error: `contract must be between 1 and ${options.maxInputChars} characters`,
      };
    if (ADDRESS.test(contract) && options.addressLookup === undefined)
      return { ok: false, error: "address lookup is off: send the contract source" };
    return { ok: true, input: contract, hashed: { contract } };
  }

  async function review(contract: string): Promise<unknown> {
    const inputHash: Hash32 = H(contract);
    const log = (outcome: string, usage?: AuditModelReply["usage"]) =>
      emit("merchant.audit", {
        kind: service.serviceName,
        inputHash,
        model: options.modelId,
        ...(usage === undefined
          ? {}
          : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }),
        outcome,
      });

    let source = contract;
    if (ADDRESS.test(contract)) {
      const lookup = options.addressLookup;
      if (lookup === undefined) throw new Error("address lookup is off");
      try {
        source = await readVerifiedSource(lookup, contract);
      } catch (error) {
        log("lookup-failed");
        throw error;
      }
    }

    if (capReached()) {
      log("cap-reached");
      throw new Error("daily model call cap reached");
    }
    used += 1;

    let reply: AuditModelReply;
    try {
      reply = await options.model.complete({
        model: options.modelId,
        system: auditSystemPrompt(options.kind, options.maxFindings),
        user: auditUserMessage(source),
        outputSchema: auditOutputSchema(options.kind),
        maxOutputTokens: options.maxOutputTokens,
        timeoutMs: options.handlerTimeoutMs,
      });
    } catch (error) {
      log("model-error");
      throw new Error("audit model call failed", { cause: error });
    }

    let output: unknown;
    try {
      output = JSON.parse(reply.text);
    } catch {
      output = undefined;
    }
    const findings = isObject(output) ? findingsOf(output["findings"]) : undefined;
    const report = {
      schemaVersion: "1.0",
      service: service.serviceName,
      summary: isObject(output) ? output["summary"] : undefined,
      findings,
      inputHash,
      model: options.modelId,
      generatedAt: new Date(now()).toISOString(),
    };
    if (
      !Array.isArray(findings) ||
      findings.length > options.maxFindings ||
      !validateSchema("audit-report", report)
    ) {
      log("invalid-output", reply.usage);
      throw new Error("audit model answer is not a valid report");
    }
    log("report", reply.usage);
    return report;
  }

  const route = createVanillaRoute<string>({
    serviceName: service.serviceName,
    path: service.path,
    method: "POST",
    description: service.description,
    tags: service.tags,
    bazaar: auditInputDeclaration(service.path, options.maxInputChars),
    resourceUrl: options.resourceUrl,
    network: options.network,
    payTo: options.payTo,
    priceAtomic: options.priceAtomic,
    maxTimeoutSeconds: options.maxTimeoutSeconds,
    handlerTimeoutMs: options.handlerTimeoutMs,
    ...(options.perPayerPerMin === undefined ? {} : { perPayerPerMin: options.perPayerPerMin }),
    facilitator: options.facilitator,
    store: options.store,
    emit,
    parse,
    handle: review,
  });

  const offer = route.paymentRequired.accepts[0] as PaymentRequiredV2["accepts"][number];

  /**
   * At the cap, a call already paid for is still answered from the payment-identifier store, exactly as
   * the shared lifecycle would replay it (SCR-182 test 3): same offer check, same fingerprint, no model call
   * and no Facilitator call. A new identifier's claim is released, so it can be paid the next day.
   */
  async function storedReplay(request: Request): Promise<Response | undefined> {
    if (request.method !== "POST" || new URL(request.url).pathname !== service.path)
      return undefined;
    // The shared lifecycle's order: parse, the request event, then the payment checks.
    const parsed = await parse(request);
    if (!parsed.ok) return undefined;
    const inputHash = H(parsed.hashed);
    emit("merchant.request", { route: service.path, inputHash });
    const read = readPaymentSignature(request.headers);
    if (!read.ok) return undefined;
    const accepted = read.payload.accepted as unknown as Record<string, unknown>;
    if (
      accepted["scheme"] !== offer.scheme ||
      accepted["network"] !== offer.network ||
      accepted["amount"] !== offer.amount ||
      !sameAddress(accepted["asset"], offer.asset) ||
      !sameAddress(accepted["payTo"], offer.payTo)
    )
      return undefined;
    const { id, validation } = extractAndValidatePaymentIdentifier(read.payload as never);
    if (!validation.valid || id === null) return undefined;
    const claim = await options.store.claim(
      service.path,
      id,
      fingerprint({
        scheme: offer.scheme,
        network: offer.network,
        asset: offer.asset.toLowerCase(),
        amount: offer.amount,
        payTo: offer.payTo.toLowerCase(),
        route: service.path,
        method: "POST",
        inputHash,
      }),
    );
    if (claim.kind === "replay") {
      emit("merchant.served", { route: service.path, inputHash, replay: true });
      return new Response(claim.response.body, {
        status: claim.response.status,
        headers: {
          "content-type": "application/json",
          "payment-response": claim.response.paymentResponse,
        },
      });
    }
    if (claim.kind === "new") await options.store.release(service.path, id);
    return undefined;
  }

  return {
    ...route,
    async handle(request) {
      // Past the day's cap no new call can be served, so no payment step starts (SCR-182 §4).
      if (capReached())
        return (
          (await storedReplay(request)) ??
          json(
            503,
            { error: "daily audit capacity reached" },
            { "retry-after": secondsToNextDay() },
          )
        );
      return route.handle(request);
    },
  };
}
