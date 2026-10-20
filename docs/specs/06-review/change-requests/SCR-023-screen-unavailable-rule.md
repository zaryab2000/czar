# SCR-023: The specs give opposite rules for what happens when the P-01 screen is unavailable.

| Field | Value |
|---|---|
| ID | SCR-023 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `docs/specs/04-components/server-planning-and-payment.md` CZ-15 (line 398); `docs/specs/04-components/server-acceptance-evidence-selection.md` CZ-16 (line 318); `docs/specs/04-components/ai-prompts.md` (line 46) |
| Status | Accepted (D76), applied in `ai-prompts.md` P-01 fallback, CZ-15 §5.6 and §7, CZ-16 §5.3, §6, §7; T-046, T-047. |
| Review finding | RV-023 (High) in `docs/specs/06-review/2026-10-19-spec-review.md` |

## Problem
- T-046, T-047 and T-048 can implement opposite behaviours. One of them writes unscreened merchant text into `.czar/results`, which Claude Code reads.

## Evidence
- CZ-15: "a step whose body cannot be screened is quarantined, not delivered."
- CZ-16: "P-01 unavailable … otherwise checks run … the result is still delivered with the warning label".
- `ai-prompts.md` line 46 says the regex result stands, a third variant.
- Failure scenario:
  1. The model provider is down, or the monthly cap is hit.
  2. Unscreened merchant output with an injection is delivered into the user's workspace.

## Proposed change
- Pick one rule (recommended: quarantine, or deliver with no field values) and state it in CZ-15, CZ-16 and `ai-prompts.md`.

## Affected tasks
- T-046, T-047, T-048 (M3)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted (D76), applied in `ai-prompts.md` P-01 fallback, CZ-15 §5.6 and §7, CZ-16 §5.3, §6, §7; T-046, T-047.
