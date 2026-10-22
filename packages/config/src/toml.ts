import { readFile } from "node:fs/promises";
import type { Config, LoadOptions } from "./loader.ts";
import { loadConfig } from "./loader.ts";
import { envVarName } from "./names.ts";
import { PARAMETERS } from "./registry.ts";

/** Load the repository's parameter-only TOML overlay and then apply CZAR_* overrides. */
export async function loadConfigFile(
  path: URL | string,
  options: Omit<LoadOptions, "envFile"> = {},
): Promise<Config> {
  const source = await readFile(path, "utf8");
  return loadConfig({ envFile: parseParameterToml(source), ...options });
}

/** Parse the deliberately small TOML subset used by local parameter overlays. */
export function parseParameterToml(source: string): Readonly<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const assignment = /^"([a-zA-Z0-9.-]+)"\s*=\s*(.+)$/.exec(trimmed);
    if (assignment === null) throw new Error(`invalid parameter TOML at line ${index + 1}`);
    const [, key, rawValue] = assignment;
    if (key === undefined || rawValue === undefined || key in values)
      throw new Error(`duplicate or invalid parameter TOML key at line ${index + 1}`);
    try {
      values[key] = JSON.parse(rawValue) as unknown;
    } catch {
      throw new Error(`parameter TOML values must be JSON-compatible at line ${index + 1}`);
    }
  }
  return values;
}

/** Filter process variables to registered CZAR_* parameters, excluding runtime-only settings. */
export function parameterEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(
    PARAMETERS.flatMap(({ key }) => {
      const name = envVarName(key);
      return environment[name] === undefined ? [] : [[name, environment[name]]];
    }),
  );
}
