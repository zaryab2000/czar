# SCR-144: Durable slow-path resume for pocket returns, and manual-return event ordering

| Field | Value |
|---|---|
| ID | SCR-144 |
| Filed by | chief architect, 2026-10-26, from TA-21 (PR #91) and TA-22b questions relayed by the Lane Orchestrator |
| Spec and section | SCR-127 §5; SCR-133 (reconciliation, CZ-19 query); CZ-15 late funds (`server-planning-and-payment.md`); CZ-19 §5.4 `manualReturnsForVault` (`server-acceptance-evidence-selection.md`) |
| Status | Accepted (Zaryab's delegation for Track A integration rulings; recorded by his merge) |

## Problem
1. **A closed pocket's dust can be lost on restart.**
   - After a dust slow withdrawal, `withdraw` moves the USDC into the pocket EOA. Both Gateway figures then read zero.
   - `closedPocketsWithBalance()` (SCR-127) stops returning the pocket before K4's `pocket-return` sends the USDC to the vault.
   - If the server restarts, nothing tells it to finish the return.
2. **The manual-return order has a missing field.**
   - SCR-133 matches `ManualReturnRecorded` after `return_tx` by `(block, logIndex)`.
   - But the `manualReturnsForVault` response it specified is `{pocket, credit, txHash, block}`, with no `logIndex`.
   - It also doesn't say how CZ-15 gets the block and log index of its own return transaction.

## Proposed change

### 1. The slow path is driven by the server's own write-ahead row (owner: Lane 2; no indexer change)
- **Discovery source:** CZ-15's own `payer_pullback_gateway_failures` row. The indexer query is not the source.
  - **Closed-pocket dust:** the row has `closed_pocket = true`. It is written **before** K4 `initiate` is requested. At most one open closed-pocket row per pocket, enforced by a partial unique index on `pocket` for non-terminal closed-pocket rows.
  - **API-down (funded) pockets:** the existing row (SCR-127 trigger a).
- **Recovery pass:** every `payer.gatewayRecoveryPollSeconds`, it covers both:
  - `closedPocketsWithBalance()`, to discover new late funds (unchanged)
  - every open slow-path row, to resume work already started
- **Durable fields:** the row records `initiate_tx`, `withdraw_tx` and `return_tx`, plus `return_block`, `return_log_index` and `returned_amount` (the SCR-133 columns), before or as each transaction is sent.
- **Resume rule.** Re-derived from the chain on every pass, so it is idempotent:

  | On-chain reads (by CZ-15) | Action |
  |---|---|
  | `withdrawingBalance > 0`, block < `withdrawalBlock` | wait |
  | `withdrawingBalance > 0`, block ≥ `withdrawalBlock` | K4 `withdraw` |
  | `withdrawingBalance = 0`, pocket EOA USDC > 0 | K4 `pocket-return` (amount = live EOA balance, the signer's rule) |
  | `withdrawingBalance = 0`, EOA USDC = 0, `return_tx` recorded and mined | terminal (below) |
  | `withdrawingBalance = 0`, EOA USDC = 0, no `return_tx` | read the `initiate_tx` receipt; if it was dropped or reverted and the slow-withdraw conditions still hold, `initiate` again (the once-per-pocket rule forbids a second **open** withdrawal, not a retry of one that never landed) |

- **Completion rule.** A row becomes terminal only when all three hold:
  - the `return_tx` receipt is mined and contains a USDC `Transfer(pocket → vault)` log, whose block, log index and value are stored
  - a fresh chain read shows pocket EOA USDC = 0
  - `withdrawingBalance = 0`
- **Terminal states:**
  - closed-pocket rows → `returned-to-vault`. The USDC is free vault balance. No manual return is used (SCR-127 §5).
  - funded-pocket rows → `manual-return-required` (SCR-133), then `recorded` or `expired`.
- **State CHECK for `payer_pullback_gateway_failures`:**
  - `pending`
  - `manual-return-required`
  - `recorded`
  - `expired`
  - `returned-to-vault`
  - Lane 2 sequences TA-21's and TA-22b's migrations so the final CHECK holds exactly this set.

### 2. Manual-return ordering (owners: Lane 1 response, Lane 2 return position)
- **CZ-19 `manualReturnsForVault(vault)`** returns `{pocket, credit, txHash, block, logIndex}`, ordered by `(block, logIndex)`.
  - The indexer already stores and sorts by `logIndex` (`apps/indexer/ponder.schema.ts:124`, `apps/indexer/src/api/store.ts:485-489`). The response mapping drops it.
  - **Lane 1** adds it to the response, with a test that two events in one block come back in log order with their indices.
- **CZ-15 return position:** Lane 2 takes `return_block` and `return_log_index` from the receipt of its own `pocket-return` transaction, fetched through its chain client.
  - The position is the index of the USDC `Transfer(pocket → vault, returned_amount)` log in that receipt.
  - It is stored with `return_tx` when the receipt is mined (§1 completion rule).
- **Match:** a `ManualReturnRecorded` for the same pocket where `(block, logIndex) > (return_block, return_log_index)` → `recorded`, storing `credit` and `txHash` (unchanged otherwise).

## Tests (required)
- **TA-21 / PR #91, restart test:**
  - Simulate a crash after `withdraw` is mined and before `pocket-return`. Both Gateway figures read zero and `closedPocketsWithBalance()` is empty. After restart, the recovery pass resumes from the row and sends exactly one `pocket-return`.
  - A second crash after `pocket-return` is mined but before the row update reaches terminal from the receipt, with no second transfer.
  - A crash between writing the row and signing `initiate` resumes from on-chain `withdrawingBalance`.
- **TA-22a follow-up (Lane 1):** `logIndex` in the response and its order.
- **TA-22b (Lane 2):**
  - same-block ordering: a record in the same block but at a lower log index than the return does not match
  - `return_block` and `return_log_index` come from the receipt

## Affected tasks
- TA-21 / T-053 (Lane 2, PR #91): §1, before merge.
- TA-22a follow-up (Lane 1, small PR): §2 response field.
- TA-22b / T-125 (Lane 2): §2 position and match; the migration CHECK set.

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.
