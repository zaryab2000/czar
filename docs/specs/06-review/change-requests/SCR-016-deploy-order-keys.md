# SCR-016: The deployment order is circular: T-027 (M1) needs K3, K5 and K7 addresses that T-036 (M2) creates, and no task creates K6 or K20.

| Field | Value |
|---|---|
| ID | SCR-016 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `docs/specs/05-build-plan/phase-1-tasks.md` T-027 (lines 418–431), T-036 (lines 514, 519); `docs/specs/03-smart-contracts/security-and-testing.md` deployment step 2 (line 94) |
| Status | Accepted, applied in `phase-1-tasks.md` (new T-105 before T-027; T-027 and T-035 depend on it; T-036 uses its keys), `security-and-testing.md` §4 step 2, CZ-27 §5.1. |
| Review finding | RV-016 (High) in `docs/specs/06-review/2026-10-19-spec-review.md` |

## Problem
- T-027 cannot run before T-036, and T-036 depends on T-027.
- No task creates the guardian (K6) or admin (K20) keys.

## Evidence
- Deployment step 2: "initial `defaults` (agent, autonomy, evaluator addresses from KMS), guardian, admin".
- T-036: "Deps: T-035, T-027" and "Create the testnet KMS keys".
- Milestone order in `build-plan.md` §5: M1 (T-010–T-027) before M2 (T-030–T-037).
- Failure scenario:
  1. The M1 exit gate requires a testnet deployment (T-027); the agent has no K3/K5/K7/K6/K20 addresses and stops, or invents placeholder addresses that later need `setDefaults` (untimelocked, RV-015).

## Proposed change
- Add a key-creation task in M1 (local-keystore, D70) before T-027 that creates K3, K5, K6, K7, K20 and records their addresses.
- Or deploy with placeholder defaults and set them through the timelocked path, and say so.

## Affected tasks
- T-027, T-035, T-036 (M1, M2)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted, applied in `phase-1-tasks.md` (new T-105 before T-027; T-027 and T-035 depend on it; T-036 uses its keys), `security-and-testing.md` §4 step 2, CZ-27 §5.1.
