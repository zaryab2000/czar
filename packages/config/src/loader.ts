// Config loader (T-004): built-in defaults → environment file → CZAR_* variables → nothing else.
// Unknown keys, secret-like names and overrides of contract mirrors fail at startup.
import { ConfigError } from "./errors.ts";
import { ENV_PREFIX, envVarName, hasSecretLikeName } from "./names.ts";
import { PARAMETERS } from "./registry.ts";
import type { ParameterSpec, ParameterValue, ResolvedParameter, ValueSource } from "./types.ts";

export type ParameterKey = (typeof PARAMETERS)[number]["key"];

export interface LoadOptions {
  /** Parsed environment file (`local`, `testnet`): a flat object of registry key → value. */
  readonly envFile?: Readonly<Record<string, unknown>>;
  /** Process environment; only `CZAR_*` names are read. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface Config {
  get(key: ParameterKey): ParameterValue;
  has(key: ParameterKey): boolean;
  /** Every parameter with its resolved value and where it came from, sorted by key. */
  dump(): readonly ResolvedParameter[];
}

const SPECS: ReadonlyMap<string, ParameterSpec> = new Map(
  PARAMETERS.map((spec) => [spec.key, spec]),
);
const BY_ENV_NAME: ReadonlyMap<string, ParameterSpec> = new Map(
  PARAMETERS.map((spec) => [envVarName(spec.key), spec]),
);

export function parameterSpec(key: string): ParameterSpec | undefined {
  return SPECS.get(key);
}

export function loadConfig(options: LoadOptions = {}): Config {
  const values = new Map<string, { value: ParameterValue | null; source: ValueSource }>();
  for (const spec of PARAMETERS) {
    values.set(spec.key, { value: spec.default, source: "default" });
  }

  for (const [key, raw] of Object.entries(options.envFile ?? {})) {
    const spec = requireWritable(key, key);
    values.set(key, { value: checkValue(spec, raw, key), source: "env-file" });
  }

  for (const [name, raw] of Object.entries(options.env ?? {})) {
    if (!name.startsWith(ENV_PREFIX) || raw === undefined) continue;
    if (hasSecretLikeName(name)) {
      throw new ConfigError(
        "secret-like-name",
        name,
        `refusing to start: ${name} looks like a secret (D78)`,
      );
    }
    const spec = BY_ENV_NAME.get(name);
    if (spec === undefined) {
      throw new ConfigError("unknown-key", name, `unknown configuration variable ${name}`);
    }
    requireWritable(spec.key, name);
    values.set(spec.key, {
      value: checkValue(spec, parseEnvString(spec, raw, name), name),
      source: "env-var",
    });
  }

  return {
    get(key) {
      const entry = values.get(key);
      if (entry === undefined)
        throw new ConfigError("unknown-key", key, `unknown configuration key ${key}`);
      if (entry.value === null) {
        throw new ConfigError(
          "missing-value",
          key,
          `${key} has no default in the specs; set ${envVarName(key)}`,
        );
      }
      return entry.value;
    },
    has(key) {
      return (values.get(key)?.value ?? null) !== null;
    },
    dump() {
      return [...values.entries()]
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => ({
          key,
          value: entry.value,
          source: entry.source,
          unit: SPECS.get(key)?.unit ?? "",
        }));
    },
  };
}

function requireWritable(key: string, name: string): ParameterSpec {
  if (hasSecretLikeName(key)) {
    throw new ConfigError(
      "secret-like-name",
      name,
      `refusing to start: ${name} looks like a secret (D78)`,
    );
  }
  const spec = SPECS.get(key);
  if (spec === undefined)
    throw new ConfigError("unknown-key", name, `unknown configuration key ${name}`);
  if (spec.readOnly === true) {
    throw new ConfigError(
      "read-only",
      name,
      `${key} mirrors a contract constant and cannot be configured`,
    );
  }
  return spec;
}

function parseEnvString(spec: ParameterSpec, raw: string, name: string): unknown {
  switch (spec.type) {
    case "integer":
    case "number":
      return raw.trim() === "" ? Number.NaN : Number(raw);
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw invalid(name, "expected true or false");
    case "string":
    case "enum":
      return raw;
    case "string[]":
    case "object":
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw invalid(name, "expected JSON");
      }
  }
}

function checkValue(spec: ParameterSpec, value: unknown, name: string): ParameterValue {
  switch (spec.type) {
    case "integer":
      if (typeof value === "number" && Number.isSafeInteger(value)) return value;
      throw invalid(name, "expected an integer");
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) return value;
      throw invalid(name, "expected a number");
    case "boolean":
      if (typeof value === "boolean") return value;
      throw invalid(name, "expected a boolean");
    case "string":
      if (typeof value === "string") return value;
      throw invalid(name, "expected a string");
    case "enum":
      if (typeof value === "string" && (spec.values ?? []).includes(value)) return value;
      throw invalid(name, `expected one of ${(spec.values ?? []).join(", ")}`);
    case "string[]":
      if (Array.isArray(value) && value.every((item) => typeof item === "string"))
        return value as string[];
      throw invalid(name, "expected an array of strings");
    case "object":
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
      throw invalid(name, "expected an object");
  }
}

function invalid(name: string, why: string): ConfigError {
  return new ConfigError("invalid-value", name, `invalid value for ${name}: ${why}`);
}
