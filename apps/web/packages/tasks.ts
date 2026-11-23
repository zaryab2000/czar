// Browser tasks (SCR-181 §2, §6): the New task form's checks, which mirror the server's limits so a mistake
// shows a plain message before anything is sent, and the plain labels for each objective state. The server
// still checks everything again.
import { PARAMETERS } from "@czar/config/registry";
import type { AppObjective, AppObjectiveRequest } from "@czar/schemas";

function registryInteger(key: string): number {
  const value = PARAMETERS.find((spec) => spec.key === key)?.default;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    throw new Error(`Invalid task configuration: ${key}`);
  return value;
}

/** `app.objectiveMaxSourceChars`: the longest source the server accepts. */
export const TASK_SOURCE_MAX_CHARS = registryInteger("app.objectiveMaxSourceChars");
/** `app.objectivePollSeconds`, in milliseconds. */
export const TASK_POLL_MS = registryInteger("app.objectivePollSeconds") * 1000;
/** SCR-181 §4: shown above the submit button. */
export const TASK_PRIVACY_NOTICE =
  "What you paste is sent to Czar and to the merchant you approve. Do not paste secrets or private keys.";

/** The request schema's limits (`app-objective-request.schema.json`). */
const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 1000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** USDC has 6 decimals. */
const USDC_DECIMALS = 6;
const USD_AMOUNT = new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${USDC_DECIMALS}})?$`);

export interface TaskForm {
  readonly title: string;
  readonly description: string;
  /** Paste the source, or give a verified contract's address. */
  readonly mode: "source" | "address";
  readonly source: string;
  readonly address: string;
  /** Optional, in USDC, for example "1.50". */
  readonly maxBudget: string;
}

export type TaskRequestResult =
  | { readonly ok: true; readonly request: AppObjectiveRequest }
  | { readonly ok: false; readonly error: string };

const formatCount = (count: number) => count.toLocaleString("en-US");

/** USDC text → atomic units (6 decimals); empty means no budget. */
export function parseUsdBudget(
  text: string,
): { readonly ok: true; readonly atomic: string | undefined } | { readonly ok: false } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, atomic: undefined };
  const match = USD_AMOUNT.exec(trimmed);
  if (!match) return { ok: false };
  const whole = BigInt(match[1] ?? "0");
  const fraction = (match[2] ?? ".").slice(1).padEnd(USDC_DECIMALS, "0");
  const atomic = whole * 10n ** BigInt(USDC_DECIMALS) + BigInt(fraction === "" ? "0" : fraction);
  return atomic > 0n ? { ok: true, atomic: atomic.toString() } : { ok: false };
}

export function buildTaskRequest(form: TaskForm): TaskRequestResult {
  const title = form.title.trim();
  if (title === "") return { ok: false, error: "Give the task a short title." };
  if (title.length > MAX_TITLE_CHARS)
    return { ok: false, error: `Keep the title under ${MAX_TITLE_CHARS} characters.` };
  if (form.description.length > MAX_DESCRIPTION_CHARS)
    return {
      ok: false,
      error: `Keep the description under ${formatCount(MAX_DESCRIPTION_CHARS)} characters.`,
    };
  const budget = parseUsdBudget(form.maxBudget);
  if (!budget.ok) return { ok: false, error: "Enter the budget in USDC, for example 1.50." };
  const base = {
    kind: "smart-contract-audit" as const,
    title,
    description: form.description,
    ...(budget.atomic === undefined ? {} : { maxTotal: budget.atomic }),
  };
  if (form.mode === "address") {
    const address = form.address.trim();
    if (!ADDRESS.test(address))
      return { ok: false, error: "Enter a 0x contract address (40 hex characters)." };
    return { ok: true, request: { ...base, contractAddress: address } };
  }
  if (form.source.trim() === "") return { ok: false, error: "Paste the contract source." };
  if (form.source.length > TASK_SOURCE_MAX_CHARS)
    return {
      ok: false,
      error: `The source is over ${formatCount(TASK_SOURCE_MAX_CHARS)} characters. Use the contract address instead.`,
    };
  return { ok: true, request: { ...base, contractSource: form.source } };
}

/** States the server never leaves (apps/server/src/objectives/state.ts), so the progress view stops polling. */
const FINISHED_STATES: ReadonlySet<AppObjective["state"]> = new Set([
  "delivered",
  "failed",
  "expired",
  "dismissed",
  "no-supplier",
]);

export const isTaskFinished = (state: AppObjective["state"]): boolean => FINISHED_STATES.has(state);

/** SCR-181 §6: the progress view's plain label for each state. */
export function taskStateLabel(state: AppObjective["state"]): string {
  switch (state) {
    case "received":
    case "planning":
    case "replanning":
      return "Finding the best merchant…";
    case "no-supplier":
      return "No merchant found yet";
    case "awaiting-approval":
      return "Waiting for your approval";
    case "opening":
    case "executing":
      return "Paying and running…";
    case "delivered":
      return "Delivered";
    case "failed":
      return "Something went wrong";
    case "expired":
    case "dismissed":
      return "Closed";
  }
}
