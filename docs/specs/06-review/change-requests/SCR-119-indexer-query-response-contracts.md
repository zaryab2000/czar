# SCR-119: Indexer query response contracts

| Field | Value |
|---|---|
| ID | SCR-119 |
| Filed by | T-034 builder, 2026-10-21 |
| Spec and section | `docs/specs/04-components/server/server-acceptance-evidence-selection.md` CZ-19 §5.4 |
| Status | Accepted (Zaryab, 2026-10-21); applied to CZ-19 §5.4 and T-033 |

## Problem

- `receiptsForLedger`, `latestAnchor`, `anchorByBatch` and `dependencyState` had no response shape, and `LedgerReceipt` needs fields the indexer does not have (objective, minutes saved, acceptance, merchant label, quarantine).
- `dependencyState` reads halt flags that T-033 creates; T-033 is not a T-034 dependency.

## Decision

- 2026-10-21: **Accepted** (architect ruling under Zaryab's delegation), applied to CZ-19 §5.4:
  - `receiptsForLedger` returns chain and Gateway settlement facts per authorization index; CZ-12/CZ-25 join server-side fields into `LedgerReceipt`. Status mapping from chain and Gateway state is fixed in §5.4; `quarantined` is server-side only.
  - `latestAnchor` and `anchorByBatch` return internal shapes from the `anchors` table.
  - `dependencyState` moves to T-033 with `halt_flags`.
  - All queries filter and page in SQL.

## Affected tasks

- T-034, T-033, T-081 (`listReceipts`), T-095 (ROI ledger), T-057 (evidence publisher).
