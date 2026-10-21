import type { AnySchema } from "ajv";
import { allSchemas } from "#/schema-source";
import { getCompiledValidator, getSchema, validateSchema } from "#/validator";
import type { SchemaName, SchemaTypes } from "#/generated/types";

export type PrivacyClass =
  | "local-only"
  | "redacted-to-server"
  | "server-only"
  | "hash-on-chain"
  | "public";

export class LocalOnlyFieldError extends Error {
  readonly fieldPath: string;

  constructor(fieldPath: string) {
    super(`Outbound object contains local-only field at "${fieldPath}".`);
    this.name = "LocalOnlyFieldError";
    this.fieldPath = fieldPath;
  }
}

export class SchemaValidationError extends Error {
  readonly schemaName: SchemaName;
  readonly fieldPaths: readonly string[];

  constructor(schemaName: SchemaName, fieldPaths: readonly string[]) {
    super(`Value does not match JSON Schema "${schemaName}".`);
    this.name = "SchemaValidationError";
    this.schemaName = schemaName;
    this.fieldPaths = fieldPaths;
  }
}

export function privacyClassOf(name: SchemaName, field: string): PrivacyClass | undefined {
  const root = getSchema(name);
  const parts = field.split(".").filter(Boolean);
  if (parts.length === 0) return privacyClass(root);
  let current: AnySchema = root;

  for (const part of parts) {
    current = resolveReference(current);
    if (part === "[]") {
      current = (asSchema(current)["items"] as AnySchema) ?? {};
    } else {
      current = childFor(asSchema(current), part) ?? {};
    }
  }

  return privacyClass(current);
}

export function assertNoLocalOnly<Name extends SchemaName = "objective-submission">(
  value: unknown,
  name: Name = "objective-submission" as Name,
): asserts value is SchemaTypes[Name] {
  const validator = getCompiledValidator(name);
  if (!validateSchema(name, value)) {
    const fieldPaths = (validator.errors ?? []).map((error) => error.instancePath || "/");
    throw new SchemaValidationError(name, fieldPaths);
  }
  assertPrivacy(getSchema(name), value, "");
}

function assertPrivacy(schema: AnySchema, value: unknown, path: string): void {
  const node = asSchema(resolveReference(schema));
  if (node["x-privacyClass"] === "local-only") throw new LocalOnlyFieldError(path || "/");
  if (Array.isArray(value)) {
    const items = node["items"];
    if (isSchema(items)) {
      value.forEach((item, index) => assertPrivacy(items, item, `${path}/${index}`));
    }
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, item] of Object.entries(value)) {
    const childSchema = childFor(node, key);
    if (!childSchema) continue;
    const childPath = `${path}/${key}`;
    assertPrivacy(childSchema, item, childPath);
  }
}

function childFor(node: Record<string, unknown>, key: string): AnySchema | undefined {
  const direct = asRecord(node["properties"])[key] ?? asRecord(node["patternProperties"])[key];
  if (isSchema(direct)) return direct;
  const branches = [node["allOf"], node["oneOf"], node["anyOf"]]
    .filter(Array.isArray)
    .flat() as AnySchema[];
  for (const branch of branches) {
    const child = childFor(asSchema(branch), key);
    if (child) return child;
  }
  const additionalProperties = node["additionalProperties"];
  if (isSchema(additionalProperties)) return additionalProperties;
  return undefined;
}

function resolveReference(schema: AnySchema, seen = new Set<string>()): AnySchema {
  const node = asSchema(schema);
  const reference = node["$ref"];
  if (typeof reference !== "string" || seen.has(reference)) return schema;
  seen.add(reference);
  const resolved = resolvePointer(reference);
  return resolved ? resolveReference(resolved, seen) : schema;
}

function resolvePointer(reference: string): AnySchema | undefined {
  const resolvedUrl = new URL(reference, "https://czar.dev/schemas/common.schema.json");
  const schemaId = `${resolvedUrl.origin}${resolvedUrl.pathname}`;
  const root = [...allSchemas.values()].find((schema) => asSchema(schema)["$id"] === schemaId);
  if (!root) return undefined;
  const pointer = decodeURIComponent(resolvedUrl.hash.slice(1)).split("/").filter(Boolean);
  let value: unknown = root;
  for (const segment of pointer) {
    if (!isRecord(value)) return undefined;
    value = value[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return value && typeof value === "object" ? (value as AnySchema) : undefined;
}

function privacyClass(schema: AnySchema): PrivacyClass | undefined {
  const value = asSchema(schema)["x-privacyClass"];
  return isPrivacyClass(value) ? value : undefined;
}

function isPrivacyClass(value: unknown): value is PrivacyClass {
  return (
    value === "local-only" ||
    value === "redacted-to-server" ||
    value === "server-only" ||
    value === "hash-on-chain" ||
    value === "public"
  );
}

function asSchema(schema: AnySchema): Record<string, unknown> {
  return typeof schema === "object" && schema !== null ? (schema as Record<string, unknown>) : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isSchema(value: unknown): value is AnySchema {
  return typeof value === "boolean" || (typeof value === "object" && value !== null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
