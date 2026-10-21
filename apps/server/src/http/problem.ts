export type CzarCode =
  | "validation"
  | "device-revoked"
  | "idempotency-conflict"
  | "replay-not-stored"
  | "hash-mismatch"
  | "rate-limited"
  | "upstream-unavailable";

const TITLES: Record<CzarCode, string> = {
  validation: "Request could not be processed",
  "device-revoked": "Device has been revoked",
  "idempotency-conflict": "Idempotency key conflict",
  "replay-not-stored": "Response cannot be replayed",
  "hash-mismatch": "Objective hash does not match",
  "rate-limited": "Too many requests",
  "upstream-unavailable": "Service temporarily unavailable",
};

export function problem(
  status: number,
  czarCode: CzarCode,
  retryable = false,
  instance?: string,
): Record<string, unknown> {
  return {
    type: `https://czar.dev/problems/${czarCode}`,
    title: TITLES[czarCode],
    status,
    detail: TITLES[czarCode],
    ...(instance ? { instance } : {}),
    czarCode,
    retryable,
  };
}
