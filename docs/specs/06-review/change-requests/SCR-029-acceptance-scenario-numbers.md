# SCR-029: The Phase 1 acceptance scenario cannot pass under the routing rules and vault invariants it is meant to test.

| Field | Value |
|---|---|
| ID | SCR-029 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `docs/specs/04-components/phase-1-acceptance-scenario.md` (lines 38, 39, 60, 65, 86); CZ-14 routing (`server-planning-and-payment.md` lines 224–236) |
| Status | Accepted (D79), applied in `phase-1-acceptance-scenario.md` stages 3, 5 and 7 (numbers recomputed under the real D37/D38 rules; no test-only override); CZ-14 worked defaults; T-101, T-102. |
| Review finding | RV-029 (High) in `docs/specs/06-review/2026-10-19-spec-review.md` |

## Problem
- `pocketWorthIt` needs `V ≥ 0.149 USDC` (149,000 atomic). The scenario's Gateway volume is 4,000, so routing must skip it with `fee-exceeds-payment`.
- `writeOffPocket` writes off at most `outstanding ≤ funded`; 7,500 cannot come out of a pocket funded with 4,000.
- CZ-13's cap formula gives about 574,250 (≈ $0.57), not $1.25.

## Evidence
- 3.1: "steps 1–2 `czar-extract` Gateway route (`gateway-nano`, 1,000 × 2 each; `routingReason = below-pocket-threshold`)".
- 5.3: "`fundPocket(pocket, 4,000)`"; 5.8: "`PocketClosed(writtenOff = 4 × 1,000 + 3,500 fee)`".
- 3.2: card text "Spend up to $1.25".
- CZ-14: "Worked defaults at 20 Gwei: … `pocketWorthIt` needs `V ≥ 0.149 USDC`".
- INV-7 and `writeOffPocket` row in `czar-vault.md`.
- Failure scenario:
  1. T-101/T-102 (the M8 release gate) fail on correct code, or tempt the agent to bypass routing to make the scenario pass.

## Proposed change
- Rework the numbers: enough Gateway calls that `V ≥ 0.15 USDC`, a pocket funded above spend plus fee, and a card amount derived from the formula.
- Or add a documented test-only routing override.

## Affected tasks
- T-059, T-100, T-101, T-102 (M4, M8)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted (D79), applied in `phase-1-acceptance-scenario.md` stages 3, 5 and 7 (numbers recomputed under the real D37/D38 rules; no test-only override); CZ-14 worked defaults; T-101, T-102.
