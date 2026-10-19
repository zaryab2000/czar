# SCR-009: `syncJob` refuses `Opened` jobs, so an unfunded job blocks its envelope from closing; and its refund test cannot be checked on-chain.

| Field | Value |
|---|---|
| ID | SCR-009 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | specs/03-smart-contracts/czar-vault.md §5.5 `syncJob` (line 162); §8.4 (line 356); `specs/03-smart-contracts/job-escrow-adapter.md` (line 71); `specs/04-components/server-planning-and-payment.md` (line 372) |
| Status | Accepted, applied in `czar-vault.md` §5.5 (`syncJob` from `Opened`, `Released` state, escrow status only, `budget − settledAmount`), §8.4; `job-escrow-adapter.md` §3, §6, §9; `IJobEscrowAdapter.sol` (`readOutcome`, `getJob`); T-018. Note: the Czar instance's `claimRefund` also moves `Open` jobs to `Expired`; handled. |
| Review finding | RV-009 (High) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- The function table and the state machine/adapter disagree on `Opened` jobs.
- "before" is never stored, and a contract cannot see events, so the refund condition cannot be built as written.
- On Czar's own instance, `approveClaim` can pay part of a budget; refund there is `budget − settledAmount` (base-contracts `ERC8183.sol` lines 840, 876), but the vault credits the full budget.

## Evidence
- `syncJob` preconditions: "job `Funded` or `Submitted`"; refund branch: "`Rejected` or `Expired` with refund observed (`balanceOf` ≥ before + budget, or `Refunded` event seen by the caller)".
- Adapter line 71: "Provider never calls `setBudget`: the job stays `Opened` until expiry; `syncJob` after `expiredAt` releases `reservedCap`".
- §8.4: "Opened --> Refunded: syncJob sees Rejected".
- Circle's instance allows `claimRefund` only from `Funded`/`Submitted` (ground truth E8), so an unfunded job stays `Open` forever.
- `IJobEscrowAdapter.sol` lines 143–156 lacks `getJob` for the Czar kind.
- Failure scenario:
  1. The provider never calls `setBudget`, or the server retries `openJob` after a crash (CZ-15 line 372 expects the duplicate to "expire harmlessly").
  2. `syncJob` reverts on the `Opened` job; `openJobs` stays above 0; `reserved` keeps `stepCap`.
  3. `closeEnvelope` reverts `EnvelopeBusy`; the money is locked until the owner force-closes, which then hits RV-005.

## Proposed change
- Allow `syncJob` on `Opened` jobs: when escrow status is `Rejected`, or `Open` with `now ≥ expiredAt`, release `reservedCap` and decrement `openJobs`.
- Decide refunds from escrow status only. For the Czar kind, read `settledAmount` and credit `budget − settledAmount`, booking `settledAmount` as spent.
- Add `getJob` to the Czar-kind adapter interface.

## Affected tasks
- T-018, T-054 (M1, M4)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted, applied in `czar-vault.md` §5.5 (`syncJob` from `Opened`, `Released` state, escrow status only, `budget − settledAmount`), §8.4; `job-escrow-adapter.md` §3, §6, §9; `IJobEscrowAdapter.sol` (`readOutcome`, `getJob`); T-018. Note: the Czar instance's `claimRefund` also moves `Open` jobs to `Expired`; handled.
