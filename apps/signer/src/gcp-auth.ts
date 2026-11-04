// Access tokens for Google APIs from the VM metadata server (SCR-170 §4): there are no service-account
// key files anywhere, and the token is never logged, never passed on a command line and never put in an
// environment variable (D70, D78). Only the signer's UID may reach the metadata server
// (`czar-metadata-guard.service`), so a compromised container cannot call `asymmetricSign` itself.
import type { Logger } from "@czar/logging";

/**
 * A token is used until this long before its expiry, so a request never travels with a token that
 * expires in flight. SCR-170 §4 names no parameter for it and PM-061 added no key, so it is a named
 * constant here rather than a magic number.
 */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** The header the metadata server requires; without it the request is refused. */
export const METADATA_FLAVOR_HEADER = "Metadata-Flavor";

export interface AccessTokenSource {
  /** A valid bearer token, from the cache when one is still good. */
  token(): Promise<string>;
}

export interface MetadataTokenOptions {
  /** `deploy.metadataTokenUrl`. */
  readonly metadataTokenUrl: string;
  /** Per-request bound, `kms.signTimeoutMs`. */
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
  /** Milliseconds. */
  readonly nowMs?: () => number;
  readonly logger?: Pick<Logger, "error">;
}

interface CachedToken {
  readonly value: string;
  readonly refreshAtMs: number;
}

/** Shape of the metadata server's token response; anything else is refused. */
function parseTokenResponse(body: unknown): { value: string; expiresInSeconds: number } {
  if (typeof body !== "object" || body === null) throw metadataError("malformed token response");
  const record = body as Record<string, unknown>;
  const value = record["access_token"];
  const expires = record["expires_in"];
  if (typeof value !== "string" || value.length === 0)
    throw metadataError("token response has no access_token");
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0)
    throw metadataError("token response has no usable expires_in");
  return { value, expiresInSeconds: expires };
}

function metadataError(reason: string): Error {
  return new Error(`metadata server: ${reason}`);
}

/**
 * Fetches an access token from `deploy.metadataTokenUrl` and keeps it until
 * `TOKEN_REFRESH_MARGIN_MS` before expiry. One fetch is in flight at a time, so a burst of signing
 * requests shares a single refresh.
 */
export function metadataAccessToken(options: MetadataTokenOptions): AccessTokenSource {
  const doFetch = options.fetch ?? fetch;
  const nowMs = options.nowMs ?? Date.now;
  let cached: CachedToken | undefined;
  let inFlight: Promise<CachedToken> | undefined;

  const refresh = async (): Promise<CachedToken> => {
    let response: Response;
    try {
      response = await doFetch(options.metadataTokenUrl, {
        method: "GET",
        headers: { [METADATA_FLAVOR_HEADER]: "Google" },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      // The URL may carry a path; neither it nor the cause is logged or re-thrown (cross-cutting §4).
      throw metadataError("token request failed");
    }
    if (!response.ok) {
      options.logger?.error("signer_kms_token_error", { httpStatus: response.status });
      throw metadataError(`token request returned ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw metadataError("token response was not JSON");
    }
    const parsed = parseTokenResponse(body);
    const refreshAtMs = nowMs() + parsed.expiresInSeconds * 1000 - TOKEN_REFRESH_MARGIN_MS;
    return { value: parsed.value, refreshAtMs };
  };

  return {
    async token() {
      const current = cached;
      if (current !== undefined && nowMs() < current.refreshAtMs) return current.value;
      inFlight ??= refresh().finally(() => {
        inFlight = undefined;
      });
      const fresh = await inFlight;
      cached = fresh;
      return fresh.value;
    },
  };
}
