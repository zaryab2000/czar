import type { ValidateFunction } from "ajv";

export type ContractDocument = "public" | "local";

export interface OperationContract {
  document: ContractDocument;
  request?: ValidateFunction;
  responseStatuses: ReadonlySet<string>;
  responses: ReadonlyMap<string, ValidateFunction>;
}

export type ApiContracts = ReadonlyMap<string, OperationContract>;

export interface RecordedExchange {
  requestBody?: unknown;
  responseStatus: number;
  responseBody?: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors: readonly string[];
}
