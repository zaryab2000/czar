import { compileContracts } from "#/openapi";

export { compileContracts, contractDocuments, resolveReference } from "#/openapi";
export { validateRecordedExchange } from "#/recorded-exchange";
export type {
  ApiContracts,
  ContractDocument,
  OperationContract,
  RecordedExchange,
  ValidationResult,
} from "#/types";

export const apiContracts = compileContracts();
