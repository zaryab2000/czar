// The audit merchants' own Anthropic Messages API client (SCR-182 §4). Merchants never import from
// `apps/server`, so this mirrors the server's client (`apps/server/src/models/anthropic.ts`) for one call
// shape: a fixed system instruction, one user message, a JSON answer in a given shape.
//
// Rules this file keeps:
// - every request goes through safeFetch (https only, no private ranges, byte and time caps), built with
//   no redirects at all: safeFetch re-sends custom headers on each hop and the key travels in `x-api-key`,
//   so a redirect could carry it to another host;
// - the key is read from a credential file by path, never from an environment variable or a command line;
// - nothing is logged here, and no error carries the key, the prompt or the provider's reply body.
import { createSafeFetch, type SafeFetch, type SafeFetchDeps } from "@czar/x402";

/** The Messages API version header, as the server sends it. A vendor protocol constant, not a Czar parameter. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** The model call follows no redirect (see the file header). */
export const AUDIT_MODEL_MAX_REDIRECTS = 0;

/**
 * Low effort keeps the model's thinking from using up `merchants.audit.maxOutputTokens`, which bounds the
 * whole reply including the JSON answer. A vendor request value, not a tunable.
 */
const EFFORT = "low";

export interface AuditModelRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  /** The structured-output schema the answer must follow. */
  readonly outputSchema: Record<string, unknown>;
  /** `merchants.audit.maxOutputTokens`. */
  readonly maxOutputTokens: number;
  /** `merchants.audit.handlerTimeoutMs`. */
  readonly timeoutMs: number;
}

export interface AuditModelReply {
  readonly text: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/** The port the audit route calls; tests use a stub. */
export interface AuditModel {
  complete(request: AuditModelRequest): Promise<AuditModelReply>;
}

/** The safeFetch for model calls: no loopback origins and no redirects. */
export function createAuditModelFetch(
  deps: Omit<SafeFetchDeps, "localMerchantOrigins" | "localStandinOrigins" | "maxRedirects">,
): SafeFetch {
  return createSafeFetch({
    ...deps,
    localMerchantOrigins: [],
    maxRedirects: AUDIT_MODEL_MAX_REDIRECTS,
  });
}

/**
 * Reads the API key from `<folder>/<fileName>`, where `folder` is the merchants' own folder in
 * `deploy.credentialFilesDir` (SCR-170 §4) and `fileName` is `merchants.audit.anthropicApiKeyFile`.
 */
export function auditApiKeyReader(options: {
  readonly folder: string;
  readonly fileName: string;
  readonly readFile: (path: string) => Promise<string>;
}): () => Promise<string> {
  return async () => {
    const { fileName } = options;
    if (fileName === "" || fileName === "." || fileName === ".." || /[/\\]/.test(fileName))
      throw new Error("audit api key file is not a plain file name");
    let contents: string;
    try {
      contents = await options.readFile(`${options.folder}/${fileName}`);
    } catch {
      throw new Error("audit api key file could not be read");
    }
    const key = contents.trim();
    if (key === "") throw new Error("audit api key file is empty");
    return key;
  };
}

export function createAnthropicAuditModel(options: {
  readonly safeFetch: SafeFetch;
  /** `models.anthropic.baseUrl`. */
  readonly baseUrl: string;
  readonly readApiKey: () => Promise<string>;
}): AuditModel {
  let key: Promise<string> | undefined;
  const apiKey = () =>
    (key ??= options.readApiKey().catch((error: unknown) => {
      key = undefined;
      throw error;
    }));
  const url = `${options.baseUrl.replace(/\/+$/, "")}/v1/messages`;

  return {
    async complete(request) {
      const secret = await apiKey();
      const body = new TextEncoder().encode(
        JSON.stringify({
          model: request.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
          output_config: {
            effort: EFFORT,
            format: { type: "json_schema", schema: request.outputSchema },
          },
        }),
      );
      let response;
      try {
        response = await options.safeFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": secret,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body,
          timeoutMs: request.timeoutMs,
        });
      } catch (error) {
        throw new Error("audit model request did not complete", { cause: error });
      }
      // The body may quote the prompt, so only the status travels.
      if (response.status < 200 || response.status >= 300)
        throw new Error(`audit model request failed with status ${response.status}`);
      return readReply(response.body);
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function readReply(bytes: Uint8Array): AuditModelReply {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("audit model reply was not JSON");
  }
  if (!isRecord(payload)) throw new Error("audit model reply was not an object");
  // A cut-off (max_tokens) or declined (refusal) answer is never a report.
  const stop = payload["stop_reason"];
  if (stop !== "end_turn")
    throw new Error(`audit model stopped with ${typeof stop === "string" ? stop : "no reason"}`);
  const usage = payload["usage"];
  if (!isRecord(usage) || !isCount(usage["input_tokens"]) || !isCount(usage["output_tokens"]))
    throw new Error("audit model reply carried no usage counts");
  const content = payload["content"];
  const text = (Array.isArray(content) ? content : [])
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) && block["type"] === "text" && typeof block["text"] === "string",
    )
    .map((block) => block.text)
    .join("");
  if (text.trim() === "") throw new Error("audit model reply carried no text");
  return {
    text,
    usage: { inputTokens: usage["input_tokens"], outputTokens: usage["output_tokens"] },
  };
}
