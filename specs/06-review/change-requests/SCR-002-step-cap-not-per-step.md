# SCR-002: `stepCap` is checked per reservation or per job, not per step, so a hijacked agent key can spend a whole envelope on one step's payees.

| Field | Value |
|---|---|
| ID | SCR-002 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | specs/03-smart-contracts/czar-vault.md §5.3 `reserve` (line 128); §5.5 `openJob` (line 160); §4 storage; `security-and-testing.md` line 10 |
| Status | Accepted, applied in `czar-vault.md` §4 (`stepUsed`), §5.3, §5.5, §6.5 step 7, INV-12; `ICzarVault.sol` (`StepUsed`, `StepCapExceeded(...)`, `stepUsed()`); T-015, T-018. |
| Review finding | RV-002 (Critical) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- No storage tracks how much has been reserved or spent per `(envelopeId, stepIndex)`.
- The agent can call `reserve` (or `openJob`) again and again for the same step leaf, and once each for the payee and its two alternates (D36). Each call passes `total ≤ stepCap` on its own.
- `reserve` never checks `stepCap ≤ maxStepAmount`; it only checks `unitAmount ≤ maxStepAmount`.

## Evidence
- `reserve`: "`total = unitAmount × count`; `total ≤ stepCap`; … `spent + reserved + pocketOutstanding + jobEscrowed + total ≤ cap`" and state change "`reserved += total`; `openReservations++`".
- `openJob`: "`stepCap ≤ maxStepAmount`; … cap room for `stepCap`" and "`reserved += stepCap`".
- `security-and-testing.md` line 10: "`unitAmount × count ≤ stepCap ≤ maxStepAmount`, cap check (INV-1, INV-5)".
- Spec 01 README line 17: "A hijacked server key can only spend inside approved envelopes, to pre-approved payees, under per-step caps."
- Spec 02 line 260: `stepCap` is "the per-step cap shared by the payee and its alternates (D36)".
- D43: "alternates share the step's cap because the cap is part of the leaf".
- Failure scenario:
  1. A user approves a 10 USDC envelope. Step 0 pays merchant M with `stepCap` 0.5 USDC.
  2. A hijacked K3 calls `reserve(step 0, M, stepCap 0.5, …)` 20 times (each with fresh `validBefore`).
  3. Every call passes. M (or a colluding alternate) receives the full 10 USDC.
  4. The "per-step cap" promise in specs 01, 02 and D43 is false; only the envelope cap binds.

## Proposed change
- Add `stepUsed[envelopeId][stepIndex]` (shared by the payee and its alternates).
- Increase it in `reserve` and `openJob`; decrease it on `finalize` release and job refund.
- Require `stepUsed + total ≤ stepCap` and `stepCap ≤ maxStepAmount`. Add INV for it in `security-and-testing.md`.

## Affected tasks
- T-015, T-018, T-021, T-045 (M1, M3)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted, applied in `czar-vault.md` §4 (`stepUsed`), §5.3, §5.5, §6.5 step 7, INV-12; `ICzarVault.sol` (`StepUsed`, `StepCapExceeded(...)`, `stepUsed()`); T-015, T-018.
