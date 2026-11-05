// The provider side of 02 §9.2 `getJobBrief` and `uploadJobDeliverable`, over HTTP.
import type { Hash32 } from "@czar/hashing";
import { JobServerError, type JobServer, type ProviderAuth } from "#src/provider/ports";

const HASH32 = /^0x[0-9a-fA-F]{64}$/;

export interface HttpJobServerOptions {
  /** Czar's server origin (Phase 1: the local server on the same machine, N3). */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

export function createHttpJobServer(options: HttpJobServerOptions): JobServer {
  const send = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  return {
    async brief(auth: ProviderAuth) {
      const response = await send(`${base}/v1/jobs/${auth.jobKey}/brief`, {
        method: "GET",
        headers: {
          "X-Czar-Provider-Address": auth.providerAddress,
          "X-Czar-Brief-Issued-At": auth.issuedAt.toString(),
          "X-Czar-Brief-Signature": auth.signature,
        },
      });
      if (response.status !== 200) throw new JobServerError("getJobBrief", response.status);
      return (await response.json()) as unknown;
    },
    async upload(auth: ProviderAuth, body: Uint8Array) {
      const response = await send(`${base}/v1/jobs/${auth.jobKey}/deliverable`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Czar-Provider-Address": auth.providerAddress,
          "X-Czar-Upload-Issued-At": auth.issuedAt.toString(),
          "X-Czar-Upload-Signature": auth.signature,
        },
        body,
      });
      if (response.status !== 201)
        throw new JobServerError("uploadJobDeliverable", response.status);
      const result = (await response.json()) as { contentHash?: unknown };
      if (typeof result.contentHash !== "string" || !HASH32.test(result.contentHash))
        throw new JobServerError("uploadJobDeliverable", response.status);
      return result.contentHash.toLowerCase() as Hash32;
    },
  };
}
