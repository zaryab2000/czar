// Request shapes per kind (CZ-27 §5.2). Every payload is checked field by field; unknown fields,
// wrong types and out-of-range integers are refused before any projection read.
import type { AbiParameter } from "viem";
import type { Address, Hash32 } from "@czar/hashing";
import type { PaymentRef } from "@czar/schemas";
import { validatePaymentRef } from "@czar/schemas";
import type { Kind } from "./kinds.ts";

export class ShapeError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`bad request field ${field}`);
    this.field = field;
    this.name = "ShapeError";
  }
}

type Field = "address" | "bytes32" | "uint" | "uint8" | "uint16" | "uint32" | "uint64" | "string";
type Shape = Readonly<
  Record<string, Field | readonly string[] | "object" | "receipt" | "paymentRef" | "args">
>;

const RECEIPT_FIELDS: Readonly<Record<string, Field>> = {
  paymentRefHash: "bytes32",
  requestCommit: "bytes32",
  responseCommit: "bytes32",
  statusCode: "uint16",
  originAsserted: "string",
  requirementsHashSeen: "bytes32",
  tRequest: "uint64",
  tPaymentSigned: "uint64",
  tComplete: "uint64",
  outcome: "uint8",
  localChecksCommit: "bytes32",
  disclosure: "uint8",
  createdAt: "uint64",
};

const REPORT_FIELDS: Readonly<Record<string, Field>> = {
  obsId: "bytes32",
  profileId: "bytes32",
  methodVersion: "bytes32",
  assignmentKind: "uint8",
  saltCommit: "bytes32",
  checksCommit: "bytes32",
  createdAt: "uint64",
};

export const SHAPES: Readonly<Record<Kind, Shape>> = {
  "vault-call": { vault: "address", selector: "string", args: "args" },
  "usdc-3009": {
    vault: "address",
    reservationId: "uint64",
    index: "uint32",
    to: "address",
    value: "uint",
    validBefore: "uint",
  },
  "gateway-burn": { vault: "address", pullbackId: "uint64" },
  "sl-receipt": { vault: "address", receipt: "receipt", paymentRef: "paymentRef" },
  "autonomy-raise": {
    vault: "address",
    categoryId: "bytes32",
    newLimit: "uint",
    periodId: "uint64",
    deadline: "uint",
  },
  "evaluator-call": {
    escrow: "address",
    jobId: "uint",
    decision: ["complete", "reject"],
    reportHash: "bytes32",
  },
  "sl-validation-report": { report: "object" },
  "oel-commit": {
    kind: "uint8",
    root: "bytes32",
    prev: "bytes32",
    uriHash: "bytes32",
    uri: "string",
  },
  "merchant-seller-proof": {
    service: "string",
    purpose: ["verify", "settle"],
    method: ["POST"],
    bodyHash: "bytes32",
    network: "string",
    nonce: "bytes32",
    expiry: "uint64",
  },
  "relayer-tx": { to: "address", selector: "string", args: "args" },
  "gas-refill": { target: "address", amount: "uint" },
  "gateway-nano": {
    pocket: "address",
    payTo: "address",
    amount: "uint",
    validBefore: "uint",
    nonce: "bytes32",
  },
  "pocket-delegate": { pocket: "address", vault: "address" },
  "pocket-return": { pocket: "address", kind: ["usdc", "native"], amount: "uint" },
  "pocket-slow-withdraw": { pocket: "address", step: ["initiate", "withdraw"], value: "uint" },
};

