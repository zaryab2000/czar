// Layer-2 client (CZ-26 §4): talks to the `czar-redact` sidecar over its Unix socket with JSON-RPC 2.0.
// When the sidecar is down, times out or rejects the language, the Node regex fallback runs and the
// result is marked for forced review (D45, `redaction.layer2Fallback` = regex, CZ-26 §10).
import { connect } from "node:net";
import { formatMarker } from "./markers.ts";
import {
  LAYER2_METHOD,
  type AnalyzeAnonymizeResult,
  type EntityCount,
  type Layer2Client,
  type Layer2Options,
  type Layer2Result,
} from "./layer2.ts";

/** Regex-only PII patterns for the fallback (CZ-26 §3: emails, phones, IBANs; card numbers). Best effort. */
const FALLBACK_PATTERNS: readonly { readonly entity: string; readonly pattern: RegExp }[] = [
  { entity: "EMAIL_ADDRESS", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    entity: "IBAN_CODE",
    pattern: /\b[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
  },
  { entity: "CREDIT_CARD", pattern: /\b(?:[0-9][ -]?){12,18}[0-9]\b/g },
  {
    entity: "PHONE_NUMBER",
    pattern:
      /(?:\+?[0-9]{1,3}[ .-]?)?(?:\([0-9]{2,4}\)|[0-9]{2,4})[ .-]?[0-9]{3,4}[ .-]?[0-9]{3,4}\b/g,
  },
];

const MARKER_SPAN = /\[\[R:[SP]:[A-Za-z0-9_-]+(?:#[0-9]+)?\]\]/g;

/** Replaces fallback PII matches with `[[R:P:<ENTITY>#n]]`; existing markers are left alone. */
export function regexFallback(text: string): Layer2Result {
  const protectedSpans = [...text.matchAll(MARKER_SPAN)].map(
    (m) => [m.index, m.index + m[0].length] as const,
  );
  const spans: { start: number; end: number; entity: string; value: string }[] = [];
  for (const { entity, pattern } of FALLBACK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      const overlaps = (a: number, b: number) => start < b && end > a;
      if (protectedSpans.some(([a, b]) => overlaps(a, b))) continue;
      if (spans.some((span) => overlaps(span.start, span.end))) continue;
      spans.push({ start, end, entity, value: match[0] });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const counters = new Map<string, Map<string, number>>();
  const counts = new Map<string, number>();
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    const values = counters.get(span.entity) ?? new Map<string, number>();
    counters.set(span.entity, values);
    if (!values.has(span.value)) values.set(span.value, values.size + 1);
    out += text.slice(cursor, span.start) + formatMarker("P", span.entity, values.get(span.value));
    cursor = span.end;
    counts.set(span.entity, (counts.get(span.entity) ?? 0) + 1);
  }
  out += text.slice(cursor);
  const entities: EntityCount[] = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .toSorted((a, b) => (a.type < b.type ? -1 : 1));
  return { text: out, entities, forcedReview: true };
}

export interface SidecarClientOptions {
  readonly socketPath: string;
  /** `redaction.layer2TimeoutMs` (5,000). */
  readonly timeoutMs: number;
  /** Called before each request so the daemon can start the sidecar lazily. */
  readonly ensureRunning?: () => Promise<void>;
}

function rpc(
  socketPath: string,
  timeoutMs: number,
  params: unknown,
): Promise<AnalyzeAnonymizeResult> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("layer-2 timeout"));
    }, timeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: LAYER2_METHOD, params })}\n`),
    );
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as {
          result?: AnalyzeAnonymizeResult;
          error?: unknown;
        };
        if (reply.result === undefined) reject(new Error("layer-2 error"));
        else resolve(reply.result);
      } catch {
        reject(new Error("layer-2 bad reply"));
      }
    });
    socket.on("error", fail);
  });
}

/** `layer2.redact(text, {language})` with the forced-review regex fallback. */
export function sidecarLayer2Client(options: SidecarClientOptions): Layer2Client {
  return {
    async redact(text: string, redactOptions: Layer2Options): Promise<Layer2Result> {
      try {
        await options.ensureRunning?.();
        const result = await rpc(options.socketPath, options.timeoutMs, {
          text,
          language: redactOptions.language,
          ...(redactOptions.entities === undefined ? {} : { entities: redactOptions.entities }),
        });
        return { text: result.text, entities: result.entities, forcedReview: false };
      } catch {
        return regexFallback(text);
      }
    },
  };
}
