// The log field allowlist (T-005, cross-cutting §4). A field is emitted only when its name matches a
// rule here AND its value has that rule's shape; everything else is dropped. Free text has no rule.

export type FieldValue = string | number | boolean | readonly string[];

interface FieldRule {
  readonly name: RegExp;
  /** Returns the value to emit, or undefined to drop the field. */
  readonly accept: (value: unknown) => FieldValue | undefined;
}

const HASH32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT6 = /^(0|[1-9][0-9]{0,77})$/;
const CZAR_ID = /^(obj|pln|stp|pay|res|dev|bat)_[0-9A-Za-z]{1,64}$/;
/** Enum states and codes: one lowercase token, no spaces, so sentences cannot pass. */
const ENUM_TOKEN = /^[a-z][a-z0-9_.:-]{0,63}$/;
/** Anything shaped like an IP literal is never an enum value (IPs are only logged truncated). */
const IP_LIKE = /^[0-9.]+$|^[0-9a-f]*:[0-9a-f:.]*$/;
const MARKER = /^\[\[R:(S|P):[A-Za-z0-9_-]{1,64}(#[0-9]{1,4})?\]\]$/;
const HOST =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$/;
const MODEL = /^[a-z][a-z0-9.-]{0,63}$/;

const matches = (pattern: RegExp) => (value: unknown) =>
  typeof value === "string" && pattern.test(value) ? value : undefined;

const enumToken = (value: unknown) =>
  typeof value === "string" && ENUM_TOKEN.test(value) && !IP_LIKE.test(value) ? value : undefined;

const nonNegativeInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const integerOrHash = (value: unknown) =>
  nonNegativeInteger(value) ??
  (typeof value === "string" && (HASH32.test(value) || /^[0-9]{1,78}$/.test(value))
    ? value
    : undefined);

const httpStatus = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;

const markers = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && MARKER.test(item))
    ? (value as string[])
    : undefined;

const enumList = (value: unknown) =>
  Array.isArray(value) && value.every((item) => enumToken(item) !== undefined)
    ? (value as string[])
    : undefined;

/** `https://api.example.com/v1/x?q=secret` → `api.example.com`. Only the origin host is ever logged. */
export function originHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let host = value;
  try {
    host = new URL(value).host;
  } catch {
    // Not a URL: accept it only if it already is a bare host.
  }
  host = host.toLowerCase();
  const bare = host.replace(/^\[|\](:[0-9]+)?$|:[0-9]+$/g, "");
  if (/^[0-9.]+$/.test(bare) || bare.includes(":")) return truncateIp(bare);
  return HOST.test(host) ? host : undefined;
}

/** IPv4 → /24 (`203.0.113.0/24`), IPv6 → /48 (SL §11). */
export function truncateIp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4 !== null) {
    const octets = v4.slice(1, 4).map(Number);
    return octets.every((octet) => octet <= 255) ? `${octets.join(".")}.0/24` : undefined;
  }
  if (!/^[0-9a-fA-F:]+$/.test(value) || !value.includes(":")) return undefined;
  const [head = "", tail = ""] = value.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === "" ? [] : tail.split(":");
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0 || (!value.includes("::") && missing !== 0)) return undefined;
  const groups = [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups];
  if (groups.some((group) => group.length > 4)) return undefined;
  return `${groups
    .slice(0, 3)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/48`;
}

export const FIELD_RULES: readonly FieldRule[] = [
  { name: /^(traceId|spanId)$/, accept: matches(/^[0-9a-f]{16,32}$/) },
  {
    name: /^(objectiveId|planId|stepId|paymentId|deviceId|batchId|reservationRef)$/,
    accept: matches(CZAR_ID),
  },
  { name: /^(envelopeRef|jobKey)$/, accept: matches(HASH32) },
  { name: /^(reservationId|pullbackId|jobId)$/, accept: integerOrHash },
  { name: /^([a-z][A-Za-z0-9]*Hash|hash)$/, accept: matches(HASH32) },
  {
    name: /^([a-z][A-Za-z0-9]*Address|vault|payee|payTo|from|to|owner|agent|pocket|token)$/,
    accept: matches(ADDRESS),
  },
  { name: /^([a-z][A-Za-z0-9]*Atomic|amount)$/, accept: matches(AMOUNT6) },
  {
    name: /^([a-z][A-Za-z0-9]*Count|count|[a-z][A-Za-z0-9]*Tokens|attempt|index)$/,
    accept: nonNegativeInteger,
  },
  { name: /^steps$/, accept: nonNegativeInteger },
  { name: /^surface$/, accept: matches(/^(cli|web)$/) },
  { name: /^value$/, accept: matches(/^(good|bad)$/) },
  { name: /^([a-z][A-Za-z0-9]*Ms|durationMs)$/, accept: nonNegativeInteger },
  { name: /^method$/, accept: matches(/^(GET|POST|PUT|PATCH|DELETE)$/) },
  { name: /^route$/, accept: matches(/^[a-z][A-Za-z0-9]{0,63}$/) },
  /** Signer key ids (`K3`…`K20`, `relayer`; CZ-27 §4), the audit log's actor key id. */
  { name: /^keyId$/, accept: matches(/^(K[0-9]{1,2}|relayer)$/) },
  {
    name: /^(state|status|outcome|kind|mode|host|layer|rule|entity|czarCode|errorCode|method|route|network)$/,
    accept: matches(ENUM_TOKEN),
  },
  { name: /^(rules|entities|flags|hosts)$/, accept: enumList },
  { name: /^httpStatus$/, accept: httpStatus },
  { name: /^(blockNumber|fromBlock|toBlock|chainId)$/, accept: nonNegativeInteger },
  { name: /^originHost$/, accept: originHost },
  { name: /^ip$/, accept: truncateIp },
  { name: /^model$/, accept: matches(MODEL) },
  { name: /^promptHash$/, accept: matches(HASH32) },
  { name: /^markers$/, accept: markers },
  { name: /^(retryable|ok)$/, accept: (value) => (typeof value === "boolean" ? value : undefined) },
];

export function acceptField(name: string, value: unknown): FieldValue | undefined {
  const rule = FIELD_RULES.find((candidate) => candidate.name.test(name));
  return rule?.accept(value);
}
