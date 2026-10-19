# SCR-010: `recordManualReturn` cannot be built: it relies on a stored "last sync" balance that does not exist, and its caller is stated two ways.

| Field | Value |
|---|---|
| ID | SCR-010 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | specs/03-smart-contracts/czar-vault.md §5.4 prose (line 152); `sync()` (line 102); §4 storage; `ICzarVault.sol` (lines 260–261) |
| Status | Open |
| Review finding | RV-010 (High) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- No storage holds a last-synced balance, so the bound is undefined.
- "the agent uses" and "owner-only" contradict each other (D41 says owner-only).
- There is no table row, no errors, and no rule for a `Closed` pocket or closed envelope.

## Evidence
- Line 152: "the agent uses `recordManualReturn(pocket, amount)`: owner-only, credits `outstanding` down and `committedTotal` up by `min(amount, balanceOf delta since the last sync)`".
- `sync()`: "none (free balance is live: `balanceOf − committedTotal`)".
- D41: "Owner-only manual credit for pocket funds returned through the 7-day withdrawal".
- Failure scenario:
  1. The T-017 builder has no snapshot to compare against and either invents storage or drops the bound.
  2. Without the bound the owner can raise `committedTotal` above the balance, breaking INV-2 and making `freeBalance()` revert.

## Proposed change
- Bound the credit by `min(amount, outstanding, freeBalance())` and drop the "delta since last sync" wording, or add a `lastSyncedBalance` written by `sync()`.
- Add a §5.4 table row with preconditions (pocket state, envelope state), errors and event; make the caller owner-only everywhere.

## Affected tasks
- T-017, T-053 (M1, M4)

## Decision
- <filled in by Zaryab: accepted or rejected, and why>
