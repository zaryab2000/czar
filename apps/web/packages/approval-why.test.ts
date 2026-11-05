// BR-06 / SCR-181 §6: the approval page explains each approval reason in one plain sentence, using only
// fields already in the plan.
import { describe, expect, it } from "vitest";
import { approvalReasonSentence } from "#src/approval-why";

describe("approvalReasonSentence", () => {
  it.each([
    ["unrated", "Czar picked a merchant with no ratings yet, so it needs your approval."],
    [
      "health-fact",
      "This merchant had a recent problem with one of your tasks, so Czar asks before using it again.",
    ],
    [
      "exploration-slot",
      "Czar is trying a merchant it has not checked yet, to learn whether it is good.",
    ],
    [
      "incident-open",
      // SCR-165 §1 binds this copy word for word.
      "This supplier has an open incident: several owners recently reported bad outcomes with it. Czar still ranks it as the best available. Approve to use it anyway.",
    ],
    ["contract-sent", "Your contract will be sent to merchants.example.test."],
  ] as const)("explains %s", (reason, sentence) => {
    expect(approvalReasonSentence(reason, { payee: "merchants.example.test" })).toBe(sentence);
  });

  it("names no payee when the plan has none", () => {
    expect(approvalReasonSentence("contract-sent", {})).toBe(
      "Your contract will be sent to the merchant you approve.",
    );
  });
});
