// BR-06 (SCR-181 §6): one plain sentence for each reason a plan needs the owner's approval, from fields
// already in the plan. No plan field is added; the merchant is named by its payee host, the only name the
// plan carries.
import type { AppPlan } from "@czar/schemas";

export type ApprovalReason = NonNullable<AppPlan["approvalReasons"]>[number];

export function approvalReasonSentence(
  reason: ApprovalReason,
  context: { readonly payee?: string | undefined },
): string {
  switch (reason) {
    case "unrated":
      return "Czar picked a merchant with no ratings yet, so it needs your approval.";
    case "health-fact":
      return "This merchant had a recent problem with one of your tasks, so Czar asks before using it again.";
    case "exploration-slot":
      return "Czar is trying a merchant it has not checked yet, to learn whether it is good.";
    case "incident-open":
      // SCR-165 §1 binds this copy word for word.
      return "This supplier has an open incident: several owners recently reported bad outcomes with it. Czar still ranks it as the best available. Approve to use it anyway.";
    case "contract-sent":
      return `Your contract will be sent to ${context.payee ?? "the merchant you approve"}.`;
  }
}
