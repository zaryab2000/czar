import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnySchema } from "ajv";
import { schemaMetadata } from "#/generated/metadata";
import type { SchemaName } from "#/generated/metadata";

const schemaDirectory = new URL(
  "../../../docs/specs/02-data-and-protocol/schemas/",
  import.meta.url,
);
const schemaRoot = fileURLToPath(schemaDirectory);
const schemaFiles = readdirSync(schemaRoot)
  .filter((filename) => filename.endsWith(".schema.json"))
  .toSorted();

const allSchemaNames = schemaFiles
  .map((filename) => filename.replace(/\.schema\.json$/, "").replace(/\.v(\d+)$/, "-v$1"))
  .toSorted();
const schemaNames = allSchemaNames.filter((name) => name !== "common");
const expectedNames = schemaMetadata.map(({ name }) => name).toSorted();

if (JSON.stringify(schemaNames) !== JSON.stringify(expectedNames)) {
  throw new Error("Schema metadata is stale. Run pnpm --filter @czar/schemas generate.");
}

export const allSchemas = new Map<string, AnySchema>();
export const schemas = new Map<SchemaName, AnySchema>();

for (const name of allSchemaNames) {
  const filename = name.replace(/-v(\d+)$/, ".v$1") + ".schema.json";
  const schema = JSON.parse(readFileSync(new URL(filename, schemaDirectory), "utf8")) as AnySchema;
  allSchemas.set(name, schema);
  if (name !== "common") schemas.set(name as SchemaName, schema);
}
