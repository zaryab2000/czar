import type { Config } from "@czar/config";
import { Ajv2020 } from "ajv/dist/2020.js";
import { randomUUID } from "node:crypto";
import type { StepResult } from "@czar/schemas";
import { validateSchema } from "@czar/schemas";
import type { AcceptanceCheckInput, AcceptanceResult } from "#src/acceptance/types";
import { completeBoundaryModelCall, type ModelClient } from "#src/models/proxy";
import type { Logger } from "@czar/logging";
import type { Pool } from "pg";

export type BoundaryFlag = "injection-suspect" | "pii-suspect";
export type ScreenLabel = "none" | BoundaryFlag;

export interface BoundaryInput {
  readonly body: string;
  readonly statusCode: number;
  readonly mimeType: string;
  readonly stepIndex: number;
  readonly source: StepResult["source"];
  readonly bodyRef?: string;
  readonly bodyCommit: string;
  readonly expectedKeys: readonly string[];
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly elapsedMs: number;
  readonly origin: string;
  readonly payTo: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly idempotencyKey: string;
  readonly now: Date;
  readonly expectsPersonalData?: boolean;
  readonly acceptance: Omit<
    AcceptanceCheckInput,
    | "bodyText"
    | "statusCode"
    | "responseArrived"
    | "elapsedMs"
    | "mimeType"
    | "paid"
    | "screen"
    | "bodyRef"
  >;
}

export interface BoundaryDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly logger: Logger;
  readonly modelClient?: ModelClient;
  readonly promptHashes: Readonly<Record<"P-01" | "P-02", string>>;
  readonly objectStore: { put(bytes: Uint8Array): Promise<string> };
  readonly acceptance: { check(input: AcceptanceCheckInput): Promise<AcceptanceResult> };
}

export interface ScreenResult {
  readonly available: boolean;
  readonly flags: readonly ScreenLabel[];
  readonly spans: readonly {
    readonly start: number;
    readonly end: number;
    readonly flag: BoundaryFlag;
  }[];
  readonly chunks: readonly string[];
}

const SCREEN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["flags", "reasons", "spans"],
  properties: {
    flags: {
      type: "array",
      minItems: 1,
      items: { enum: ["none", "injection-suspect", "pii-suspect"] },
    },
    reasons: {
      type: "array",
      items: {
        enum: [
          "ai-directed-instruction",
          "payment-request",
          "protocol-imitation",
          "encoded-content",
          "contact-details",
          "identifier",
          "health-or-financial",
        ],
      },
    },
    spans: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        required: ["start", "end", "flag"],
        properties: {
          start: { type: "integer" },
          end: { type: "integer" },
          flag: { enum: ["injection-suspect", "pii-suspect"] },
        },
      },
    },
  },
} as const;

const READER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "fields", "flags", "missing"],
  properties: {
    status: { enum: ["delivered", "unknown"] },
    fields: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        required: ["name", "value", "confidence"],
        additionalProperties: false,
        properties: {
          name: { type: "string", maxLength: 64 },
          value: { type: "string", maxLength: 2000 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    flags: {
      type: "array",
      items: { enum: ["injection-suspect", "schema-mismatch", "truncated", "pii-suspect"] },
    },
    missing: { type: "array", items: { type: "string", maxLength: 64 } },
  },
} as const;

const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|your)\s+instructions/i,
  /\b(?:you are now|as an ai|system:|developer:|tool call|call the function|run this command|install\b)\b/i,
  /\b(?:send|pay|transfer|approve|raise (?:the )?limit|add a payee|change (?:the )?plan|reveal (?:keys|secrets))\b/i,
  /\b(?:payment-required|stepresult|approve envelope)\b/i,
  /<!--|[\u200B-\u200D\uFEFF]|\[[^\]]+\]\(https?:\/\/[^)]+\)/i,
];
const PII_PATTERN = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\+?\d[\d ()-]{7,}\d/;

