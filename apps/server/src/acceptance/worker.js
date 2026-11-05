import Ajv2020 from "ajv/dist/2020.js";
import { shapeHash } from "@czar/hashing";
import { parentPort, workerData } from "node:worker_threads";
import { runInRestrictedContext } from "#src/acceptance/context";

function isJsonMimeType(mimeType) {
  const normalized = mimeType.toLowerCase().split(";", 1)[0].trim();
  return normalized === "application/json" || normalized.endsWith("+json");
}

function parseBody(bodyText, mimeType) {
  if (bodyText === null) return { parseOk: false, value: null };
  if (!isJsonMimeType(mimeType)) {
    return mimeType.toLowerCase().startsWith("text/")
      ? { parseOk: true, value: bodyText }
      : { parseOk: false, value: null };
  }
  try {
    return { parseOk: true, value: JSON.parse(bodyText) };
  } catch {
    return { parseOk: false, value: null };
  }
}

function validateOutputSchema(schema, parsed, schemaMaxBytes, mimeType, schemaOversized) {
  if (schemaOversized) return { state: "dropped", valid: false };
  if (schema === null) return { state: "absent", valid: false };
  const schemaText = JSON.stringify(schema);
  if (Buffer.byteLength(schemaText, "utf8") > schemaMaxBytes || !isJsonMimeType(mimeType))
    return { state: "dropped", valid: false };
  try {
    const ajv = new Ajv2020({ allErrors: false, strict: false });
    const validate = ajv.compile(schema);
    return { state: "valid", valid: Boolean(validate(parsed)) };
  } catch {
    return { state: "dropped", valid: false };
  }
}

try {
  const input = workerData.input;
  const parsed = parseBody(input.bodyText, input.mimeType);
  const schema = validateOutputSchema(
    workerData.outputSchema,
    parsed.value,
    workerData.limits.schemaMaxBytes,
    input.mimeType,
    workerData.schemaOversized,
  );
  let actualShapeHash = null;
  if (parsed.parseOk && isJsonMimeType(input.mimeType)) {
    actualShapeHash = shapeHash(input.bodyText);
  }
  const checks = runInRestrictedContext(workerData.executorSource, {
    ...input,
    parsed,
    schemaState: schema.state,
    schemaValid: schema.valid,
    shapeHash: actualShapeHash,
    deliveryLimitMs: Math.min(workerData.limits.deliveryTimeoutMs, input.maxTimeoutSeconds * 1000),
    maxBodyBytes: input.genericDelivery
      ? workerData.limits.genericMaxBytes
      : workerData.limits.maxBodyBytes,
  });
  parentPort.postMessage({ ok: true, checks }, []);
} catch {
  parentPort.postMessage({ ok: false }, []);
}
