import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "./errors.ts";
import type { Config } from "./loader.ts";

const LOCAL_OVERLAY = fileURLToPath(new URL("../../../env/local.toml", import.meta.url));
const LOCAL_ONLY_KEYS = [
  "fetch.localStandinOrigins",
  "merchants.facilitatorBaseUrl",
  "chain.gatewayApiBaseUrl",
  "merchants.publicOrigin",
  "app.circleClientUrl",
  "app.arcRpcUrl",
] as const;

export type LocalOnlyGuardOptions = {
  readonly config: Config;
  readonly overlayPath: string | URL;
  readonly arcRpcUrl: string;
  readonly fetchFn?: typeof fetch;
};

/** Validates configured HTTP endpoints and proves local RPC is Arc Anvil before use. */
export async function validateLocalOnlyConfig(options: LocalOnlyGuardOptions): Promise<void> {
  const configuredValues = LOCAL_ONLY_KEYS.flatMap((key) => {
    if (!options.config.has(key)) return [];
    const value = options.config.get(key);
    return Array.isArray(value) ? [...value] : [value];
  });
  const hasLoopback = configuredValues.some(
    (value) => typeof value === "string" && isHttpUrl(value),
  );

  for (const key of LOCAL_ONLY_KEYS) {
    if (!options.config.has(key)) continue;
    const value = options.config.get(key);
    const values = Array.isArray(value) ? value : [value];
    for (const candidate of values) {
      const allowed =
        key === "fetch.localStandinOrigins"
          ? typeof candidate === "string" && isExactLoopbackOrigin(candidate)
          : typeof candidate === "string" && isAllowedUrl(candidate);
      if (!allowed) {
        throw invalidEndpoint(key);
      }
    }
  }
  if (!hasLoopback) return;

  const overlayPath =
    typeof options.overlayPath === "string"
      ? resolve(options.overlayPath)
      : fileURLToPath(options.overlayPath);
  if (!isLocalOverlayPath(overlayPath)) throw invalidEndpoint("local overlay");
  if (!isLoopbackHttpUrl(options.arcRpcUrl)) throw invalidEndpoint("Arc RPC URL");
  if (!(await answersAnvilNodeInfo(options.arcRpcUrl, options.fetchFn ?? fetch))) {
    throw new ConfigError(
      "invalid-value",
      "Arc RPC nodeInfo",
      "refusing to start: Arc RPC did not answer anvil_nodeInfo; use the pinned local arc-anvil process",
    );
  }
}

export function isLocalOverlayPath(path: string | URL): boolean {
  const value = typeof path === "string" ? resolve(path) : fileURLToPath(path);
  return value === LOCAL_OVERLAY;
}

export function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

async function answersAnvilNodeInfo(url: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_nodeInfo", params: [] }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && "result" in body && !("error" in body);
  } catch {
    return false;
  }
}

function isAllowedUrl(value: string): boolean {
  if (isLoopbackHttpUrl(value)) return true;
  try {
    const url = new URL(value);
    return (
      value.startsWith("https://") &&
      url.protocol === "https:" &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "http:";
  } catch {
    return false;
  }
}

function isExactLoopbackOrigin(value: string): boolean {
  if (!isLoopbackHttpUrl(value)) return false;
  return new URL(value).origin === value;
}

function invalidEndpoint(key: string): ConfigError {
  return new ConfigError(
    "invalid-value",
    key,
    `refusing to start: ${key} must use HTTPS or pass the local Arc Anvil guard`,
  );
}
