# SCR-001: A reservation whose every index is settled can never become `Final`, so its envelope can never close.

| Field | Value |
|---|---|
| ID | SCR-001 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | specs/03-smart-contracts/czar-vault.md §5.3 (`settle`, `finalize`, lines 131–132); §8.2 (line 320); §5.2 `closeEnvelope` (line 119) |
| Status | Accepted, applied in `specs/03-smart-contracts/czar-vault.md` §5.3 (`_finalizeIfDone`), §8.2, INV-13; `ICzarVault.sol`; tests in `security-and-testing.md` §3.7; T-015. |
| Review finding | RV-001 (Critical) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- Only `finalize` moves a reservation to `Final`. But `finalize` refuses any index already in `doneMask`.
- When `settle` has already marked every index done, there is no index left for `finalize` to process. Whether an empty range is allowed is not stated.
- This is the normal happy path (every authorization used).

## Evidence
- `settle` state changes: "for each: `settledMask |= bit; doneMask |= bit; settledCount++`; `envelope.reserved −= unitAmount; envelope.spent += unitAmount; committedTotal −= unitAmount`" (no move to `Final`, no `openReservations−−`).
- `finalize` preconditions: "`now > validBefore` …; `toIndex − fromIndex ≤ FINALIZE_CHUNK`; indices in `[fromIndex, toIndex)` not in `doneMask`"; state changes: "when `doneMask` covers all `count` bits: `state = Final; openReservations−−`".
- `closeEnvelope` preconditions: "`openReservations == 0` … (else `EnvelopeBusy`)".
- §8.2 diagram: "Active --> Active: settle(indices)"; only `finalize` reaches `Final`.
- `forceCloseEnvelope` (line 120) also requires "no open reservations (finalize first)".
- `security-and-testing.md` §3.2 (line 60) expects "`reserved` returns to 0 after all reservations are final".
- Failure scenario:
  1. The agent reserves `count = 10` for a step.
  2. The merchant uses all 10 authorizations; anyone calls `settle` for indices 0–9. `doneMask` is full; state stays `Active`.
  3. After `validBefore`, every non-empty `finalize` range hits a done index and reverts; an empty range is likely rejected as bad params.
  4. `openReservations` never drops. `closeEnvelope` and `forceCloseEnvelope` revert forever.
  5. The envelope's unspent `cap − spent` stays in `committedTotal`. The owner can never withdraw it. Vaults are immutable (D33), so this cannot be patched later.

## Proposed change
- Add one shared step to both `settle` and `finalize`: if `popcount(doneMask) == count` then `state = Final; openReservations−−; emit ReservationFinal`.
- Let `finalize` skip indices already in `doneMask` instead of reverting.
- Add a unit test and an invariant: "all indices settled before expiry → reservation `Final` → envelope closes and releases the rest".

## Affected tasks
- T-015, T-021, T-048, T-050 (M1, M3)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted, applied in `specs/03-smart-contracts/czar-vault.md` §5.3 (`_finalizeIfDone`), §8.2, INV-13; `ICzarVault.sol`; tests in `security-and-testing.md` §3.7; T-015.