export async function runBoundary(
  input: BoundaryInput,
  dependencies: BoundaryDependencies,
): Promise<{
  readonly quarantined: boolean;
  readonly screen: ScreenResult;
  readonly acceptance: AcceptanceResult;
  readonly result?: StepResult;
}> {
  const screen = await screenBody(input, dependencies);
  const quarantined = !screen.available || screen.flags.includes("injection-suspect");
  if (!screen.available)
    dependencies.logger.warn("boundary_screen_unavailable", { rule: "screen-unavailable" });
  else if (quarantined)
    dependencies.logger.info("boundary_quarantined", { state: "injection-suspect" });
  const bodyBytes = new TextEncoder().encode(input.body);
  const bodyRef = input.bodyRef ?? (await dependencies.objectStore.put(bodyBytes));
  const acceptance = await dependencies.acceptance.check({
    ...input.acceptance,
    bodyRef,
    bodyText: input.body,
    statusCode: input.statusCode,
    responseArrived: true,
    elapsedMs: input.elapsedMs,
    mimeType: input.mimeType,
    paid: true,
    screen: screen.available
      ? { available: true, label: labelFor(screen.flags) }
      : { available: false },
  });
  if (quarantined) return { quarantined: true, screen, acceptance };
  const deliveryResult = acceptance.report.checks.find(
    (check) => check.name === "delivery",
  )?.result;
  if (deliveryResult !== "pass") {
    const status =
      input.elapsedMs > input.acceptance.maxTimeoutSeconds * 1000 ? "timeout" : "http-error";
    const result = makeFailureStepResult(
      input,
      bodyRef,
      screen,
      acceptance.stepResultFlags,
      status,
    );
    if (!validateSchema("step-result", result))
      throw new Error("Boundary StepResult failed schema validation.");
    return { quarantined: false, screen, acceptance, result };
  }

  const limit = Number(dependencies.config.get("reader.maxChars"));
  const truncated = input.body.slice(0, limit);
  const fields = buildExpectedFields(input.expectedKeys, input.outputSchema);
  const request = {
    prompt: "P-02" as const,
    promptHash: dependencies.promptHashes["P-02"],
    input: {
      expectedFields: fields,
      structuralResult:
        acceptance.report.checks.find((check) => check.name === "structural")?.result ??
        "inconclusive",
      source: input.source,
      body: truncated,
    },
    schema: READER_SCHEMA,
  };
  const reply = dependencies.modelClient
    ? await completeBoundaryModelCall(
        dependencies.pool,
        dependencies.config,
        dependencies.logger,
        dependencies.modelClient,
        {
          body: request,
          rawBody: Buffer.from(JSON.stringify(request)),
          key: input.idempotencyKey,
          deviceId: input.deviceId,
          userId: input.userId,
          now: input.now,
        },
      )
    : undefined;
  const extracted = reply?.status === 200 ? reply.body["output"] : codeExtract(truncated, fields);
  const result = makeStepResult(
    input,
    bodyRef,
    extracted,
    screen,
    acceptance.stepResultFlags,
    truncated,
    reply?.status !== 200,
    truncated.length !== input.body.length,
    !input.expectsPersonalData,
  );
  if (!validateSchema("step-result", result))
    throw new Error("Boundary StepResult failed schema validation.");
  return { quarantined: false, screen, acceptance, result };
}

export async function screenBody(
  input: Pick<
    BoundaryInput,
    "body" | "origin" | "payTo" | "userId" | "deviceId" | "idempotencyKey" | "now"
  >,
  dependencies: Pick<
    BoundaryDependencies,
    "pool" | "config" | "logger" | "modelClient" | "promptHashes"
  >,
): Promise<ScreenResult> {
  const bodyLimit = Number(dependencies.config.get("reader.maxChars"));
  const screenLimit = Number(dependencies.config.get("screen.maxChars"));
  const overlap = Number(dependencies.config.get("screen.chunkOverlapChars"));
  const readable = input.body.slice(0, bodyLimit);
  const chunks = chunkText(readable, screenLimit, overlap);
  const regexFlags = regexScreen(input.body);
  const flags = new Set<ScreenLabel>(regexFlags);
  const spans: ScreenResult["spans"][number][] = findPiiSpans(input.body);
  if (!dependencies.modelClient)
    return { available: false, flags: normalizeFlags(flags), spans: [], chunks };
  try {
    for (const [index, chunk] of chunks.entries()) {
      const request = {
        prompt: "P-01" as const,
        promptHash: dependencies.promptHashes["P-01"],
        input: {
          sourceLabel: {
            kind: "merchant-body",
            origin: originHost(input.origin),
            payTo: input.payTo,
          },
          text: chunk,
        },
        schema: SCREEN_SCHEMA,
      };
      const reply = await completeBoundaryModelCall(
        dependencies.pool,
        dependencies.config,
        dependencies.logger,
        dependencies.modelClient,
        {
          body: request,
          rawBody: Buffer.from(JSON.stringify(request)),
          key: randomUUID(),
          deviceId: input.deviceId,
          userId: input.userId,
          now: input.now,
        },
      );
      if (reply.status !== 200 || !validScreenOutput(reply.body["output"], chunk.length))
        return { available: false, flags: normalizeFlags(flags), spans: [], chunks };
      const output = reply.body["output"];
      for (const flag of output["flags"] as ScreenLabel[]) flags.add(flag);
      for (const span of output["spans"] as ScreenResult["spans"]) {
        flags.add(span.flag);
        spans.push({ ...span, start: span.start + chunkOffset(index, screenLimit, overlap) });
      }
    }
  } catch {
    return { available: false, flags: normalizeFlags(flags), spans: [], chunks };
  }
  return { available: true, flags: normalizeFlags(flags), spans, chunks };
}

