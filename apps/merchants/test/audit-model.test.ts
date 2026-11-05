// MR-07 / SCR-182 §4: the audit merchants' own Anthropic client. Every call goes through safeFetch with a
// fake transport, so nothing leaves the process; the key comes from a credential file read by path.
import { describe, expect, it } from "vitest";
import type { Transport } from "@czar/x402";
import {
  AUDIT_MODEL_MAX_REDIRECTS,
  auditApiKeyReader,
  createAnthropicAuditModel,
  createAuditModelFetch,
  type AuditModelRequest,
} from "../src/audit/index.ts";

const BASE_URL = "https://api.anthropic.test";
const KEY = "test-key-not-a-secret";

interface Seen {
  readonly hostname: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface Page {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
}

function fakeAnthropic(answer: (seen: Seen) => Page) {
  const seen: Seen[] = [];
  const transport: Transport = async (target) => {
    const request: Seen = {
      hostname: target.hostname,
      path: target.path,
      method: target.method,
      headers: target.headers,
      body: target.body === undefined ? "" : new TextDecoder().decode(target.body),
    };
    seen.push(request);
    const page = answer(request);
    return {
      status: page.status ?? 200,
      headers: { "content-type": "application/json", ...page.headers },
      body: (async function* () {
        yield new TextEncoder().encode(page.body);
      })(),
    };
  };
  const safeFetch = createAuditModelFetch({
    maxBytes: 1_048_576,
    timeoutMs: 5_000,
    version: "0.0.0-test",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    interfaceAddresses: () => [],
    transport,
  });
  return { safeFetch, seen };
}

const message = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: '{"summary":"ok","findings":[]}' }],
    stop_reason: "end_turn",
    usage: { input_tokens: 321, output_tokens: 45 },
    ...overrides,
  });

const REQUEST: AuditModelRequest = {
  model: "claude-haiku-5-5",
  system: "fixed system instruction",
  user: "labelled data block",
  outputSchema: { type: "object", additionalProperties: false, properties: {} },
  maxOutputTokens: 2000,
  timeoutMs: 45_000,
};

function client(answer: (seen: Seen) => Page, readApiKey = async () => KEY) {
  const fake = fakeAnthropic(answer);
  const model = createAnthropicAuditModel({
    safeFetch: fake.safeFetch,
    baseUrl: BASE_URL,
    readApiKey,
  });
  return { model, seen: fake.seen };
}

/** The error a promise rejects with; a promise that resolves fails the test. */
async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("rejected with something other than an Error", { cause: error });
  }
  throw new Error("expected a failure, but the call succeeded");
}

describe("audit model client", () => {
  it("sends one Messages API request with the key, the version, the prompt, the token cap and the JSON shape", async () => {
    const { model, seen } = client(() => ({ body: message() }));
    const reply = await model.complete(REQUEST);
    expect(reply).toEqual({
      text: '{"summary":"ok","findings":[]}',
      usage: { inputTokens: 321, outputTokens: 45 },
    });
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request).toMatchObject({
      hostname: "api.anthropic.test",
      path: "/v1/messages",
      method: "POST",
    });
    expect(request?.headers).toMatchObject({
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
    expect(JSON.parse(request?.body ?? "")).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 2000,
      system: "fixed system instruction",
      messages: [{ role: "user", content: "labelled data block" }],
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: REQUEST.outputSchema },
      },
    });
  });

  it("follows no redirect, so the key never reaches another host", async () => {
    expect(AUDIT_MODEL_MAX_REDIRECTS).toBe(0);
    const { model, seen } = client(() => ({
      status: 307,
      headers: { location: "https://collector.example.test/v1/messages" },
      body: "",
    }));
    await expect(model.complete(REQUEST)).rejects.toThrow();
    expect(seen.map((request) => request.hostname)).toEqual(["api.anthropic.test"]);
  });

  it("reports an error status without the provider's body", async () => {
    const { model } = client(() => ({ status: 529, body: "overloaded: labelled data block" }));
    const error = await failureOf(model.complete(REQUEST));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("529");
    expect(error.message).not.toContain("labelled data block");
  });

  it.each(["max_tokens", "refusal"])("treats stop_reason %s as a failed call", async (stop) => {
    const { model } = client(() => ({ body: message({ stop_reason: stop }) }));
    await expect(model.complete(REQUEST)).rejects.toThrow(stop);
  });

  it.each([
    ["no text block", { content: [] }],
    ["no usage counts", { usage: undefined }],
    ["negative usage counts", { usage: { input_tokens: -1, output_tokens: 2 } }],
  ])("treats a reply with %s as a failed call", async (_name, overrides) => {
    const { model } = client(() => ({ body: message(overrides) }));
    await expect(model.complete(REQUEST)).rejects.toThrow();
  });

  it("reads the key once, then reuses it", async () => {
    let reads = 0;
    const { model } = client(
      () => ({ body: message() }),
      async () => {
        reads += 1;
        return KEY;
      },
    );
    await model.complete(REQUEST);
    await model.complete(REQUEST);
    expect(reads).toBe(1);
  });
});

describe("audit API key file", () => {
  it("reads the named file in the merchants' credential folder and trims it", async () => {
    const paths: string[] = [];
    const read = auditApiKeyReader({
      folder: "/run/czar/credentials/merchants",
      fileName: "anthropic-api-key",
      readFile: async (path) => {
        paths.push(path);
        return `${KEY}\n`;
      },
    });
    expect(await read()).toBe(KEY);
    expect(paths).toEqual(["/run/czar/credentials/merchants/anthropic-api-key"]);
  });

  it.each(["", "../server/anthropic-api-key", "nested/anthropic-api-key", "a\\b"])(
    "refuses a file name that is not a plain name: %j",
    async (fileName) => {
      const read = auditApiKeyReader({
        folder: "/run/czar/credentials/merchants",
        fileName,
        readFile: async () => KEY,
      });
      await expect(read()).rejects.toThrow("plain file name");
    },
  );

  it("refuses an empty key file and never puts the key in an error", async () => {
    const empty = auditApiKeyReader({
      folder: "/f",
      fileName: "anthropic-api-key",
      readFile: async () => "  \n",
    });
    await expect(empty()).rejects.toThrow("empty");
    const missing = auditApiKeyReader({
      folder: "/f",
      fileName: "anthropic-api-key",
      readFile: async () => {
        throw new Error(`ENOENT ${KEY}`);
      },
    });
    const error = await failureOf(missing());
    expect(error.message).toContain("could not be read");
    expect(error.message).not.toContain(KEY);
  });
});
