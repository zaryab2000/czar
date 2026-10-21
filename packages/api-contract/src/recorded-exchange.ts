import { apiContracts } from "#src/index";
import type { ApiContracts, RecordedExchange, ValidationResult } from "#src/types";

function errorsFor(
  validate: ((data: unknown) => boolean) | undefined,
  body: unknown,
  label: string,
): string[] {
  if (!validate) return [];
  if (validate(body)) return [];
  return (
    (validate as { errors?: Array<{ message?: string; instancePath?: string }> }).errors?.map(
      (error) => `${label}${error.instancePath ?? ""}: ${error.message ?? "invalid"}`,
    ) ?? [`${label}: invalid`]
  );
}

export function validateRecordedExchange(
  operationId: string,
  exchange: RecordedExchange,
  contracts: ApiContracts = apiContracts,
): ValidationResult {
  const contract = contracts.get(operationId);
  if (!contract) throw new Error(`Unknown OpenAPI operationId: ${operationId}`);
  const responseValidator =
    contract.responses.get(String(exchange.responseStatus)) ??
    contract.responses.get(`${Math.floor(exchange.responseStatus / 100)}XX`) ??
    contract.responses.get("default");
  const responseKey = contract.responseStatuses.has(String(exchange.responseStatus))
    ? String(exchange.responseStatus)
    : `${Math.floor(exchange.responseStatus / 100)}XX`;
  const responseDeclared =
    contract.responseStatuses.has(responseKey) || contract.responseStatuses.has("default");
  if (!responseDeclared) {
    return { valid: false, errors: [`response: undeclared status ${exchange.responseStatus}`] };
  }
  const errors = [
    ...errorsFor(contract.request, exchange.requestBody, "request"),
    ...errorsFor(responseValidator, exchange.responseBody, "response"),
  ];
  if (!responseValidator && exchange.responseBody !== undefined) {
    errors.push(`response: status ${exchange.responseStatus} has no body schema`);
  }
  return { valid: errors.length === 0, errors };
}
