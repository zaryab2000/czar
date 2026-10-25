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
  let pending: { key: string; rawValue: string; line: number } | undefined;
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (pending !== undefined) {
      pending.rawValue += `\n${trimmed}`;
      if (!hasBalancedDelimiters(pending.rawValue)) continue;
      parseValue(values, pending.key, pending.rawValue, pending.line);
      pending = undefined;
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const assignment = /^"([a-zA-Z0-9.-]+)"\s*=\s*(.+)$/.exec(trimmed);
    if (assignment === null) throw new Error(`invalid parameter TOML at line ${index + 1}`);
    const [, key, rawValue] = assignment;
    if (key === undefined || rawValue === undefined || key in values)
      throw new Error(`duplicate or invalid parameter TOML key at line ${index + 1}`);
    if (!hasBalancedDelimiters(rawValue)) {
      pending = { key, rawValue, line: index + 1 };
      continue;
    }
    parseValue(values, key, rawValue, index + 1);
  }
  if (pending !== undefined) throw new Error(`invalid parameter TOML at line ${pending.line}`);
  return values;
}

function parseValue(
  values: Record<string, unknown>,
  key: string,
  rawValue: string,
  line: number,
): void {
  try {
    values[key] = JSON.parse(rawValue) as unknown;
  } catch {
    try {
      values[key] = parseInlineTable(rawValue);
    } catch {
      throw new Error(
        `parameter TOML values must be JSON-compatible or inline tables at line ${line}`,
      );
    }
  }
}

function parseInlineTable(rawValue: string): unknown {
  if (!rawValue.startsWith("{") || !rawValue.endsWith("}")) throw new Error("not an inline table");
  let quoted = false;
  let escaped = false;
  let json = "";
  for (const character of rawValue) {
    if (quoted) {
      json += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
      json += character;
    } else {
      json += character === "=" ? ":" : character;
    }
  }
  return JSON.parse(removeTrailingCommas(json)) as unknown;
}

function hasBalancedDelimiters(value: string): boolean {
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const opening = stack.pop();
      if ((character === "}" && opening !== "{") || (character === "]" && opening !== "[")) {
        return false;
      }
    }
  }
  return !quoted && stack.length === 0;
}

function removeTrailingCommas(value: string): string {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quoted) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      output += character;
    } else if (character === ",") {
      let next = index + 1;
      while (/\s/.test(value[next] ?? "")) next += 1;
      if (value[next] !== "]" && value[next] !== "}") output += character;
    } else {
      output += character;
    }
  }
  return output;
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
