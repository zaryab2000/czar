# SCR-145: Write-off of an overdue manual return while the Gateway API is stale

| Field | Value |
|---|---|
| ID | SCR-145 |
| Filed by | chief architect, 2026-10-26, from TA-22b / PR #96 (head `88d5c96`) relayed by the Lane Orchestrator |
| Spec and section | CZ-27 §5.2 K3 `writeOffPocket` plan check (`server-autonomy-roi-keys.md`); CZ-15 manual return (`server-planning-and-payment.md`); SCR-127 §3–§4; SCR-133; SCR-144 |
| Status | Accepted (Zaryab's delegation for Track A integration rulings; recorded by his merge) |

## Problem
- SCR-133: after `payer.manualReturnHoldHours` (72 h), CZ-15 writes off a pocket whose manual return was never recorded.
- SCR-127 / CZ-27: K3 refuses `writeOffPocket` unless the Gateway API figure is fresh and at most the pullback fee.
- A manual return exists **because** the Gateway API was down (slow path, trigger a). If it is still down after the hold, the write-off is refused forever. The row stays `manual-return-required`. The pocket can't close, so the envelope can't close, and its committed room stays locked.

## Ruling: yes, with a narrow exception the signer verifies itself

### Why it is safe
- The fresh-balance rule exists so that money still in Gateway is pulled back before the pocket closes. Write-off never destroys funds.
- After close, anything left in Gateway is recovered as free vault balance:
  - The indexer keeps polling a `Closed` pocket until fresh reads are zero for the quiet period (SCR-127 §1, SCR-141 §2, SCR-142 §2).
  - CZ-15's late-funds pass recovers what it finds (SCR-127 §5).
  - K4 is not retired while the API figure is stale (CZ-27 §5.3 retirement rule, unchanged).
- So writing off with a stale figure can only change accounting: a later recovery lands as free balance, not as a credit. It cannot strand money.

### Predicates
K3 signs `writeOffPocket(pocket)` under rule `writeoff-manual-return-overdue` only if **every** predicate holds. Each is read by the signer itself; the caller supplies only `{vault, pocket}`:
1. **Exception scope:** the Gateway API figure for the pocket is stale or failing. If it is fresh, only the normal rule applies, unchanged, so a fresh balance above the fee still means pullback first.
2. **Pocket and envelope, on chain:** the vault's pocket record is `Funded` or `Draining`, and its envelope is `Open`.
3. **No pending pullback, on chain:** the pocket record's `pendingPullback = 0`.
4. **Slow withdrawal finished, on chain:** `GatewayWallet.withdrawingBalance(USDC, pocket) = 0`.
5. **Nothing left in the EOA, on chain:** pocket EOA USDC balance = 0.
6. **The slow route really ran, from the signer's own `audit`:** this pocket's K4 `keyRef` has a `signer:pocket-slow-withdraw` row and a `signer:pocket-return` row, both with outcome `signed`.
7. **The overdue return, from the CZ-15 row plus a chain receipt:**
   - The pocket's `payer_pullback_gateway_failures` row has `closed_pocket = false`, state `manual-return-required`, and `return_tx` set.
   - The signer fetches that receipt itself. It must have succeeded and contain a USDC `Transfer(from = pocket, to = vault, value = returned_amount)` log.
   - That block's timestamp must be ≤ `now − payer.manualReturnHoldHours`.
8. **Not already recorded, from the indexer:** `manualReturnsForVault(vault)` has no `ManualReturnRecorded` for the pocket ordered after the return's `(block, logIndex)` (SCR-144). If one exists, the row is `recorded` and the normal rule governs.
- Any failed predicate → deny with the existing `writeOffPocket` denial for the first failed check.
- The freshness denial `gateway-balance-stale` stays the answer when predicates 2–8 don't all hold.

### Keeping the normal policy intact
- The exception is a separate named rule, evaluated only after the normal rule fails **solely** on freshness.
- It never applies to a `Closed` pocket. It never applies to a closed-pocket dust row (`closed_pocket = true`); that row ends `returned-to-vault` without a write-off (SCR-144).
- It never relaxes the open-slow-withdrawal check, the pending-pullback check, or the balance-above-fee check when a fresh figure exists.
- Retirement (`retirePocketKey`) is unchanged and still needs a fresh zero figure.

### Audit
- The signer writes its `audit` row with `rule = "writeoff-manual-return-overdue"` and the request `digest` (no payload, as today).
- It raises alert `writeoff-overdue-stale-gateway`, so ops can see every write-off taken without a fresh balance.

## CZ-15 behaviour (amends the SCR-133 manual-return bullet)
- When the hold has elapsed, CZ-15 requests `writeOffPocket` as usual.
  - If the signer denies, the row stays `manual-return-required` and the request is retried every `payer.gatewayRecoveryPollSeconds`. No other path is used.
- The row becomes `expired` only after the write-off is mined (`PocketClosed`).
- A late `ManualReturnRecorded` that arrives before the write-off mines wins: the row becomes `recorded` (SCR-133 ordering) and the pocket closes through the normal rule.

## Tests (required)
**Lane 1 (signer, separate small PR):**
- the exception signs when 1–8 hold and the API figure is stale
- each predicate failing on its own → denied
- a fresh figure above the fee → denied (normal rule)
- `closed_pocket = true` → denied
- the `audit` row carries the rule name

**Lane 2 (PR #96):**
- hold elapsed and signer denies → row stays `manual-return-required` and retries
- write-off mined → `expired`
- a recording before the write-off → `recorded`

## Affected tasks
- **TA-22b / T-125 (Lane 2, PR #96):** CZ-15 behaviour above. It may merge before the Lane 1 signer change: until that lands, the denial path keeps the row `manual-return-required`, which is the specified safe state.
- **Signer (Lane 1, new small PR):** the `writeoff-manual-return-overdue` rule and its tests.

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.
