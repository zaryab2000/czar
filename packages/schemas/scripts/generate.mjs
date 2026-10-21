import { compileFromFile } from "json-schema-to-typescript";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(packageDirectory, "../..");
const schemaDirectory = path.join(repositoryDirectory, "docs/specs/02-data-and-protocol/schemas");
const generatedDirectory = path.join(packageDirectory, "src/generated");
const schemaFiles = (await readdir(schemaDirectory))
  .filter((filename) => filename.endsWith(".schema.json"))
  .toSorted();

await mkdir(generatedDirectory, { recursive: true });
const exports = [];

for (const filename of schemaFiles) {
  const schemaPath = path.join(schemaDirectory, filename);
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const schemaName = filename.replace(/\.schema\.json$/, "").replace(/\.v(\d+)$/, "-v$1");
  const typeName = pascalCase(schemaName);
  const output = await compileFromFile(schemaPath, {
    bannerComment: "// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.",
    cwd: schemaDirectory,
    customName: (referencedSchema) => (referencedSchema.$id === schema.$id ? typeName : undefined),
    declareExternallyReferenced: true,
    ignoreMinAndMaxItems: true,
    unreachableDefinitions: true,
  });
  const typeFile = `${schemaName}.d.ts`;
  await writeFile(path.join(generatedDirectory, typeFile), output);
  const exportedTypeNames = [...output.matchAll(/^export (?:interface|type) (\w+)/gm)].map(
    ([, name]) => name,
  );
  exports.push({ schemaName, typeName, typeFile, title: schema.title, exportedTypeNames });
}

const schemaExports = exports.filter(({ schemaName }) => schemaName !== "common");
const commonTypes =
  exports.find(({ schemaName }) => schemaName === "common")?.exportedTypeNames ?? [];
const typeExports = schemaExports
  .map(({ typeName, typeFile }) => `export type { ${typeName} } from "./${typeFile}";`)
  .concat(
    commonTypes
      .filter((typeName) => typeName !== "Common")
      .map((typeName) => `export type { ${typeName} } from "./common.d.ts";`),
  )
  .join("\n");
const schemaTypes = schemaExports
  .map(({ schemaName, typeName, typeFile }) => {
    return `  "${schemaName}": import("./${typeFile}").${typeName};`;
  })
  .join("\n");
await writeFile(
  path.join(generatedDirectory, "types.ts"),
  `${typeExports}\nexport type { SchemaName } from "./metadata.ts";\n` +
    `export interface SchemaTypes {\n${schemaTypes}\n}\n`,
);

const schemaNameUnion = schemaExports.map(({ schemaName }) => `  | "${schemaName}"`).join("\n");
const schemaRecords = schemaExports
  .map(({ schemaName, typeName, typeFile, title }) => {
    return `  { name: "${schemaName}", typeName: "${typeName}", title: ${JSON.stringify(title)}, typeFile: "${typeFile}" },`;
  })
  .join("\n");
const validatorExports = schemaExports
  .map(({ schemaName, typeName }) => {
    const functionName = `validate${typeName}`;
    return (
      `export function ${functionName}(value: unknown): value is ${typeName} {\n` +
      `  return validateSchema("${schemaName}", value);\n}`
    );
  })
  .join("\n\n");
await writeFile(
  path.join(generatedDirectory, "metadata.ts"),
  `// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.\n` +
    `export type SchemaName =\n${schemaNameUnion};\n\n` +
    `export const schemaMetadata = [\n${schemaRecords}\n] as const;\n`,
);
await writeFile(
  path.join(generatedDirectory, "validators.ts"),
  `// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.\n` +
    `import { validateSchema } from "#src/validator";\n` +
    `import type { ${schemaExports.map(({ typeName }) => typeName).join(", ")} } from "./types.ts";\n\n` +
    `${validatorExports}\n`,
);

function pascalCase(value) {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}
