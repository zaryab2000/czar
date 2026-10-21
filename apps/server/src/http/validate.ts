import { resolveReference } from "@czar/api-contract";

interface SchemaParameter {
  schema?: {
    default?: number;
    enum?: string[];
    format?: string;
    maximum?: number;
    maxLength?: number;
    minimum?: number;
    pattern?: string;
  };
}

const limitParameter = resolveReference("#/components/parameters/Limit") as SchemaParameter;
const cursorParameter = resolveReference("#/components/parameters/Cursor") as SchemaParameter;
const statusSchema = resolveReference("#/components/schemas/ObjectiveStatusValue") as {
  enum: string[];
};
const objectivePathParameter = resolveReference(
  "#/paths/~1v1~1objectives~1{objectiveId}/get/parameters/0",
) as SchemaParameter;

export const PAGE_LIMIT_MIN = limitParameter.schema?.minimum ?? 1;
export const PAGE_LIMIT_MAX = limitParameter.schema?.maximum ?? 200;
export const PAGE_LIMIT_DEFAULT = limitParameter.schema?.default ?? 50;
export const CURSOR_MAX_LENGTH = cursorParameter.schema?.maxLength ?? 512;
export const OBJECTIVE_STATUS_VALUES = statusSchema.enum;
export const OBJECTIVE_ID_PATTERN = objectivePathParameter.schema?.pattern ?? "";
export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RequestValidationError extends Error {
  constructor(message = "Request does not match the API contract.") {
    super(message);
    this.name = "RequestValidationError";
  }
}

export interface ObjectiveListParams {
  status?: string;
  cursor?: string;
  limit: number;
}

export function parseIdempotencyKey(value: string | undefined): string {
  if (!value || !UUID_V4_PATTERN.test(value)) throw new RequestValidationError();
  return value;
}

export function parseObjectiveId(value: string): string {
  if (!OBJECTIVE_ID_PATTERN || !new RegExp(OBJECTIVE_ID_PATTERN).test(value)) {
    throw new RequestValidationError();
  }
  return value;
}

export function parseObjectiveListParams(url: URL): ObjectiveListParams {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? PAGE_LIMIT_DEFAULT : Number(rawLimit);
  const rawStatus = url.searchParams.get("status") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (!Number.isSafeInteger(limit) || limit < PAGE_LIMIT_MIN || limit > PAGE_LIMIT_MAX) {
    throw new RequestValidationError();
  }
  if (rawStatus !== undefined && !OBJECTIVE_STATUS_VALUES.includes(rawStatus)) {
    throw new RequestValidationError();
  }
  if (cursor !== undefined && cursor.length > CURSOR_MAX_LENGTH) {
    throw new RequestValidationError();
  }
  return {
    ...(rawStatus === undefined ? {} : { status: rawStatus }),
    ...(cursor === undefined ? {} : { cursor }),
    limit,
  };
}
