# SCR-011: `freeBalance()` can underflow, and a normal withdraw before a pullback or refund is confirmed breaks INV-2 until envelopes close.

| Field | Value |
|---|---|
| ID | SCR-011 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | specs/03-smart-contracts/czar-vault.md §5.1 (lines 101, 104); INV-2 (line 419); `confirmPullback` (line 144); `syncJob` (line 162) |
| Status | Accepted with changes: applied in `czar-vault.md` §4 (`shortfall`), §5.1 (`freeBalance` saturates), §5.4/§5.5 credits, INV-2 restated. Change: the un-credited part is booked as an envelope `shortfall` (with `ShortfallRecorded`) rather than running confirmations inside `withdraw`, which cannot enumerate pending credits. |
| Review finding | RV-011 (High) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- Between a USDC transfer and the vault's `settle`, `balanceOf < committedTotal`; `freeBalance()` panics, so `withdraw` and `openEnvelope` revert.
- A pullback mint or job refund first shows up as free balance. If the owner withdraws it before `confirmPullback`/`syncJob`, the later `committedTotal += value` exceeds the balance.

## Evidence
- "free balance is live: `balanceOf − committedTotal`".
- INV-2: "`committedTotal ≤ USDC.balanceOf(vault)` … (except when USDC itself moved funds out … not yet observed; then `settle` restores it …)".
- Reviewer traced both sequences against the function table.
- Failure scenario:
  1. A pullback of 2 USDC mints to the vault; it appears in `freeBalance()`.
  2. The owner presses "Withdraw all" in the app and takes it.
  3. `confirmPullback` adds 2 to `committedTotal`. Now `committedTotal > balanceOf`.
  4. `freeBalance()` reverts for every caller; open envelopes promise money that is not there until they close.

## Proposed change
- Make `freeBalance()` saturate at 0.
- In `confirmPullback`, `syncJob` and `recordManualReturn`, credit only `min(value, balanceOf − committedTotal)` and record the rest as an envelope shortfall; or run pending confirmations inside `withdraw`.
- State the exact INV-2 exception and test it.

## Affected tasks
- T-013, T-017, T-018, T-021 (M1)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted with changes: applied in `czar-vault.md` §4 (`shortfall`), §5.1 (`freeBalance` saturates), §5.4/§5.5 credits, INV-2 restated. Change: the un-credited part is booked as an envelope `shortfall` (with `ShortfallRecorded`) rather than running confirmations inside `withdraw`, which cannot enumerate pending credits.
