type InputValue = string | number | boolean;
type InputType = "string" | "number" | "integer" | "boolean";

export interface CircleInputShape {
  readonly freeTextKey: string;
  readonly freeTextMaxLength?: number;
  readonly fixedInputs: Readonly<Record<string, InputValue>>;
  readonly inputFields: readonly { readonly name: string; readonly type: InputType }[];
}

const INPUT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_INPUT_KEYS = 20;
const MAX_STRING_LENGTH = 2000;

/** Maps a Circle JSON body or query schema to one template field and bounded fixed values. */
export function mapCircleInput(input: unknown, method: "GET" | "POST"): CircleInputShape | null {
  if (!isRecord(input)) return null;
  const schema = input[method === "GET" ? "queryParams" : "body"];
  if (!isRecord(schema) || schema["type"] !== "object") return null;
  const properties = schema["properties"];
  const required = schema["required"];
  if (!isRecord(properties) || !Array.isArray(required) || !required.every(isInputKey)) return null;
  const entries = Object.entries(properties);
  if (entries.length === 0) return null;
  if (entries.some(([key, property]) => !isInputKey(key) || !isRecord(property))) return null;
  const requiredKeys = new Set(required);
  if ([...requiredKeys].some((key) => !(key in properties))) return null;
  const freeTextKeys = entries.filter(
    ([key, property]) =>
      requiredKeys.has(key) &&
      (property as Record<string, unknown>)["type"] === "string" &&
      !hasValue(property as Record<string, unknown>, key, schema),
  );
  if (freeTextKeys.length !== 1) return null;
  const freeTextKey = freeTextKeys[0]![0];
  const freeTextProperty = freeTextKeys[0]![1] as Record<string, unknown>;
  if (
    Object.hasOwn(freeTextProperty, "enum") ||
    Object.hasOwn(freeTextProperty, "const") ||
    Object.hasOwn(freeTextProperty, "pattern")
  )
    return null;
  const declaredLength = freeTextProperty["maxLength"];
  if (
    declaredLength !== undefined &&
    (!Number.isSafeInteger(declaredLength) || (declaredLength as number) < 1)
  )
    return null;
  const fixed: Array<readonly [string, InputValue]> = [];
  const inputFields: Array<{ name: string; type: InputType }> = [];
  for (const [key, property] of entries) {
    if (!isRecord(property)) return null;
    if (key === freeTextKey) {
      inputFields.push({ name: key, type: "string" });
      continue;
    }
    const candidate = readValue(property, key, schema);
    if (!candidate.found) {
      if (requiredKeys.has(key)) return null;
      continue;
    }
    const type = property["type"];
    if (!isInputType(type)) return null;
    if (!validValue(candidate.value, type, property)) return null;
    fixed.push([key, candidate.value]);
    inputFields.push({ name: key, type });
    if (inputFields.length > MAX_INPUT_KEYS) return null;
  }
  return {
    freeTextKey,
    ...(typeof declaredLength === "number"
      ? { freeTextMaxLength: Math.min(declaredLength, MAX_STRING_LENGTH) }
      : {}),
    fixedInputs: Object.fromEntries(fixed),
    inputFields,
  };
}

function readValue(
  property: Record<string, unknown>,
  key: string,
  schema: Record<string, unknown>,
): { found: false } | { found: true; value: unknown } {
  if (Object.hasOwn(property, "default")) return { found: true, value: property["default"] };
  if (Object.hasOwn(property, "example")) return { found: true, value: property["example"] };
  const example = schema["example"];
  if (isRecord(example) && Object.hasOwn(example, key)) return { found: true, value: example[key] };
  return { found: false };
}

function hasValue(
  property: Record<string, unknown>,
  key: string,
  schema: Record<string, unknown>,
): boolean {
  return readValue(property, key, schema).found;
}

function validValue(
  value: unknown,
  type: InputType,
  schema: Record<string, unknown>,
): value is InputValue {
  if (type === "string" && (typeof value !== "string" || value.length > MAX_STRING_LENGTH))
    return false;
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return false;
  if (type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value)))
    return false;
  if (type === "boolean" && typeof value !== "boolean") return false;
  if (typeof value === "string" && typeof schema["maxLength"] === "number") {
    if (!Number.isSafeInteger(schema["maxLength"]) || value.length > schema["maxLength"])
      return false;
  }
  if (
    typeof value === "number" &&
    typeof schema["minimum"] === "number" &&
    value < schema["minimum"]
  )
    return false;
  if (
    typeof value === "number" &&
    typeof schema["maximum"] === "number" &&
    value > schema["maximum"]
  )
    return false;
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) return false;
  return !Object.hasOwn(schema, "const") || schema["const"] === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInputKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "inputKeys" &&
    value !== "expectedKeys" &&
    INPUT_KEY.test(value)
  );
}

function isInputType(value: unknown): value is InputType {
  return value === "string" || value === "number" || value === "integer" || value === "boolean";
}
