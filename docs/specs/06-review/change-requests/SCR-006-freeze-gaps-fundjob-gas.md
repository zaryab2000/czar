# SCR-006: `fundJob` and `grantPocketGas` have no freeze or pause check in the function table.

| Field | Value |
|---|---|
| ID | SCR-006 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | docs/specs/03-smart-contracts/czar-vault.md §5.5 `fundJob` (line 161); §5.4 `grantPocketGas` (line 141); §8.1 (line 312); INV-4 (line 421) |
| Status | Accepted, applied in `czar-vault.md` §5.2 note, §5.4 `grantPocketGas` (gated, `nonReentrant`), §5.5 `fundJob`, §8.1, INV-4; T-017, T-018. |
| Review finding | RV-006 (High) in `docs/specs/06-review/2026-10-19-spec-review.md` |

## Problem
- The function table is what T-018 and T-017 build from. Neither row has `notPausedOrFrozen`, an envelope-`Open` check, or an expiry check.
- `grantPocketGas` is missing from the freeze list and from INV-4 entirely, although it sends native USDC out of the vault.

## Evidence
- `fundJob` preconditions: "job `Opened`; adapter reads budget `b` and status `Open`; `0 < b ≤ reservedCap`; fee check …; `paymentToken == USDC`".
- `grantPocketGas` preconditions: "pocket `Registered`; `gasGranted + units ≤ MAX_GAS_GRANT_PER_POCKET`; …".
- §8.1 line 312: "Freeze: … `reserve`, `fundPocket`, `openJob`, `fundJob`, `openEnvelope` revert".
- INV-4: "… `reserve`, `fundPocket`, `openJob`, `fundJob`, `openEnvelope` revert."
- Failure scenario:
  1. A user sees abuse and freezes, or the guardian pauses.
  2. K3 still calls `fundJob` on an already opened job; the budget moves into escrow; K7 (same server) calls `complete`; the provider is paid.
  3. K3 also keeps calling `grantPocketGas` (up to 0.05 USDC per registered pocket).

## Proposed change
- Add `notPausedOrFrozen`, envelope `Open` and `now < expiresAt` to both rows.
- Add `grantPocketGas` to §8.1 and INV-4, and to the freeze tests in T-016/T-021.
- Add a nonReentrant guard to `grantPocketGas` (native call to an EOA that may carry EIP-7702 code, §12).

## Affected tasks
- T-017, T-018, T-021 (M1)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted, applied in `czar-vault.md` §5.2 note, §5.4 `grantPocketGas` (gated, `nonReentrant`), §5.5 `fundJob`, §8.1, INV-4; T-017, T-018.