/** Fields a request may omit. */
const OPTIONAL: Readonly<Partial<Record<Kind, readonly string[]>>> = {
  "pocket-slow-withdraw": ["value"],
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const BITS: Readonly<Record<string, number>> = {
  uint: 256,
  uint8: 8,
  uint16: 16,
  uint32: 32,
  uint64: 64,
};
const MAX_STRING = 2048;

function scalar(type: Field, value: unknown, field: string): unknown {
  switch (type) {
    case "address":
      if (typeof value !== "string" || !ADDRESS.test(value)) throw new ShapeError(field);
      return value.toLowerCase() as Address;
    case "bytes32":
      if (typeof value !== "string" || !BYTES32.test(value)) throw new ShapeError(field);
      return value.toLowerCase() as Hash32;
    case "string":
      if (typeof value !== "string" || value.length > MAX_STRING) throw new ShapeError(field);
      return value;
    default: {
      // Integers travel as decimal strings so JSON cannot round them.
      if (typeof value !== "string" || !DECIMAL.test(value)) throw new ShapeError(field);
      const n = BigInt(value);
      if (n >= 1n << BigInt(BITS[type] ?? 256)) throw new ShapeError(field);
      return type === "uint8" || type === "uint16" || type === "uint32" ? Number(n) : n;
    }
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ShapeError(field);
  return value as Record<string, unknown>;
}

function fixed(fields: Readonly<Record<string, Field>>, value: unknown, field: string) {
  const input = record(value, field);
  for (const key of Object.keys(input)) {
    if (!(key in fields)) throw new ShapeError(`${field}.${key}`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(fields)) {
    out[key] = scalar(type, input[key], `${field}.${key}`);
  }
  return out;
}

/** Checks a payload against its kind's shape and returns typed values (bigint, number, lowercase hex). */
export function parseRequest(kind: Kind, payload: unknown): Record<string, unknown> {
  const shape = SHAPES[kind];
  const input = record(payload, "payload");
  for (const key of Object.keys(input)) {
    if (!(key in shape)) throw new ShapeError(key);
  }
  const optional = OPTIONAL[kind] ?? [];
  const out: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(shape)) {
    const value = input[key];
    if (value === undefined && optional.includes(key)) continue;
    if (Array.isArray(type)) {
      if (typeof value !== "string" || !type.includes(value)) throw new ShapeError(key);
      out[key] = value;
    } else if (type === "receipt") {
      out[key] = fixed(RECEIPT_FIELDS, value, key);
    } else if (type === "paymentRef") {
      if (!validatePaymentRef(value)) throw new ShapeError(key);
      out[key] = value as PaymentRef;
    } else if (type === "object") {
      out[key] = fixed(REPORT_FIELDS, value, key);
    } else if (type === "args") {
      out[key] = record(value, key);
    } else {
      out[key] = scalar(type as Field, value, key);
    }
  }
  return out;
}

function abiValue(param: AbiParameter, value: unknown, field: string): unknown {
  const { type } = param;
  if (type.endsWith("[]")) {
    if (!Array.isArray(value) || value.length > 64) throw new ShapeError(field);
    const inner = { ...param, type: type.slice(0, -2) } as AbiParameter;
    return value.map((item, i) => abiValue(inner, item, `${field}[${i}]`));
  }
  if (type === "tuple") {
    const components = (param as { components: readonly AbiParameter[] }).components;
    return coerceArgs(components, value, field);
  }
  if (type === "address" || type === "bytes32" || type === "string") {
    return scalar(type, value, field);
  }
  if (type === "bytes") {
    if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value) || value.length > 8194)
      throw new ShapeError(field);
    return value.toLowerCase();
  }
  const bits = /^uint(\d+)$/.exec(type);
  if (bits !== null) {
    if (typeof value !== "string" || !DECIMAL.test(value)) throw new ShapeError(field);
    const n = BigInt(value);
    const width = Number(bits[1]);
    if (n >= 1n << BigInt(width)) throw new ShapeError(field);
    return width <= 48 ? Number(n) : n;
  }
  throw new ShapeError(field);
}

/** Named args → positional ABI values; every input present, nothing extra (the signer encodes, §5.2). */
export function coerceArgs(
  inputs: readonly AbiParameter[],
  args: unknown,
  field = "args",
): unknown[] {
  const input = record(args, field);
  const names = new Set(inputs.map((param) => param.name ?? ""));
  for (const key of Object.keys(input)) {
    if (!names.has(key)) throw new ShapeError(`${field}.${key}`);
  }
  return inputs.map((param) => {
    const name = param.name ?? "";
    if (!(name in input)) throw new ShapeError(`${field}.${name}`);
    return abiValue(param, input[name], `${field}.${name}`);
  });
}
