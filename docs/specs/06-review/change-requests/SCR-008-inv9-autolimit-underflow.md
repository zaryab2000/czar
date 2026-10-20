# SCR-008: Lowering `autoLimit` below `usedInPeriod` (which D60/D63 do on every freeze) breaks INV-9 and makes `openEnvelope` revert with an arithmetic panic.

| Field | Value |
|---|---|
| ID | SCR-008 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | docs/specs/03-smart-contracts/czar-vault.md INV-9 (line 426); `lowerAutoLimit` (line 173); `openEnvelope` (line 118); `setCategoryLimits` (line 105); `raiseAutoLimit` (line 172) |
| Status | Accepted, applied in `czar-vault.md` §5.2 (saturating allowance), §5.6 (`lowerAutoLimit` allows equal; `RaiseNotAbove`), INV-9 restated as `autoLimit ≤ userMax`; `ICzarVault.sol`; T-014, T-019. |
| Review finding | RV-008 (High) in `docs/specs/06-review/2026-10-19-spec-review.md` |

## Problem
- Nothing ties `newLimit` to `usedInPeriod`, so INV-9's second half is false after any lowering mid-period.
- `autoLimit − usedInPeriod` then underflows (Solidity 0.8 panic 0x11) instead of the specified `AllowanceExceeded(categoryId, remaining, cap)`.
- `lowerAutoLimit(c, 0)` reverts when the limit is already 0 (strict `<`), so the D60 loop must special-case it.
- `raiseAutoLimit` with `newLimit < autoLimit` underflows on the step check.

## Evidence
- INV-9: "`autoLimit[c] ≤ userMax[c]` and `usedInPeriod[c] ≤ autoLimit[c]` for every category."
- `lowerAutoLimit`: "`newLimit < autoLimit`" → "`autoLimit = newLimit`".
- `openEnvelope` (agent): "`cap ≤ autoLimit − usedInPeriod`".
- D60: "Freeze lowers every category's `autoLimit` to 0 on-chain"; D63 does it in follow-up calls.
- Failure scenario:
  1. The agent has opened 8 of a 10 allowance this week (`usedInPeriod = 8`).
  2. The user freezes; the follow-up step lowers `autoLimit` to 0.
  3. T-021's invariant suite fails on correct code (INV-9).
  4. After unfreeze, the agent's next `openEnvelope` panics instead of `AllowanceExceeded`; T-014's error test fails.

## Proposed change
- Restate INV-9 as `autoLimit ≤ userMax`.
- Compute remaining allowance with saturation: `autoLimit > used ? autoLimit − used : 0`.
- Allow `newLimit ≤ autoLimit` in `lowerAutoLimit` (no-op on equal), and require `newLimit > autoLimit` with a named error in `raiseAutoLimit`.

## Affected tasks
- T-014, T-019, T-021 (M1)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted, applied in `czar-vault.md` §5.2 (saturating allowance), §5.6 (`lowerAutoLimit` allows equal; `RaiseNotAbove`), INV-9 restated as `autoLimit ≤ userMax`; `ICzarVault.sol`; T-014, T-019.
