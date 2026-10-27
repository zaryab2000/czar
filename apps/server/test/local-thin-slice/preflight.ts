import { isLoopbackHttpUrl, validateLocalOnlyConfig, type Config } from "@czar/config";

export interface T050aEndpointOptions {
  readonly config: Config;
  readonly overlayPath: string | URL;
  readonly rpcUrl: string;
  readonly serverUrl: string;
  readonly merchantUrl: string;
  readonly databaseUrl: string;
  readonly fetchFn?: typeof fetch;
}

export async function validateT050aEndpoints(options: T050aEndpointOptions): Promise<void> {
  assertLoopbackHttp("Arc RPC", options.rpcUrl);
  assertLoopbackHttp("server", options.serverUrl);
  assertLoopbackHttp("merchant", options.merchantUrl);
  if (!isLoopbackPostgresUrl(options.databaseUrl)) {
    throw new Error("T-050a requires a loopback Postgres endpoint");
  }

  await validateLocalOnlyConfig({
    config: options.config,
    overlayPath: options.overlayPath,
    arcRpcUrl: options.rpcUrl,
    requireAnvilNodeInfo: true,
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });
}

function assertLoopbackHttp(label: string, value: string): void {
  if (!isLoopbackHttpUrl(value)) {
    throw new Error(`T-050a requires a loopback HTTP ${label} endpoint`);
  }
}

function isLoopbackPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
