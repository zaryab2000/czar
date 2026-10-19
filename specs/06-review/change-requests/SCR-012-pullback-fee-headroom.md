# SCR-012: The pullback asks to move the whole available balance, leaving nothing for Gateway's fee, so the drain likely fails.

| Field | Value |
|---|---|
| ID | SCR-012 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `specs/04-components/server-planning-and-payment.md` CZ-15 step 7 (line 350); `specs/04-components/phase-1-acceptance-scenario.md` 5.x (line 63) |
| Status | Accepted, applied in CZ-15 §5.3 step 7 (`value = min(outstanding − pending, availableBalance − maxFee − safety)`), G0-05 step 5 (full-balance drain), T-053. |
| Review finding | RV-012 (High) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- Gateway debits `value + fee` from the depositor's balance.
- Every experiment withdrew only part of a balance; a full-balance drain was never tested (G0-05 does not test it).

## Evidence
- "`value` is the pocket's Gateway `availableBalance` as reported by the Gateway API `/v1/balances` (A2-29) minus `payer.pullbackSafetyAtomic` 0".
- Gateway `Burns.sol` line 529: `_reduceBalance(token, depositor, value + fee)`.
- A2-18: "balance (value + fee) is re-credited".
- `research/evidence/experiments/a2-gateway-e2e/raw/withdraw-erc1271.log`: 500000 → 296500 for a 200000 withdrawal (fee 3500).
- Failure scenario:
  1. The pocket has 4,000 left. The server requests `value = 4,000`, `maxFee = 10,000`.
  2. `value + fee > balance`: the API refuses to attest (inferred) or the burn reverts.
  3. The pocket never drains; the agent eventually writes it off (RV-004).

## Proposed change
- Use `value = availableBalance − maxFee` (or minus the quoted fee) and set `pullbackSafetyAtomic ≥ MAX_PULLBACK_FEE`.
- Add a full-balance drain to G0-05 and to T-053's tests.

## Affected tasks
- T-053, G0-05 (Gate 0, M4)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted, applied in CZ-15 §5.3 step 7 (`value = min(outstanding − pending, availableBalance − maxFee − safety)`), G0-05 step 5 (full-balance drain), T-053.
