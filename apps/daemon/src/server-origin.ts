// Server origin for daemon commands that contact Czar (SCR-149 §1). Read only by `czar pair`,
// `czar objective` and `czar result`; never at daemon startup.
import { fileURLToPath } from "node:url";
import {
  isLocalOverlayPath,
  loadConfig,
  loadConfigFile,
  parameterEnvironment,
  type Config,
} from "@czar/config";

export const SERVER_ORIGIN_ENV = "CZAR_DAEMON_SERVER_ORIGIN";
const LOCAL_CONFIG_POINTER = "CZAR_LOCAL_CONFIG";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export interface CommandConfig {
  readonly config: Config;
  /** Absolute path of the overlay the config came from, when one was loaded. */
  readonly overlayPath?: string;
}

/** Loads config for a server-contacting command; `CZAR_LOCAL_CONFIG` names the overlay file. */
export async function loadCommandConfig(
  env: Readonly<Record<string, string | undefined>>,
): Promise<CommandConfig> {
  const pointer = env[LOCAL_CONFIG_POINTER];
  if (pointer === undefined || pointer === "") return { config: loadConfig({ env }) };
  const config = await loadConfigFile(pointer, { env: parameterEnvironment(env) });
  return { config, overlayPath: pointer };
}

/**
 * Resolves `daemon.serverOrigin`: an origin only; `https`, or a loopback `http` origin with a
 * port only when the config came from the local overlay `env/local.toml`.
 */
export function readServerOrigin(input: CommandConfig): URL {
  let raw: unknown;
  try {
    raw = input.config.get("daemon.serverOrigin");
  } catch {
    throw new Error(`daemon.serverOrigin is not set; set ${SERVER_ORIGIN_ENV}.`);
  }
  if (typeof raw !== "string" || raw === "") {
    throw new Error(`daemon.serverOrigin is not set; set ${SERVER_ORIGIN_ENV}.`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("daemon.serverOrigin must be a URL origin.");
  }
  const originOnly =
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname === "/" &&
    !/\/.+/.test(raw.replace(/^[a-z]+:\/\//i, ""));
  if (!originOnly) throw new Error("daemon.serverOrigin must be an origin without a path.");
  if (url.protocol === "https:") return new URL(url.origin);
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && url.port !== "";
  if (loopback && input.overlayPath !== undefined && isLocalOverlayPath(input.overlayPath)) {
    return new URL(url.origin);
  }
  throw new Error(
    "daemon.serverOrigin must use https; a loopback http origin is allowed only with the local overlay env/local.toml.",
  );
}

/** Absolute path of the repository's local overlay, for tests and the runbook. */
export function localOverlayPath(): string {
  return fileURLToPath(new URL("../../../env/local.toml", import.meta.url));
}
