import type { Config } from "@czar/config";
import type { AppBundler, AppWalletConfig } from "@czar/schemas";
import type { Context } from "hono";
import { validateRecordedExchange } from "@czar/api-contract";

const BUNDLERS = ["circle", "pimlico", "alchemy", "zerodev"] as const;
const BUNDLER_SET = new Set<string>(BUNDLERS);
type ServerContext = Context<any, any, any>;

export function resolveAppWalletConfig(config: Config): AppWalletConfig {
  const resolved: AppWalletConfig = {
    circleClientUrl: requiredUrl(config.get("app.circleClientUrl"), "app.circleClientUrl"),
    circleClientKey: requiredText(config.get("app.circleClientKey"), "app.circleClientKey"),
    arcRpcUrl: requiredUrl(config.get("app.arcRpcUrl"), "app.arcRpcUrl"),
    bundlerOrder: parseBundlerOrder(config.get("app.bundlerOrder")),
    bundlerEndpoints: parseBundlerEndpoints(config.get("app.bundlerEndpoints")),
  };
  assertContract(resolved);
  return resolved;
}

export function getAppWalletConfigRoute(
  context: ServerContext,
  walletConfig: AppWalletConfig,
): Response {
  assertContract(walletConfig);
  context.header("Cache-Control", "no-store");
  return context.json(walletConfig);
}

function requiredText(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidConfig(key);
  }
  return value;
}

function requiredUrl(value: unknown, key: string): string {
  const text = requiredText(value, key);
  try {
    const url = new URL(text);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw invalidConfig(key);
    }
  } catch {
    throw invalidConfig(key);
  }
  return text;
}

function parseBundlerOrder(value: unknown): readonly AppBundler[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((name) => typeof name !== "string" || !BUNDLER_SET.has(name)) ||
    new Set(value).size !== value.length
  ) {
    throw invalidConfig("app.bundlerOrder");
  }
  return value as AppBundler[];
}

function parseBundlerEndpoints(value: unknown): Partial<Record<AppBundler, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidConfig("app.bundlerEndpoints");
  }
  const endpoints: Partial<Record<AppBundler, string>> = {};
  for (const [name, endpoint] of Object.entries(value)) {
    if (!BUNDLER_SET.has(name)) throw invalidConfig("app.bundlerEndpoints");
    endpoints[name as AppBundler] = requiredUrl(endpoint, "app.bundlerEndpoints");
  }
  return endpoints;
}

function assertContract(walletConfig: AppWalletConfig): void {
  const validation = validateRecordedExchange("getAppWalletConfig", {
    responseStatus: 200,
    responseBody: walletConfig,
  });
  if (!validation.valid) throw invalidConfig("AppWalletConfig");
}

function invalidConfig(key: string): Error {
  return new Error(`Invalid public wallet configuration: ${key}`);
}