function normalizeFlags(flags: ReadonlySet<ScreenLabel>): ScreenLabel[] {
  const output = new Set(flags);
  if (output.size > 1) output.delete("none");
  if (!output.size) output.add("none");
  return [...output];
}

function makeFailureStepResult(
  input: BoundaryInput,
  bodyRef: string,
  screen: ScreenResult,
  acceptanceFlags: readonly string[],
  status: "http-error" | "timeout",
): StepResult {
  return {
    schemaVersion: "1.0",
    stepIndex: input.stepIndex,
    status,
    source: input.source,
    fields: [],
    flags: [
      ...new Set([...acceptanceFlags, ...screen.flags.filter((flag) => flag !== "none")]),
    ] as StepResult["flags"],
    bodyRef,
    bodyCommit: input.bodyCommit,
  };
}

export function regexScreen(text: string): readonly ScreenLabel[] {
  const flags: ScreenLabel[] = [];
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(text)) || hasEncodedInstruction(text))
    flags.push("injection-suspect");
  if (PII_PATTERN.test(text)) flags.push("pii-suspect");
  if (!flags.length) flags.push("none");
  return flags;
}

function hasEncodedInstruction(text: string): boolean {
  const blocks = text.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? [];
  return blocks.some((block) => {
    const decoded = Buffer.from(block, "base64").toString("utf8");
    return INJECTION_PATTERNS.some((pattern) => pattern.test(decoded));
  });
}

export function buildExpectedFields(
  expectedKeys: readonly string[],
  schema?: Readonly<Record<string, unknown>>,
): readonly {
  readonly name: string;
  readonly type: "string" | "number" | "date" | "url" | "list";
  readonly required: true;
}[] {
  const properties = schema?.["properties"] as Record<string, Record<string, unknown>> | undefined;
  return expectedKeys.map((name) => ({
    name,
    type: fieldType(properties?.[name]),
    required: true,
  }));
}

function fieldType(
  property?: Record<string, unknown>,
): "string" | "number" | "date" | "url" | "list" {
  if (property?.["type"] === "integer" || property?.["type"] === "number") return "number";
  if (property?.["type"] === "array") return "list";
  if (property?.["format"] === "date" || property?.["format"] === "date-time") return "date";
  if (property?.["format"] === "uri" || property?.["format"] === "url") return "url";
  return "string";
}

function chunkText(text: string, maxChars: number, overlap: number): string[] {
  if (overlap >= maxChars)
    throw new RangeError("Screen overlap must be smaller than screen chunk size.");
  const chunks: string[] = [];
  const stride = maxChars - overlap;
  for (let start = 0; start < text.length; start += stride)
    chunks.push(text.slice(start, start + maxChars));
  return chunks.length ? chunks : [""];
}

function chunkOffset(index: number, maxChars: number, overlap: number): number {
  return index * (maxChars - overlap);
}

function validScreenOutput(value: unknown, chunkLength: number): value is Record<string, unknown> {
  try {
    const valid = new Ajv2020({ allErrors: true, strict: false }).compile(SCREEN_SCHEMA)(value);
    if (
      !valid ||
      typeof value !== "object" ||
      value === null ||
      !("spans" in value) ||
      !Array.isArray(value.spans)
    )
      return false;
    return value.spans.every(
      (span) =>
        typeof span === "object" &&
        span !== null &&
        "start" in span &&
        "end" in span &&
        Number.isSafeInteger(span.start) &&
        Number.isSafeInteger(span.end) &&
        span.start >= 0 &&
        span.end > span.start &&
        span.end <= chunkLength,
    );
  } catch {
    return false;
  }
}

function labelFor(flags: readonly ScreenLabel[]): ScreenLabel {
  return flags.includes("injection-suspect")
    ? "injection-suspect"
    : flags.includes("pii-suspect")
      ? "pii-suspect"
      : "none";
}

