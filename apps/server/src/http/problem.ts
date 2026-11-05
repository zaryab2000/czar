export type CzarCode =
  | "validation"
  | "device-revoked"
  | "idempotency-conflict"
  | "replay-not-stored"
  | "hash-mismatch"
  | "plan-expired"
  | "frozen"
  | "paused"
  | "insufficient-free-balance"
  | "session-expired"
  | "rate-limited"
  | "upstream-unavailable"
  | "unknown-objective"
  | "controlled-user"
  | "not-producing"
  | "nothing-settled"
  | "not-your-payment"
  | "window-closed"
  | "supersedes-required"
  | "bad-supersedes"
  | "no-vault";

const TITLES: Record<CzarCode, string> = {
  validation: "Request could not be processed",
  "device-revoked": "Device has been revoked",
  "idempotency-conflict": "Idempotency key conflict",
  "replay-not-stored": "Response cannot be replayed",
  "hash-mismatch": "Objective hash does not match",
  "plan-expired": "This plan expired",
  frozen: "The vault is frozen",
  paused: "Czar paused spending for safety",
  "insufficient-free-balance": "Not enough available money for this plan",
  "session-expired": "The app session expired",
  "rate-limited": "Too many requests",
  "upstream-unavailable": "Service temporarily unavailable",
  "unknown-objective": "Delivered objective was not found",
  "controlled-user": "Controlled users cannot rate suppliers",
  "not-producing": "This step did not produce the result",
  "nothing-settled": "This step has no settled payment",
  "not-your-payment": "This payment does not belong to your vault",
  "window-closed": "The rating window is closed",
  "supersedes-required": "Name the rating to correct",
  "bad-supersedes": "This rating cannot be corrected",
  "no-vault": "Create your wallet first",
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
