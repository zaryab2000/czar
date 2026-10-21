import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as formats from "ajv-formats";
import { load } from "js-yaml";
import type { Plugin } from "ajv";
import type { ApiContracts, ContractDocument } from "#src/types";

const apiDirectory = fileURLToPath(
  new URL("../../../docs/specs/02-data-and-protocol/api/", import.meta.url),
);
export const contractDocuments = new Map<ContractDocument, string>([
  ["public", resolve(apiDirectory, "openapi.yaml")],
  ["local", resolve(apiDirectory, "local-openapi.yaml")],
]);

type JsonObject = Record<string, unknown>;
type ResolverState = { files: Map<string, unknown>; unresolved: Set<string> };

function parseFile(path: string): unknown {
  return load(readFileSync(path, "utf8"));
}

function pointerValue(value: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "#") return value;
  const fragment = pointer.startsWith("#") ? pointer.slice(1) : pointer;
  if (!fragment.startsWith("/")) throw new Error(`Unsupported reference fragment: ${pointer}`);
  return fragment
    .split("/")
    .slice(1)
    .reduce<unknown>((node, segment) => {
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      if (node === null || typeof node !== "object" || !(key in node)) {
        throw new Error(`Reference pointer does not exist: ${pointer}`);
      }
      return (node as JsonObject)[key];
    }, value);
}

function targetFor(ref: string, ownerPath: string, owner: unknown, files: Map<string, unknown>) {
  const [uri = "", fragment = ""] = ref.split("#", 2);
  if (!uri) return pointerValue(owner, `#${fragment}`);
  const filePath = resolve(dirname(ownerPath), decodeURIComponent(uri));
  if (!files.has(filePath)) files.set(filePath, parseFile(filePath));
  return pointerValue(files.get(filePath), `#${fragment}`);
}

function referenceContext(
  ref: string,
  ownerPath: string,
  owner: unknown,
  files: Map<string, unknown>,
) {
  const [uri = ""] = ref.split("#", 2);
  if (!uri) return { path: ownerPath, root: owner };
  const path = resolve(dirname(ownerPath), decodeURIComponent(uri));
  if (!files.has(path)) files.set(path, parseFile(path));
  return { path, root: files.get(path) };
}

function visitReferences(
  value: unknown,
  ownerPath: string,
  owner: unknown,
  state: ResolverState,
  visited = new Set<object>(),
): void {
  if (!value || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) visitReferences(item, ownerPath, owner, state, visited);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") {
      try {
        const target = targetFor(child, ownerPath, owner, state.files);
        const context = referenceContext(child, ownerPath, owner, state.files);
        visitReferences(target, context.path, context.root, state, visited);
      } catch {
        state.unresolved.add(`${ownerPath}: ${child}`);
      }
    } else {
      visitReferences(child, ownerPath, owner, state, visited);
    }
  }
}

export function resolveReference(ref: string, document: ContractDocument = "public"): unknown {
  const ownerPath = contractDocuments.get(document);
  if (!ownerPath) throw new Error(`Unknown OpenAPI document: ${document}`);
  return targetFor(ref, ownerPath, parseFile(ownerPath), new Map());
}

function inlineReferences(
  value: unknown,
  ownerPath: string,
  owner: unknown,
  files: Map<string, unknown>,
  trail = new Set<string>(),
): unknown {
  if (Array.isArray(value))
    return value.map((child) => inlineReferences(child, ownerPath, owner, files, trail));
  if (!value || typeof value !== "object") return value;
  const object = value as JsonObject;
  if (typeof object["$ref"] === "string") {
    const ref = object["$ref"] as string;
    const identity = `${ownerPath}#${ref}`;
    if (trail.has(identity)) throw new Error(`Circular OpenAPI schema reference: ${identity}`);
    const target = targetFor(ref, ownerPath, owner, files);
    const context = referenceContext(ref, ownerPath, owner, files);
    const nextTrail = new Set(trail).add(identity);
    const resolved = inlineReferences(target, context.path, context.root, files, nextTrail);
    const siblings = Object.fromEntries(Object.entries(object).filter(([key]) => key !== "$ref"));
    return Object.keys(siblings).length
      ? { allOf: [resolved, inlineReferences(siblings, ownerPath, owner, files, trail)] }
      : resolved;
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [
      key,
      inlineReferences(child, ownerPath, owner, files, trail),
    ]),
  );
}

function schemaValidator(
  schema: unknown,
  path: string,
  document: unknown,
  files: Map<string, unknown>,
) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const addFormats = formats.default as unknown as Plugin<undefined>;
  addFormats(ajv);
  return ajv.compile(inlineReferences(schema, path, document, files) as object);
}

function recordOperations(
  document: ContractDocument,
  path: string,
  root: JsonObject,
  files: Map<string, unknown>,
  contracts: Map<string, import("#src/types").OperationContract>,
): void {
  const paths = root["paths"] as JsonObject;
  for (const pathItem of Object.values(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (!["get", "put", "post", "delete", "patch", "options", "head"].includes(method)) continue;
      const operation = operationValue as JsonObject;
      const id = operation["operationId"];
      if (typeof id !== "string") throw new Error(`Operation ${method} has no operationId`);
      if (contracts.has(id)) throw new Error(`Duplicate operationId: ${id}`);
      const requestBody = operation["requestBody"] as JsonObject | undefined;
      const requestSchema = findContentSchema(requestBody);
      const request =
        requestSchema === undefined ? undefined : schemaValidator(requestSchema, path, root, files);
      const responses = new Map<string, ReturnType<typeof schemaValidator>>();
      const responseObject = operation["responses"] as JsonObject;
      const responseStatuses = new Set(Object.keys(responseObject));
      for (const [status, response] of Object.entries(responseObject)) {
        const resolved =
          typeof (response as JsonObject)?.["$ref"] === "string"
            ? targetFor((response as JsonObject)["$ref"] as string, path, root, files)
            : response;
        const schema = findContentSchema(resolved as JsonObject);
        if (schema !== undefined) responses.set(status, schemaValidator(schema, path, root, files));
      }
      contracts.set(id, { document, ...(request ? { request } : {}), responseStatuses, responses });
    }
  }
}

function findContentSchema(container?: JsonObject): unknown {
  const content = container?.["content"] as JsonObject | undefined;
  if (!content) return undefined;
  const media = Object.values(content).find((value) => value && typeof value === "object") as
    | JsonObject
    | undefined;
  return media?.["schema"];
}

export function compileContracts(): ApiContracts {
  const contracts = new Map<string, import("#src/types").OperationContract>();
  for (const [document, path] of contractDocuments) {
    const root = parseFile(path) as JsonObject;
    const state: ResolverState = { files: new Map([[path, root]]), unresolved: new Set() };
    visitReferences(root, path, root, state);
    if (state.unresolved.size) {
      throw new Error(`Unresolved $ref values:\n${[...state.unresolved].toSorted().join("\n")}`);
    }
    recordOperations(document, path, root, state.files, contracts);
  }
  return contracts;
}
