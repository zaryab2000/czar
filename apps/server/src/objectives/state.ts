import { resolveReference } from "@czar/api-contract";

const statusSchema = resolveReference("#/components/schemas/ObjectiveStatusValue") as {
  enum: string[];
};
export const OBJECTIVE_STATES: readonly string[] = statusSchema.enum;

const TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  received: ["planning"],
  planning: ["no-supplier", "awaiting-approval", "opening"],
  "no-supplier": [],
  "awaiting-approval": ["opening", "expired", "dismissed"],
  opening: ["executing", "awaiting-approval"],
  executing: ["delivered", "replanning", "failed"],
  replanning: ["awaiting-approval", "executing"],
  delivered: [],
  failed: [],
  expired: [],
  dismissed: [],
};

export function canTransition(from: string, to: string): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
