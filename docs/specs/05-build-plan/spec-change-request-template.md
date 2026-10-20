# Spec change request template

- File each request as `docs/specs/05-build-plan/scr/SCR-<nnn>-<short-slug>.md` (kebab-case).
- Work on the affected item stops until the request is **Accepted** or **Rejected** by Zaryab.
- An accepted request is applied to the spec with a change-log line that cites the SCR ID.

```markdown
# SCR-<nnn>: <short title>

| Field | Value |
|---|---|
| ID | SCR-<nnn> |
| Filed by | <agent or person>, <date> |
| Spec and section | <exact path and section, for example docs/specs/03-smart-contracts/czar-vault.md §6.1> |
| Status | Open / Accepted / Rejected / Applied |

## Problem
- <what is wrong, missing or contradictory, in one to three bullets>

## Evidence
- <test output, command and result, fact ID, file and line, or quote from the spec>

## Proposed change
- <the exact text, field, route or function change>

## Affected tasks
- <T-xxx, T-yyy>

## Decision
- <filled in by Zaryab: accepted or rejected, and why>
```
