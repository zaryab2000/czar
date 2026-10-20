# SCR-112: cancelJob signing category (K3 vs K3_NEVER)

| Field | Value |
|---|---|
| ID | SCR-112 |
| Filed by | Claude Opus 4.6, 2026-10-21 |
| Spec and section | docs/specs/03-smart-contracts/czar-vault.md §6 (K3 signing categories) |
| Status | Open |

## Problem
- The specs define `K3_ALLOWED` (functions the agent may sign autonomously) and `K3_NEVER` (functions the agent must never sign), but `cancelJob` is not listed in either category.
- `cancelJob(bytes32 jobId)` is present in the vault ABI but its signing rules are unspecified.
- Without an explicit categorisation, the signer cannot enforce a policy and the ABI-drift test cannot validate it.

## Evidence
- `apps/signer/src/abi.ts`: `cancelJob` was placed in `K3_NEVER` as a safe default during T-120 (commit `f8cd1fc`), since an agent autonomously cancelling a job could cause fund loss or user disruption.
- `docs/specs/03-smart-contracts/czar-vault.md` §6: lists `K3_ALLOWED` and `K3_NEVER` members but does not mention `cancelJob`.

## Proposed change
- Add `cancelJob` to the `K3_NEVER` list in `docs/specs/03-smart-contracts/czar-vault.md` §6, with the reason: "Job cancellation affects fund settlement and must require explicit user approval."
- Alternatively, if there are scenarios where autonomous cancellation is safe (e.g. the job has not been funded), define the conditions under which it moves to `K3_ALLOWED`.

## Affected tasks
- T-120 (Restore green CI — completed with `cancelJob` in `K3_NEVER` as interim safe default)

## Decision
- *(to be filled in by Zaryab)*
