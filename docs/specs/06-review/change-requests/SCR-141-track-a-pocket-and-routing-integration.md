# SCR-141: Slow-withdraw amount when the Gateway API is down, closed-pocket quiet period, and objective Gateway volume `V`

| Field | Value |
|---|---|
| ID | SCR-141 |
| Filed by | chief architect, 2026-10-25, from Lane 1 (TA-20 / T-124) and Lane 2 (TA-08 / T-122) integration questions relayed by the Lane Orchestrator |
| Spec and section | SCR-127 §1, §3, §4; CZ-19 §5.3, §5.6 (`server-acceptance-evidence-selection.md`); CZ-27 §5.2 `pocket-slow-withdraw` row and signer reads (`server-autonomy-roi-keys.md`); CZ-15 §5.3 slow path (`server-planning-and-payment.md`); CZ-14 §4, §5 (`server-planning-and-payment.md`); `@czar/config` |
| Status | Accepted (Zaryab's delegation for Track A integration rulings; recorded by his merge of this change) |

## Problem

### 1. Slow withdrawal is unreachable on its own trigger
- SCR-127 §3: a stale or failing Gateway API figure denies `pocket-slow-withdraw` (fail closed).
- SCR-127 §4 trigger (a): the slow path starts after the API has been unavailable for `payer.pullbackApiDownHours` (24 h).
- After 24 h of unavailability the API figure is always older than `indexer.gatewayBalanceMaxAgeSeconds` (120 s). Trigger (a) can therefore never be signed. The slow path exists for exactly that case.
- SCR-127 §4 fixes `value = gatewayAvailableAtomic` at initiation, but doesn't say which observation of that figure counts when it's stale.

### 2. The closed-pocket quiet period has no stored start time
- SCR-127 §1 / CZ-19 §5.6 stop polling a `Closed` pocket only after its balances have read zero for `indexer.closedPocketQuietHours` (48 h).
- `pocket_balances` (CZ-19 §5.3) has no column holding when that zero interval began. The interval can't be measured across polls or restarts.

### 3. Objective Gateway volume `V` has no defined calculation
- CZ-14 §4 lists "the objective's total Gateway-eligible volume `V`" as an input, and §5 step 3 uses it in `pocketWorthIt`.
- No spec defines how `V` is calculated, when, or by whom. The planner code takes it as an external per-objective input (`PlannerOperationsDependencies.gatewayVolumeAtomic(objectiveId)`). No component can produce that before the plan's own steps are probed.
- Track A is vault-direct `x402-exact` only. The Gateway pocket path's safety chain (SCR-127 producer TA-20 and consumers TA-21) isn't built yet. Nothing in the specs stops the router from choosing `gateway-nano` before then.

## Proposed change

### 1. `pocket-slow-withdraw` `initiate` under trigger (a) (amends SCR-127 §3, §4; CZ-27 §5.2; CZ-15 §5.3)

- **The amount is an observed figure, never a guess.** `value` is the `gatewayAvailableAtomic` of the pocket's `pocket_balances` row as stored at signing time. If the figure is fresh, it's the current figure. If it's stale, it's the **last good observation**, timestamped by `apiObservedAt`. No other source, adjustment or estimate is allowed.
- **The signer allows `initiate` under trigger (a) only when every check below holds.** It reads each value itself:
  1. A CZ-15 `payer_pullback_gateway_failures` row for the pocket has `unavailable_since ≤ now − payer.pullbackApiDownHours` (unchanged).
  2. The `pocket_balances` row has a non-null `apiObservedAt`. A pocket with no good observation has no amount, so the signer denies `gateway-figure-missing`.
  3. `gatewayAvailableAtomic > 0`.
  4. `payload.value` equals that `gatewayAvailableAtomic` exactly. Otherwise the signer denies `slow-withdraw-value-mismatch`.
  5. **No newer payment was signed from the pocket.** The signer's own `audit` rows show no `signer:gateway-nano` row with outcome `signed` for this pocket's K4 `keyRef` at or after `apiObservedAt − indexer.gatewayBalanceMaxAgeSeconds`. If one exists, the signer denies `pocket-spend-after-observation`.
  6. On-chain `withdrawingBalance(USDC, pocket) = 0`, read by the signer (unchanged: `initiate` once per pocket, never while open).
  7. The vault and pocket checks the row already requires are unchanged.
- **Why check 5 makes the stale figure safe:**
  - The API `balance` already subtracts every payment Gateway had received at `apiObservedAt` (A2-29).
  - Gateway debits a pocket only for authorizations K4 signed.
  - An authorization signed more than `indexer.gatewayBalanceMaxAgeSeconds` (120 s) before the observation has had four times `payer.callTimeoutMs` (30 s) to reach Gateway through the x402 settle call.
  - So withdrawing the last good figure can't take funds owed to an authorization Gateway already counted.
  - Deposits after the observation only make the withdrawal smaller than the full balance. The remainder is recovered by the normal pullback or late-funds pass once the API returns. That direction is safe.
- **Trigger (b) (closed-pocket dust) is unchanged.** It still requires a fresh figure. The dust path is not time-critical and waits for the API.
- **The `withdraw` step needs no API figure.** It is allowed when on-chain `withdrawingBalance > 0` and the current block is at least `withdrawalBlock`, both read by the signer. The amount is fixed on chain. SCR-127 §3's stale-figure denial applies to `initiate` only, plus `writeOffPocket` and `retirePocketKey` (unchanged).
- **CZ-15:** when trigger (a) is met, CZ-15 sends `initiate` with `value` = the `gatewayAvailableAtomic` from its own `pocketBalance(pocket)` read. On `slow-withdraw-value-mismatch` (the API recovered between reads) it rereads and retries on the existing schedule. On `gateway-figure-missing` or `pocket-spend-after-observation` it records the denial code in `step_executions` and waits for the API.
- **Accepted risk:** a seller that holds a K4 authorization and submits it to Gateway more than `indexer.gatewayBalanceMaxAgeSeconds` after signing may find the amount already moved to `withdrawingBalance`, and its batch fails. That is outside the x402 synchronous settle flow. The local Gateway stand-in can't exercise it. It is first exercised against real Gateway in M8 (D92). Confidence that real Gateway behaves as A2-29 states: moderate.

### 2. Closed-pocket quiet period (amends SCR-127 §1; CZ-19 §5.3, §5.6)

- **Lane 1's proposal is approved:** `pocket_balances` gains the internal column `closedZeroSince` (RFC 3339, nullable).
- **Set:** on a poll cycle for a `Closed` pocket where every one of these reads zero **from a successful read in that cycle**:
  - the API `balance` (`gatewayAvailableAtomic`)
  - the API `pendingBatch` (`gatewayPendingBatchAtomic`)
  - on-chain `withdrawingBalance`
  - the pocket EOA's USDC balance

  If the column is null, it is set to that cycle's observation time.
- **Reset to null:** when any of those four reads non-zero.
  - `pendingBatch` is added to SCR-127's three balances. Payments still in a batch can re-credit the pocket if they fail (A2-18). This only lengthens polling.
- **A failed or malformed read neither sets nor resets it.**
- **Polling ends** when `now − closedZeroSince ≥ indexer.closedPocketQuietHours` **and** the latest API read is no older than `indexer.gatewayBalanceMaxAgeSeconds` **and** the latest on-chain reads are from the current cycle.
- **Durability:** stored in Postgres next to the row. If it is ever lost (restart or reindex), the quiet period restarts. That only lengthens polling and is acceptable.
- **Not public:** it is excluded from `pocketBalance`, `fundedPocketsForVault`, `closedPocketsWithBalance` and every API response. The pocket EOA's USDC balance used here is also internal and not added to the public row.
- **No key-state signal:** as SCR-127 already says, the indexer never learns of K4 destruction. Polling ends on observed balances only.

### 3. Objective Gateway volume `V`, and Gateway routing off in Track A (amends CZ-14 §4, §5; CZ-13 build order)

- **`V` is computed by the planner from the plan it is building.** It is not an external input. Remove `gatewayVolumeAtomic(objectiveId)` from the planner's dependencies. The other component types are unchanged.
- **Definition.** For an objective's plan:
  - `V = Σ expectedCalls × gatewayUnitAmount` over every paid step whose chosen candidate's live 402 has `hasGateway` (CZ-14 §5 step 2).
  - `gatewayUnitAmount` is the `amount` of that step's `GatewayWalletBatched` offer, in `Amount6` atomic units, as a `bigint`.
  - A step the router sends to `erc8183-job` under §5 step 1 is not counted.
  - Unpaid steps (`local`, `agent-assist`) are not counted.
- **When.** CZ-13 probes and prices every step's chosen candidate first, computes `V`, then routes each step through CZ-14 with that `V`. CZ-15 recomputes `V` the same way from the approved plan's steps and fresh 402s when it re-evaluates routing right before paying (CZ-14 §3).
- **Owner.** Lane 2 (`apps/server/src/planner/`, `apps/server/src/router/`), inside TA-08.
- **Gateway routing is off until the pocket safety chain exists.** New key `routing.gatewayEnabled`, boolean, default `false`.
  - When `false`, CZ-14 §5 step 2 evaluates `hasGateway = false` for every offer set.
  - The router then never returns `gateway-nano`. A step whose only usable offer is Gateway ends `unsupported-offer`.
  - `V` is still computed and unit-tested; it has no routing effect while the key is `false`.
  - The default changes to `true` only by a later SCR, after TA-20 (T-124) and TA-21 (T-053) merge and the Phase A2 pocket path is reviewed.
  - A conservative "`V = 0`" fallback is **not** approved. It would route Gateway-only offers to `fee-exceeds-payment` instead of stating that the route is off, and it would leave the routing decision depending on a value nobody computes.

## What this does NOT change

- `pocket_balances` public columns, the three CZ-19 queries and their responses.
- Trigger (b), `writeOffPocket`, `retirePocketKey` and `pocket-return` rules (SCR-127 §3, §4).
- The once-per-pocket `initiate` rule.
- CZ-14's cost model, thresholds and decision order other than the `hasGateway` switch.

## Affected tasks

- **TA-20 / T-124 (Lane 1):**
  - `closedZeroSince` and the quiet-period rule
  - the signer `pocket-slow-withdraw` checks above (`gateway-figure-missing`, `slow-withdraw-value-mismatch`, `pocket-spend-after-observation`)
  - `withdraw` without an API figure
  - tests for each denial, for fresh vs. last-good amounts, and for a `gateway-nano` signature inside the window
- **TA-21 / T-053 (Lane 2):** CZ-15 sends the observed amount and handles the three denial codes.
- **TA-08 / T-122 (Lane 2):**
  - `V` computed inside planning
  - the `gatewayVolumeAtomic` dependency removed
  - `routing.gatewayEnabled` respected
  - tests: `V` sums only Gateway-offer paid steps; a Gateway-only offer is `unsupported-offer` while the key is `false`; with the key `true`, the existing CZ-14 table-driven tests still pass
- **`@czar/config` (architect, this change):** `routing.gatewayEnabled`.

## Decision

- Architect ruling under Zaryab's delegation for Track A integration questions. Recorded by Zaryab's merge.

## Applied
- CZ-19 §5.3 `pocket_balances` row (internal `closedZeroSince`) and §5.6 quiet-period rule (`server-acceptance-evidence-selection.md`)
- CZ-27 §5.2 `pocket-slow-withdraw` row and signer reads (`server-autonomy-roi-keys.md`)
- CZ-14 §4 `V` definition and §5 step 2 `routing.gatewayEnabled` switch; CZ-15 slow-path value (`server-planning-and-payment.md`)
- `@czar/config`: `routing.gatewayEnabled` (boolean, default `false`)
- Task notes on T-122, T-053 and T-124 (`phase-1-tasks.md`)
