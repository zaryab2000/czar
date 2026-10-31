// safeFetch (cross-cutting §2.1, RV-022): the only way a Czar server process fetches a URL that came from
// outside Czar's own code. https:443 only; DNS resolved once and every answer checked; the connection goes
// to the checked address with the original host in SNI and Host; redirects re-checked; byte and time caps.
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { checkServerIdentity } from "node:tls";

export type SafeFetchRule =
  | "url"
  | "scheme"
  | "port"
  | "credentials"
  | "dns"
  | "blocked-address"
  | "max-redirects"
  | "max-bytes"
  | "timeout"
  | "transport";

/** Redacted transport outcomes used for paid-call attribution; never contains a host or error text. */
export type SafeFetchOutcome =
  | "connection-refused"
  | "connection-reset"
  | "connected-timeout"
  | "timeout-before-connect"
  | "dns-failure"
  | "network-unreachable"
  | "local-abort"
  | "unknown-transport";

/** `fetch-blocked` is not retryable; `upstream-unavailable` is (cross-cutting §5). */
export class SafeFetchError extends Error {
  readonly code: "fetch-blocked" | "upstream-unavailable";
  readonly rule: SafeFetchRule;
  readonly outcome: SafeFetchOutcome;

  constructor(code: SafeFetchError["code"], rule: SafeFetchRule, outcome?: SafeFetchOutcome) {
    super(`${code}: ${rule}`);
    this.name = "SafeFetchError";
    this.code = code;
    this.rule = rule;
    this.outcome = outcome ?? (rule === "dns" ? "dns-failure" : "unknown-transport");
  }
}

const blocked = (rule: SafeFetchRule) => new SafeFetchError("fetch-blocked", rule);

// ───────────── Address rules ─────────────

function parseIPv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n);
}

const toGroups = (s: string) => (s === "" || s === ":" ? [] : s.replace(/^:|:$/g, "").split(":"));

function parseIPv6(text: string): bigint | null {
  let input = text.replace(/^\[|\]$/g, "").toLowerCase();
  const zone = input.indexOf("%");
  if (zone >= 0) input = input.slice(0, zone);
  let tail: bigint[] = [];
  const lastColon = input.lastIndexOf(":");
  const maybeV4 = input.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (v4 === null) return null;
    tail = [v4 >> 16n, v4 & 0xffffn];
    input = `${input.slice(0, lastColon + 1)}`;
    if (input.endsWith("::")) input = input.slice(0, -1) + ":";
    else input = input.slice(0, -1);
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const head = toGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const total = head.length + rest.length + tail.length;
  if (halves.length === 1 ? total !== 8 : total > 7) return null;
  const groups = [
    ...head.map((g) => BigInt(`0x${g}`)),
    ...Array<bigint>(8 - total).fill(0n),
    ...rest.map((g) => BigInt(`0x${g}`)),
    ...tail,
  ];
  return groups.reduce((acc, g) => (acc << 16n) | g, 0n);
}

const V4_BLOCKS: readonly [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including 169.254.169.254 metadata
  ["172.16.0.0", 12], // RFC 1918
  ["192.168.0.0", 16], // RFC 1918
  ["224.0.0.0", 4], // multicast
  ["255.255.255.255", 32], // broadcast
];

const V6_BLOCKS: readonly [string, number][] = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fe80::", 10], // link-local
  ["fc00::", 7], // ULA
  ["ff00::", 8], // multicast
];

const inV4 = (value: bigint, [base, bits]: [string, number]) =>
  value >> BigInt(32 - bits) === (parseIPv4(base) as bigint) >> BigInt(32 - bits);
const inV6 = (value: bigint, [base, bits]: [string, number]) =>
  value >> BigInt(128 - bits) === (parseIPv6(base) as bigint) >> BigInt(128 - bits);

const MAPPED_PREFIX = 0xffffn << 32n;
const V4_SPACE = 1n << 32n;

/** True for every address cross-cutting §2.1 blocks, including IPv4-mapped and IPv4-compatible forms. */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4 !== null) return V4_BLOCKS.some((block) => inV4(v4, block));
  const v6 = parseIPv6(address);
  if (v6 === null) return true; // unparseable is never trusted
  if (V6_BLOCKS.some((block) => inV6(v6, block))) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms are judged as the IPv4 address.
  if (v6 >> 32n === MAPPED_PREFIX >> 32n || (v6 < V4_SPACE && v6 > 1n)) {
    const embedded = v6 & (V4_SPACE - 1n);
    return V4_BLOCKS.some((block) => inV4(embedded, block));
  }
  return false;
}

