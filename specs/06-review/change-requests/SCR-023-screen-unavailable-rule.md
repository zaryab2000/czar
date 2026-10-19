# SCR-023: The specs give opposite rules for what happens when the P-01 screen is unavailable.

| Field | Value |
|---|---|
| ID | SCR-023 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `specs/04-components/server-planning-and-payment.md` CZ-15 (line 398); `specs/04-components/server-acceptance-evidence-selection.md` CZ-16 (line 318); `specs/04-components/ai-prompts.md` (line 46) |
| Status | Open |
| Review finding | RV-023 (High) in `specs/06-review/2026-10-19-spec-review.md` |

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
- <filled in by Zaryab: accepted or rejected, and why>
