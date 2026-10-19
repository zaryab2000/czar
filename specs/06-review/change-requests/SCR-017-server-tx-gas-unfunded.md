# SCR-017: Nothing funds gas for agent (K3), autonomy (K5) and evaluator (K7) transactions, which must come from those keys as `msg.sender`.

| Field | Value |
|---|---|
| ID | SCR-017 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `specs/01-system-architecture/system-architecture.md` (lines 550, 993); CZ-27 key table (lines 367, 380); CZ-24 (line 71) |
| Status | Open |
| Review finding | RV-017 (High) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- The vault checks `msg.sender == agentSigner` for `reserve`, `openEnvelope`, `fundPocket` and others. A relayer cannot call them.
- No spec funds, caps or monitors native USDC on K3, K5 or K7.
- K5's policy has no transaction kind for `lowerAutoLimit`, which CZ-24 sends.

## Evidence
- Spec 01 line 550: "Server calls to the vault pay gas from Czar's relayer in USDC."
- Relayer: "plain transactions to the vault selectors, `OpenEvidenceLog`, `GatewayMinter.gatewayMint` only; balance capped".
- K5 allowed kinds: "`autonomy-raise` (02 §6.2 digest only)"; CZ-24 line 71: "with K3 or K5 as `msg.sender`".
- `czar-vault.md` §5 tables: callers are "agent", not "anyone".
- Failure scenario:
  1. A coding agent follows spec 01 and routes agent calls through the relayer; every call reverts `NotAgent`.
  2. Or K3 runs dry of gas mid-objective and payments stall with no alert.

## Proposed change
- Specify a gas balance for K3 and K7 (and K5 if it sends transactions), with a cap, refill procedure and low-balance alert.
- Correct spec 01 line 550. Remove K5 from `lowerAutoLimit` callers or add a K5 `vault-call` kind.

## Affected tasks
- T-035, T-036, T-048 (M2, M3)

## Decision
- <filled in by Zaryab: accepted or rejected, and why>