const sameAddress = (a: string, b: string) => {
  const pa = parseIPv4(a) ?? parseIPv6(a);
  const pb = parseIPv4(b) ?? parseIPv6(b);
  return pa !== null && pa === pb && (parseIPv4(a) === null) === (parseIPv4(b) === null);
};

// ───────────── Transport ─────────────

export interface TransportTarget {
  readonly protocol: "https:" | "http:";
  /** The checked address the connection goes to (no second lookup). */
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: number;
  /** The original host, sent in SNI and Host. */
  readonly hostname: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: Uint8Array;
  readonly signal: AbortSignal;
  readonly onConnected?: () => void;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: AsyncIterable<Uint8Array>;
}

export type Transport = (target: TransportTarget) => Promise<TransportResponse>;

export const nodeTransport: Transport = (target) =>
  new Promise((resolve, reject) => {
    const options = {
      host: target.address,
      family: target.family,
      port: target.port,
      path: target.path,
      method: target.method,
      headers: target.headers,
      signal: target.signal,
      agent: false as const,
    };
    const onResponse = (res: import("node:http").IncomingMessage) =>
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers as IncomingHttpHeaders,
        body: res,
      });
    const req =
      target.protocol === "https:"
        ? httpsRequest(
            {
              ...options,
              servername: isIP(target.hostname) === 0 ? target.hostname : undefined,
              checkServerIdentity: (_host: string, cert: import("node:tls").PeerCertificate) =>
                checkServerIdentity(target.hostname, cert),
            },
            onResponse,
          )
        : httpRequest(options, onResponse);
    req.on("error", reject);
    req.on("socket", (socket) => socket.once("connect", () => target.onConnected?.()));
    req.end(target.body === undefined ? undefined : Buffer.from(target.body));
  });

// ───────────── safeFetch ─────────────

export interface SafeFetchDeps {
  /** Exact `http://127.0.0.1:<port>` origins of Czar's own merchants (`fetch.localMerchantOrigins`). */
  readonly localMerchantOrigins: readonly string[];
  /** Exact local-only Circle stand-in origins (`fetch.localStandinOrigins`). */
  readonly localStandinOrigins?: readonly string[];
  /** `fetch.maxRedirects`, `fetch.maxBytes`, `fetch.timeoutMs`. */
  readonly maxRedirects: number;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  /** For `User-Agent: Czar/<version>`. */
  readonly version: string;
  readonly resolve?: (host: string) => Promise<readonly { address: string; family: number }[]>;
  readonly interfaceAddresses?: () => readonly string[];
  readonly transport?: Transport;
}

export interface SafeFetchOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  /** Sent only to this exact origin, never after a redirect to another origin. */
  readonly authorization?: { readonly origin: string; readonly value: string };
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface SafeFetchResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

const HTTPS_PORT = 443;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const STRIPPED_HEADERS = new Set([
  "cookie",
  "host",
  "user-agent",
  "authorization",
  "proxy-authorization",
  "content-length",
]);

const defaultResolve = async (host: string) => lookup(host, { all: true, verbatim: true });
const defaultInterfaces = () =>
  Object.values(networkInterfaces())
    .flat()
    .flatMap((entry) => (entry === undefined ? [] : [entry.address]));

