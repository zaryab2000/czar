# SCR-014: Re-committing a `PROBE_INTENT` root resets its status to 1, allowing a second reveal that swaps the probe batch after results are known.

| Field | Value |
|---|---|
| ID | SCR-014 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `specs/03-smart-contracts/open-evidence-log.md` rules (line 61); OEL-2 (line 156) |
| Status | Open |
| Review finding | RV-014 (High) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- The set is unconditional. A publisher can commit R, reveal B1, commit R again (with `prev = R`), and reveal B2.

## Evidence
- "`commit` with `kind == PROBE_INTENT` sets `_intent[publisher][root] = 1`. `reveal` reverts unless `_intent == 1`, then sets 2 and stores the batch root."
- OEL-2: "status never decreases".
- The `prev` check passes because the latest root is R. The contract is ownerless and immutable.
- Failure scenario:
  1. A prober commits intent R, runs probes, and sees that results hurt a favoured merchant.
  2. It re-commits R (status back to 1) and reveals a different batch B2 that overwrites `_batchOf`.
  3. Pre-commitment, the core of fair probing in the Selection Layer, is defeated.

## Proposed change
- Set status to 1 only when it is 0; otherwise revert `AlreadyCommitted`.
- Add an OEL invariant test for re-commit after reveal.

## Affected tasks
- T-011, T-021 (M1)

## Decision
- <filled in by Zaryab: accepted or rejected, and why>
