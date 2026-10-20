# SCR-004: Pocket funds can be stranded for good: the pocket key is destroyed at `PocketClosed`, the slow-withdraw fallback cannot reach the vault, and leftover gas is never swept.

| Field | Value |
|---|---|
| ID | SCR-004 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `docs/specs/05-build-plan/phase-1-tasks.md` T-037 (lines 533–536); `docs/specs/04-components/server/server-autonomy-roi-keys.md` CZ-27 (lines 366, 416, 421); `docs/specs/04-components/server/server-planning-and-payment.md` (lines 345, 351, 362); docs/specs/03-smart-contracts/czar-vault.md §5.4 (lines 141, 143, 146) |
| Status | Accepted with changes: applied in `czar-vault.md` §5.4 (recovery pullbacks for `Closed` pockets, sweep path), §6.2; CZ-27 §5.1–§5.3 (`pocket-return`, `pocket-slow-withdraw`, zero-balance retirement rule); CZ-15 §5.3; T-037 now matches CZ-27. Change: instead of an owner-only pullback for closed pockets, any agent or owner may request a *recovery* pullback (money can only return to the vault, credited to free balance), which lets the server sweep automatically. |
| Review finding | RV-004 (Critical) in `docs/specs/06-review/2026-10-19-spec-review.md` |

## Problem
- `writeOffPocket` always leaves `outstanding = 0`, so CZ-27's exception destroys the key at once; T-037 has no grace at all. Both are shorter than Gateway's ≈7-day withdrawal delay.
- T-037 forbids `initiateWithdrawal`/`withdraw`; CZ-27 allows them but no policy lets K4 send the withdrawn USDC on to the vault. Gateway's `withdraw` pays `msg.sender` (the pocket).
- Balances that come back after a write-off (a pending nanopayment that fails, an unminted attestation re-credited, A2-18, A2-29) and unused native gas (≈0.019 USDC per pocket) have no recovery path once the pocket is `Closed`.

## Evidence
- T-037: "Restrict signing to `addDelegate` transactions and `GatewayWalletBatched` authorizations." / "Destroy the key when `PocketClosed` is indexed." / test: "a pocket key cannot sign … any transfer to a non-Gateway address."
- CZ-27 line 421: "`kms.pocketKeyGraceHours` (48) keeps the key for that case before destruction, unless the pocket closed with `outstanding = 0`."
- CZ-15 line 362: "after `payer.pullbackApiDownHours` 24 the pocket key starts `initiateWithdrawal` (A2-13 to A2-15) and the owner later uses `recordManualReturn` (D41)".
- `writeOffPocket`: "`outstanding = 0; state = Closed`"; `requestPullback` requires "pocket `Funded` or `Draining`".
- Gateway `Withdrawals.sol` line 104: `withdraw(token)` pays `msg.sender`.
- No spec has a native-balance sweep for pockets (grep for "sweep", "native balance", "residual" finds only merchant sweeps).
- Two reviewers traced the same chain independently.
- Failure scenario:
  1. Circle's API is down for more than 24 h; CZ-15 starts the slow path.
  2. T-037's policy refuses `initiateWithdrawal`. Under CZ-27's policy it succeeds, but after 7 days the USDC sits in the pocket EOA and K4 may not transfer it to the vault.
  3. Meanwhile the envelope nears expiry and `writeOffPocket` runs. `PocketClosed` is indexed and K4 is destroyed.
  4. The pocket's Gateway balance (up to `pocketCapBps` of the envelope) and its gas are lost permanently.

## Proposed change
- Add a K4 kind: `USDC.transfer(owningVault, amount)` only, plus native sweep to the owning vault only.
- Destroy K4 only after the Gateway API balance and on-chain `availableBalance` both read 0 and any slow withdrawal has completed; base the grace on `withdrawalDelay` plus a margin, not 48 h.
- Forbid `writeOffPocket` while a slow withdrawal is open, and add an owner path to request a pullback for a `Closed` pocket, credited to free balance.
- Make T-037 match CZ-27 (one policy, one place).

## Affected tasks
- T-017, T-037, T-052, T-053 (M1, M2, M4)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted with changes: applied in `czar-vault.md` §5.4 (recovery pullbacks for `Closed` pockets, sweep path), §6.2; CZ-27 §5.1–§5.3 (`pocket-return`, `pocket-slow-withdraw`, zero-balance retirement rule); CZ-15 §5.3; T-037 now matches CZ-27. Change: instead of an owner-only pullback for closed pockets, any agent or owner may request a *recovery* pullback (money can only return to the vault, credited to free balance), which lets the server sweep automatically.