function flattenHeaders(headers: TransportResponse["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined)
      out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

export function createSafeFetch(deps: SafeFetchDeps) {
  const resolve = deps.resolve ?? defaultResolve;
  const interfaces = deps.interfaceAddresses ?? defaultInterfaces;
  const transport = deps.transport ?? nodeTransport;
  const localOrigins = new Set([...deps.localMerchantOrigins, ...(deps.localStandinOrigins ?? [])]);

  async function target(
    url: URL,
  ): Promise<{ address: string; family: 4 | 6; port: number; local: boolean }> {
    if (url.username !== "" || url.password !== "") throw blocked("credentials");
    if (url.protocol === "http:" && localOrigins.has(url.origin)) {
      // Loopback HTTP is limited to configured local merchant and D92 stand-in origins.
      if (url.hostname !== "127.0.0.1" || url.port === "") throw blocked("scheme");
      return { address: url.hostname, family: 4, port: Number(url.port), local: true };
    }
    if (url.protocol !== "https:") throw blocked("scheme");
    if (url.port !== "" && Number(url.port) !== HTTPS_PORT) throw blocked("port");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let answers: readonly { address: string; family: number }[];
    if (isIP(host) !== 0) {
      answers = [{ address: host, family: isIP(host) }];
    } else {
      try {
        answers = await resolve(host);
      } catch {
        throw blocked("dns");
      }
      if (answers.length === 0) throw blocked("dns");
    }
    const own = interfaces();
    for (const { address } of answers) {
      if (isBlockedAddress(address) || own.some((mine) => sameAddress(mine, address)))
        throw blocked("blocked-address");
    }
    const first = answers[0] as { address: string; family: number };
    return {
      address: first.address,
      family: first.family === 6 ? 6 : 4,
      port: HTTPS_PORT,
      local: false,
    };
  }

  return async function safeFetch(
    input: string,
    options: SafeFetchOptions = {},
  ): Promise<SafeFetchResponse> {
    const maxBytes = Math.min(options.maxBytes ?? deps.maxBytes, Number.MAX_SAFE_INTEGER);
    const signal = AbortSignal.timeout(options.timeoutMs ?? deps.timeoutMs);
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw blocked("url");
    }
    let method = options.method ?? "GET";
    let body = options.body;

    for (let hop = 0; ; hop += 1) {
      const { address, family, port } = await target(url);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        if (!STRIPPED_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
      }
      headers["host"] = url.host;
      headers["user-agent"] = `Czar/${deps.version}`;
      if (options.authorization !== undefined && options.authorization.origin === url.origin) {
        headers["authorization"] = options.authorization.value;
      }
      if (body !== undefined) headers["content-length"] = String(body.length);

      let connected = false;
      const pending = transport({
        protocol: url.protocol as "https:" | "http:",
        address,
        family,
        port,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal,
        onConnected: () => {
          connected = true;
        },
      });
      const timeout = new Promise<never>((_, reject) =>
        signal.addEventListener(
          "abort",
          () =>
            reject(
              new SafeFetchError(
                "upstream-unavailable",
                "timeout",
                connected ? "connected-timeout" : "timeout-before-connect",
              ),
            ),
          { once: true },
        ),
      );
      let response: TransportResponse;
      try {
        response = await Promise.race([pending, timeout]);
      } catch (error) {
        if (error instanceof SafeFetchError) throw error;
        throw new SafeFetchError(
          "upstream-unavailable",
          signal.aborted ? "timeout" : "transport",
          signal.aborted
            ? connected
              ? "connected-timeout"
              : "timeout-before-connect"
            : classifyTransportError(error),
        );
      }

      const responseHeaders = flattenHeaders(response.headers);
      const location = responseHeaders["location"];
      if (REDIRECTS.has(response.status) && location !== undefined) {
        if (hop >= deps.maxRedirects) throw blocked("max-redirects");
        url = new URL(location, url);
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === "POST")
        ) {
          method = "GET";
          body = undefined;
        }
        continue;
      }

      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > maxBytes) throw blocked("max-bytes");
          chunks.push(chunk);
        }
      } catch (error) {
        if (error instanceof SafeFetchError) throw error;
        throw new SafeFetchError(
          "upstream-unavailable",
          signal.aborted ? "timeout" : "transport",
          signal.aborted ? "connected-timeout" : classifyTransportError(error),
        );
      }
      return {
        status: response.status,
        url: url.href,
        headers: responseHeaders,
        body: Buffer.concat(chunks),
      };
    }
  };
}

function classifyTransportError(error: unknown): SafeFetchOutcome {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ECONNREFUSED") return "connection-refused";
  if (code === "ECONNRESET") return "connection-reset";
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH") return "network-unreachable";
  if (code === "ABORT_ERR") return "local-abort";
  return "unknown-transport";
}

export type SafeFetch = ReturnType<typeof createSafeFetch>;

/** safeFetch with `fetch.*` from `@czar/config`. */
export function createSafeFetchFromConfig(
  config: import("@czar/config").Config,
  version: string,
): SafeFetch {
  return createSafeFetch({
    localMerchantOrigins: config.has("fetch.localMerchantOrigins")
      ? (config.get("fetch.localMerchantOrigins") as readonly string[])
      : [],
    localStandinOrigins: config.has("fetch.localStandinOrigins")
      ? (config.get("fetch.localStandinOrigins") as readonly string[])
      : [],
    maxRedirects: config.get("fetch.maxRedirects") as number,
    maxBytes: config.get("fetch.maxBytes") as number,
    timeoutMs: config.get("fetch.timeoutMs") as number,
    version,
  });
}
