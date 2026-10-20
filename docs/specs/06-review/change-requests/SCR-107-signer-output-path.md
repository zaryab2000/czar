# SCR-107: T-035 names a signer path and test command that conflict with the package layout

| Field | Value |
|---|---|
| ID | SCR-107 |
| Filed by | Czar builder (tier 2), 2026-10-19 |
| Spec and section | `docs/specs/05-build-plan/phase-1-tasks.md` T-035 (Outputs, Acceptance tests), T-036 (Inputs); `docs/specs/05-build-plan/build-plan.md` §2.1 |
| Status | Open |

## Problem
- T-035 puts the signer at `apps/server/src/signer/` and tests it with `pnpm --filter @czar/server test signer`.
- build-plan §2.1 and T-105 put it in its own package, `apps/signer` (`@czar/signer`). CZ-27 §3 also requires a separate process that alone opens the keystore.
- T-036 inherits the `apps/server/src/signer/` input path.

## Evidence
- T-105 Steps: "a minimal one-off script in `apps/signer/scripts/create-keys.ts` … T-035 later adopts the keystore unchanged."
- CZ-27 §3: "`signer` is a local process on Zaryab's Mac, the only process that opens the keystore."

## Proposed change
- T-035 Outputs: `apps/signer/` (`@czar/signer`).
- T-035 acceptance: `pnpm --filter @czar/signer test`.
- T-036 Inputs: `apps/signer/` from T-035.

## Affected tasks
- T-035, T-036

## Decision
- 
