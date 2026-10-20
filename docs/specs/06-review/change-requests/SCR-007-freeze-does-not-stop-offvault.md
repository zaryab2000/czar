# SCR-007: Freeze and guardian pause do not stop pocket nanopayments or evaluator payouts, yet the product and UI say freeze stops all spending.

| Field | Value |
|---|---|
| ID | SCR-007 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `docs/specs/04-components/server-autonomy-roi-keys.md` CZ-27 `gateway-nano` and `evaluator-call` policies (lines 394, 397), wording (line 491); `docs/product/czar-product.md` §6.6 (line 166) |
| Status | Accepted (D72), applied in CZ-27 §5.2 (freeze checks fail closed), CZ-15 §5.3 step 7 and §6 (pullbacks on freeze), CZ-27 §12 and CZ-22 §5.4 wording, `docs/product/czar-product.md` §6.6; T-035, T-052, T-055. |
| Review finding | RV-007 (High) in `docs/specs/06-review/2026-10-19-spec-review.md` |

## Problem
- Pocket funds are already outside the vault, so the vault's freeze cannot stop K4. Only the signer can, and its policy does not check freeze.
- K7 can still `complete` jobs funded before the freeze.

## Evidence
- `gateway-nano` policy: "`pocket` is `Funded`/`Draining` for an open envelope; `payTo` is a leaf payee…; `amount ≤ stepCap`; cumulative per pocket ≤ `funded`" (no frozen check).
- Unpause wording: "Spending is back on. Nothing was spent while paused."
- Product §6.6: "a one-tap freeze stops all spending".
- D60/D63 describe freeze as the user's emergency stop.
- Failure scenario:
  1. The guardian pauses because the server looks compromised.
  2. The signer keeps signing K4 nanopayments up to each pocket's funded amount (25% of each envelope) and K7 keeps completing jobs.
  3. The banner tells the user "Nothing was spent while paused", which is false.

## Proposed change
- The signer denies `gateway-nano` and `evaluator-call complete` when the indexer projection shows `frozen` or `guardianPaused`.
- On `Frozen`/`GuardianPaused`, CZ-15 starts pullbacks for all pockets at once.
- Narrow the product and UI claim to what is enforced, or enforce it.

## Affected tasks
- T-035, T-037, T-052, T-055 (M2, M4)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted (D72), applied in CZ-27 §5.2 (freeze checks fail closed), CZ-15 §5.3 step 7 and §6 (pullbacks on freeze), CZ-27 §12 and CZ-22 §5.4 wording, `docs/product/czar-product.md` §6.6; T-035, T-052, T-055.
