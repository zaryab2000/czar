# SCR-003: The agent key alone can register an EOA it controls as a pocket and move 25–50% of every open envelope there; the planner sets `pocketCapBps` 2500 even with no Gateway step.

| Field | Value |
|---|---|
| ID | SCR-003 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | specs/03-smart-contracts/czar-vault.md §5.4 `registerPocket` (line 140); §5.2 `openEnvelope` (line 118); `specs/04-components/server-planning-and-payment.md` §5 step 6 (line 143) |
| Status | Accepted with changes (D71): applied in `czar-vault.md` §3, §5.2, §5.4 (`registerPocket` takes a kind-4 leaf proof), INV-14; spec 02 §4.5, §4.7 and `plan.schema.json`; CZ-13 §5 step 6/6a. Change: pockets bound by a kind-4 `payeeRoot` leaf (`stepIndex` 2^32−1, `stepCap` 0) plus `MAX_AGENT_POCKET_CAP_BPS` 2500, as D71 decided. |
| Review finding | RV-003 (Critical) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- The pocket address is not part of `payeeRoot` or anything the owner approves. Any code-less address the agent names is accepted.
- Once funded through Gateway, a depositor can burn its own balance to any recipient. So whoever holds the pocket's key controls those funds.
- Every plan gets `pocketCapBps` 2500, even plans with no `gateway-nano` step, so every approved envelope exposes 25% to this path.

## Evidence
- `registerPocket(uint64 envelopeId, address pocket)` | agent | "`notPausedOrFrozen`; envelope `Open`; `pocket != 0`; `pocket.code.length == 0` (must be an EOA …); `pockets[pocket].envelopeId == 0`".
- Planner caps: "`cap = Σ stepCap × (1 + slackBps/10000)` with `Plan.slackBps` 2500; `pocketCapBps` 2500 (D22)."
- `openEnvelope` allows `pocketCapBps ≤ MAX_POCKET_CAP_BPS` (5000) for agent-opened envelopes.
- Gateway source at `c21d2d2`: `Burns.sol` lines 332–333 and 488–491; `Delegation.sol` line 159: "A depositor is always authorized for its own balance".
- Spec 01 README line 17 promises spending only "to pre-approved payees".
- D22: pockets hold "at most 25% of an objective's envelope".
- Failure scenario:
  1. A hijacked K3 creates an EOA it controls and registers it as a pocket on every open envelope.
  2. It calls `addDelegate(vault)` from that EOA (it holds the key), then `grantPocketGas` and `fundPocket` up to 25% of each owner-approved envelope (50% on envelopes it opened itself).
  3. It signs a burn intent from the EOA to its own address and withdraws through Gateway.
  4. Result: up to a quarter of every user's approved budget leaves to a non-approved payee. The vault never sees a payee check.

## Proposed change
- Set `pocketCapBps = 0` unless the plan contains a `gateway-nano` step; state this in CZ-13 §5 step 6.
- Cap `MAX_POCKET_CAP_BPS` at 2500 for agent-opened envelopes (D22).
- Bind pockets to the approval: for example a pocket leaf kind in `payeeRoot` committing the pocket address, or a commitment the owner signs.

## Affected tasks
- T-014, T-017, T-045, T-052 (M1, M3, M4)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted with changes (D71): applied in `czar-vault.md` §3, §5.2, §5.4 (`registerPocket` takes a kind-4 leaf proof), INV-14; spec 02 §4.5, §4.7 and `plan.schema.json`; CZ-13 §5 step 6/6a. Change: pockets bound by a kind-4 `payeeRoot` leaf (`stepIndex` 2^32−1, `stepCap` 0) plus `MAX_AGENT_POCKET_CAP_BPS` 2500, as D71 decided.
