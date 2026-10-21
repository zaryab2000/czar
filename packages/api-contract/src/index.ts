import { compileContracts } from "#src/openapi";

export { compileContracts, contractDocuments, resolveReference } from "#src/openapi";
export { validateRecordedExchange } from "#src/recorded-exchange";
export type {
  ApiContracts,
  ContractDocument,
  OperationContract,
  RecordedExchange,
  ValidationResult,
} from "#src/types";

export const apiContracts = compileContracts();