function codeExtract(
  body: string,
  expectedFields: readonly { readonly name: string; readonly type: string }[],
) {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return {
      status: "unknown",
      fields: [],
      flags: [],
      missing: expectedFields.map((field) => field.name),
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {
      status: "unknown",
      fields: [],
      flags: [],
      missing: expectedFields.map((field) => field.name),
    };
  const fields: { name: string; value: string; confidence: number }[] = [];
  const missing: string[] = [];
  const flags: string[] = [];
  for (const field of expectedFields) {
    const item = (value as Record<string, unknown>)[field.name];
    if (item === undefined) {
      missing.push(field.name);
      continue;
    }
    const text = typeof item === "string" ? item : JSON.stringify(item);
    if (text.length > 2000) {
      flags.push("schema-mismatch");
      missing.push(field.name);
      continue;
    }
    fields.push({ name: field.name, value: text, confidence: 1 });
  }
  return { status: missing.length ? "unknown" : "delivered", fields, flags, missing };
}

function makeStepResult(
  input: BoundaryInput,
  bodyRef: string,
  extracted: unknown,
  screen: ScreenResult,
  acceptanceFlags: readonly string[],
  readableText: string,
  codeFallback: boolean,
  truncated: boolean,
  maskPii: boolean,
): StepResult {
  const output =
    typeof extracted === "object" && extracted !== null
      ? (extracted as Record<string, unknown>)
      : {};
  const allowed = new Map(
    input.expectedKeys.map((key) => [
      key,
      buildExpectedFields([key], input.outputSchema)[0]?.type ?? "string",
    ]),
  );
  const flags = new Set<string>(
    Array.isArray(output["flags"]) ? (output["flags"] as string[]) : [],
  );
  for (const flag of acceptanceFlags) flags.add(flag);
  for (const flag of screen.flags) if (flag !== "none") flags.add(flag);
  if (truncated) flags.add("truncated");
  const fields: StepResult["fields"] = [];
  if (Array.isArray(output["fields"])) {
    for (const item of output["fields"]) {
      const parsed = parseReaderField(item, {
        allowed,
        readableText,
        codeFallback,
        body: input.body,
        spans: screen.spans,
        maskPii,
      });
      for (const flag of parsed.flags) flags.add(flag);
      if (parsed.field) fields.push(parsed.field);
    }
  }
  const found = new Set(fields.map((field) => field.name));
  const missing = input.expectedKeys.filter((key) => !found.has(key));
  const result = {
    schemaVersion: "1.0" as const,
    stepIndex: input.stepIndex,
    status: missing.length ? ("unknown" as const) : ("delivered" as const),
    source: input.source,
    fields,
    flags: [...flags] as StepResult["flags"],
    bodyRef,
    bodyCommit: input.bodyCommit,
  };
  return result;
}

function parseReaderField(
  item: unknown,
  context: {
    readonly allowed: ReadonlyMap<string, string>;
    readonly readableText: string;
    readonly codeFallback: boolean;
    readonly body: string;
    readonly spans: ScreenResult["spans"];
    readonly maskPii: boolean;
  },
): { readonly field?: StepResult["fields"][number]; readonly flags: readonly string[] } {
  if (typeof item !== "object" || item === null) return { flags: ["schema-mismatch"] };
  const value = item as Record<string, unknown>;
  const name = value["name"];
  const text = value["value"];
  const confidence = value["confidence"];
  if (typeof name !== "string" || !context.allowed.has(name) || typeof text !== "string")
    return { flags: ["schema-mismatch"] };
  if (!context.codeFallback && !context.readableText.includes(text))
    return { flags: ["schema-mismatch"] };
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1)
    return { flags: ["schema-mismatch"] };
  if (!valueMatchesType(text, context.allowed.get(name)!)) return { flags: ["schema-mismatch"] };
  const flags = INJECTION_PATTERNS.some((pattern) => pattern.test(text))
    ? ["injection-suspect"]
    : [];
  const pii = PII_PATTERN.test(text) || overlapsPiiSpan(text, context.body, context.spans);
  return {
    field: {
      name,
      value: context.maskPii && pii ? "[[R:P:PII_SUSPECT]]" : text,
      confidence,
    },
    flags,
  };
}

function valueMatchesType(text: string, type: string): boolean {
  if (type === "number") return Number.isFinite(Number(text));
  if (type === "date") return !Number.isNaN(Date.parse(text));
  if (type !== "url") return true;
  try {
    return new URL(text).protocol === "https:";
  } catch {
    return false;
  }
}

function originHost(origin: string): string {
  return new URL(origin).host;
}

function findPiiSpans(text: string): ScreenResult["spans"][number][] {
  const pattern = new RegExp(PII_PATTERN.source, "g");
  const spans: ScreenResult["spans"][number][] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    spans.push({ start, end: start + match[0].length, flag: "pii-suspect" });
  }
  return spans;
}

function overlapsPiiSpan(fieldValue: string, body: string, spans: ScreenResult["spans"]): boolean {
  const sourceStart = body.indexOf(fieldValue);
  if (sourceStart < 0) return false;
  const sourceEnd = sourceStart + fieldValue.length;
  return spans.some(
    (span) => span.flag === "pii-suspect" && span.start < sourceEnd && span.end > sourceStart,
  );
}
