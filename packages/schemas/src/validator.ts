import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema, ErrorObject, Plugin, ValidateFunction } from "ajv";
import * as formats from "ajv-formats";
import { allSchemas, schemas } from "#src/schema-source";
import type { SchemaName, SchemaTypes } from "#src/generated/types";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const addFormats = formats.default as unknown as Plugin<undefined>;
addFormats(ajv);
ajv.addKeyword({ keyword: "x-privacyClass", schemaType: "string", valid: true });
ajv.addKeyword({ keyword: "x-phase", valid: true });

for (const schema of allSchemas.values()) ajv.addSchema(schema);

const validators = new Map<SchemaName, ValidateFunction>();
for (const [name, schema] of schemas) {
  const schemaId = (schema as { $id?: string }).$id;
  const validate = schemaId ? ajv.getSchema(schemaId) : undefined;
  if (!validate) throw new Error(`Could not compile JSON Schema "${name}".`);
  validators.set(name, validate);
}

export function validateSchema<Name extends SchemaName>(
  name: Name,
  value: unknown,
): value is SchemaTypes[Name] {
  const validate = validators.get(name);
  if (!validate) throw new Error(`Unknown JSON Schema "${name}".`);
  return validate(value) === true;
}

export function validationErrors(name: SchemaName): readonly ErrorObject[] {
  const validate = validators.get(name);
  if (!validate) throw new Error(`Unknown JSON Schema "${name}".`);
  return validate.errors ?? [];
}

export function getSchema(name: SchemaName): AnySchema {
  const schema = schemas.get(name);
  if (!schema) throw new Error(`Unknown JSON Schema "${name}".`);
  return schema;
}

export function getCompiledValidator(name: SchemaName): ValidateFunction {
  const validate = validators.get(name);
  if (!validate) throw new Error(`Unknown JSON Schema "${name}".`);
  return validate;
}
