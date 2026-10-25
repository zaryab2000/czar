# SCR-127: Gateway balance projection, slow-withdrawal state and late pocket funds

| Field | Value |
|---|---|
| ID | SCR-127 (number already cited by `ops/local/T-040-task-report.md:20,63`; this file fills it) |
| Filed by | chief architect, 2026-10-25 (Track A replan, baseline `ce17dad`) |
| Spec and section | `docs/specs/04-components/server/server-acceptance-evidence-selection.md` CZ-19 §5.4, §5.5, §5.6; `docs/specs/04-components/server/server-autonomy-roi-keys.md` CZ-27 §5.2 (`pocket-return`, `pocket-slow-withdraw`), §5.3 retirement rule; `docs/specs/04-components/server/server-planning-and-payment.md` CZ-15 §5.3 steps 7–8; `docs/specs/03-smart-contracts/czar-vault.md` §5.4 `writeOffPocket` row; `docs/specs/01-system-architecture/system-architecture.md` §8.4; `@czar/config` |
| Status | Accepted (Zaryab, 2026-10-25); Applied (2026-10-25) |

## Problem
- No component produces the Gateway figures that pullbacks, pocket close, key retirement and the signer's K4 policy require.
  - The signer projection throws on `pocketBalances` (`apps/signer/src/postgres-projection.ts:230-238`) and hard-codes `slowWithdrawAllowed = false` (`:173-175`).
  - `slowWithdrawalOpen` is read as `true` because the indexer mirror never writes it (`:226`; `apps/indexer/src/mirrors.ts:144-166`).
  - Result: every K3 `writeOffPocket`, every K4 `pocket-return` and every `retirePocketKey` is denied in production.
  - `PullbackInput.availableBalance` (`apps/server/src/payer/pullback.ts:74`) has no producer.
- The specs disagree on three points:
  - CZ-27 §5.3 cites an on-chain `GatewayWallet.availableBalance` view (`server-autonomy-roi-keys.md:441`), but spec 01 says no fact lists it (`system-architecture.md:732`). Ground truth A2-15 lists only `withdrawalBlock`, `withdrawingBalance` and `withdrawableBalance`.
  - The `writeOffPocket` precondition differs three ways: `czar-vault.md:182` adds "non-zero Gateway balance", CZ-27 `:399` checks only the slow withdrawal, and CZ-15 `:368` sends `value ≤ 0` straight to write-off.
  - CZ-19 §5.6 polls only `Funded`/`Draining` pockets, so late funds on a `Closed` pocket (CZ-15 §5.3 step 8, 03 §5.4) are invisible by spec.
- The specs are silent on four points:
  - which `/v1/balances` field is "available"
  - decimal-to-`Amount6` conversion
  - the maximum age of a balance
  - the slow-withdrawal `value`, and what happens on a repeat call (A2-15: a repeat call resets the timer)

## Evidence
- The four verification reports for this replan (C §0–§7, DE §E1). The same facts can be checked directly at the file:line references above.
- A2-29 (`00-ground-truth/part2.md:167`): `/v1/balances` returns `balance` and `pendingBatch`, and a buyer's pending payment is already subtracted from `balance`. The recorded response stores amounts as decimal strings (`docs/research/evidence/experiments/a2-gateway-e2e/raw/merchant-balance.json`).

## Proposed change

### 1. Producer: CZ-19 pocket balance projection (owner: indexer)
- New indexer table `pocket_balances`, one row per pocket:

  | Column | Type | Source |
  |---|---|---|
  | `pocket` (PK) | lowercase address | pockets mirror |
  | `vault` | lowercase address | pockets mirror |
  | `gatewayAvailableAtomic` | `Amount6` string | `POST /v1/balances` → `balances[i].balance` for the deployment manifest's `gatewayDomain`, `depositor = pocket` |
  | `gatewayPendingBatchAtomic` | `Amount6` string | same response, `pendingBatch` |
  | `gatewayWithdrawingAtomic` | `Amount6` string | on-chain `GatewayWallet.withdrawingBalance(USDC, pocket)` (A2-15) |
  | `withdrawalBlock` | integer | on-chain `GatewayWallet.withdrawalBlock(USDC, pocket)` (A2-15) |
  | `apiObservedAt` | RFC 3339 | time of the last successful `/v1/balances` read |
  | `chainObservedBlock` | integer | block of the last successful on-chain read |
  | `apiConsecutiveFailures` | integer | reset to 0 on success |
  | `apiLastError` | enum `timeout \| http-4xx \| http-5xx \| malformed \| network` | never the response body |

- **Available balance is `balance`.** It is not `balance − pendingBatch` (A2-29: pending payments are already subtracted).
- **Decimal conversion is exact.** Parse the decimal string with at most 6 fraction digits into an integer `Amount6`. Any other form counts as a `malformed` failure, never a rounded value.
- **Poll scope** replaces §5.6's "every pocket in `Funded`/`Draining`":
  - Every pocket whose K4 has not been destroyed: `Registered`, `DelegateReady` (`apps/indexer/src/mirrors.ts:160`), `Funded`, `Draining` and `Closed`, until the signer's retirement destroys K4.
  - The interval is `indexer.gatewayPollSeconds`.
  - Covered calls: `/v1/x402/transfers?from=`, `/v1/balances`, and the two on-chain views.
- **Stale or failing data** is never replaced by a guess. The row keeps the last good figures with their observation time, and consumers apply §3.
- `slowWithdrawalOpen` is derived and never stored by hand: `gatewayWithdrawingAtomic > 0`. Replace the pockets mirror field the signer reads with this derivation.
- The `pocket-stale` alert (§5.5) and the `gateway-poll-failing` degraded flag (§5.5) are written to `halt_flags`/the alerts table as already specified. They are now in scope for this producer.

### 2. CZ-19 §5.4 queries added (exact)

| Query | Consumer | Returns |
|---|---|---|
| `pocketBalance(pocket)` | CZ-15, CZ-27 signer | the `pocket_balances` row, plus `apiAgeSeconds`/`chainAgeBlocks` computed at read time |
| `fundedPocketsForVault(vault)` | CZ-15 halt drain | pockets of the vault in `Registered`/`DelegateReady`/`Funded`/`Draining`, each with `envelopeRef`, `outstanding`, `pendingPullback`. CZ-15 maps pocket → `planId` itself through its own `plan_pocket_keys` table (`apps/server/migrations/0008-pocket-jobs.sql:1`), so the indexer never reads a server table |
| `closedPocketsWithBalance()` | CZ-15 late-funds recovery | `Closed` pockets with `gatewayAvailableAtomic > 0` or `gatewayWithdrawingAtomic > 0` and K4 not destroyed |

### 3. Freshness and error rules (new config keys)

| Key | Default | Reason |
|---|---|---|
| `indexer.gatewayBalanceMaxAgeSeconds` | 120 | four polls at `indexer.gatewayPollSeconds` 30; older figures are stale |
| `payer.gatewayRecoveryPollSeconds` | 60 | interval of the closed-pocket recovery pass (§5) and the SCR-133 manual-return reconciliation; slower than the 30 s indexer poll it reads |

- **No new keys for the Gateway domain or minter address.**
  - The deployment manifest (`deployments/arc-local.json`, written by `contracts/script/Deploy.s.sol:116-117`; testnet manifest by T-027) is the single source. The signer already reads it (`apps/signer/src/local-main.ts:23,40-42`), and the server composition reads it under SCR-132 §6.
  - The domain is 26 (`Deploy.s.sol:20`; recorded `/v1/balances` response `docs/research/evidence/experiments/a2-gateway-e2e/raw/merchant-balance.json`).
  - The indexer's `/v1/balances` request uses the manifest value.
- **The Gateway API base URL** is the key `chain.gatewayApiBaseUrl` defined in SCR-130, not here.

- **Signer (CZ-27):**
  - The signer reads EOA USDC, native balance, `withdrawingBalance` and `withdrawalBlock` itself from the chain. It already holds a chain client, and the signer never trusts the caller.
  - It reads only the Gateway API figure from `pocketBalance(pocket)`.
  - A stale or failing API figure denies `writeOffPocket`, `retirePocketKey` and `pocket-slow-withdraw` (fail closed).
  - It never denies `pocket-return` to the pocket's own vault. That action only returns money and the amount is the live EOA balance.
- **Server (CZ-15):**
  - A stale or failing API figure means the pullback waits. It records `gateway-balance-stale` in `step_executions` and is retried on the existing fallback schedule.
  - If the figure stays unavailable for `payer.pullbackApiDownHours`, it is treated exactly like "API unreachable" (CZ-15 §5.3 slow path).

### 4. Rule clarifications (replacing conflicting text)
- **Write-off precondition (03 §5.4, CZ-27 §5.2 K3, CZ-15 §5.3 step 8)** replaces all three texts with one rule. The signer allows `writeOffPocket` only when all of these hold:
  - `pendingPullback = 0`
  - `slowWithdrawalOpen = false`
  - a `gatewayAvailableAtomic` read within `indexer.gatewayBalanceMaxAgeSeconds` that is **at most** `payer.pullbackMaxFeeAtomic + payer.pullbackSafetyAtomic`
- **Why "at most the fee", not zero:**
  - A balance above the fee can always be pulled back, so write-off waits for that pullback.
  - A balance at or below the fee (dust) cannot be pulled back, because Gateway debits `value + fee`.
  - Requiring zero would leave every pocket that keeps dust after a normal pullback unable to close. `closeEnvelope` then reverts `EnvelopeBusy` while pockets are open (`contracts/src/vault/logic/EnvelopeLogic.sol:96-98`), and the envelope's committed USDC stays locked. That is the common case.
- **Dust after write-off** is recovered by §5 as free vault balance. So 03 §5.4's "or a non-zero Gateway balance" becomes "or a fresh Gateway balance above the pullback fee".
- **CZ-15 text** "If `value ≤ 0` the pocket goes straight to write-off" becomes: "If `value ≤ 0` (the remaining Gateway balance is at most the fee), the pocket goes to write-off once the signer's fresh-balance rule is met; any dust is recovered after close (§5.3 step 8)."
- **On-chain `availableBalance`:** CZ-27 §5.3 drops "on-chain `GatewayWallet.availableBalance(USDC, pocket)` … (`Balances.sol` lines 60, 69)".
  - The retirement rule reads the API `balance` figure and on-chain `withdrawingBalance` (A2-15).
  - G0-05 records whether such a view exists. If it does, a later SCR may add it as a cross-check.
- **Slow withdrawal value:**
  - `pocket-slow-withdraw` initiates exactly once per pocket, with `value = gatewayAvailableAtomic` at initiation.
  - It is never called again while `slowWithdrawalOpen` (A2-15: a repeat call resets the timer).
  - The failed pullback's `value` is no longer used for this.
- **`slowWithdrawAllowed` (CZ-27 `pocket-slow-withdraw`):** true only when one of these holds:
  - (a) a `payer_pullback_gateway_failures` row for the pocket has `unavailable_since ≤ now − payer.pullbackApiDownHours`; or
  - (b) the pocket is `Closed` and holds dust as defined above.
  - The "owner asked in the app" trigger is deferred until a CZ-22 screen and wording exist. It is not built in Phase 1 Track A.

### 5. Late funds after close (CZ-15 §5.3 step 8; implements 03 §5.4 row "Funds reach a pocket after it closed")
- CZ-15 runs a recovery pass every `payer.gatewayRecoveryPollSeconds` over `closedPocketsWithBalance()`:
  - if `gatewayAvailableAtomic > maxFee + payer.pullbackSafetyAtomic`: a recovery `requestPullback(pocket, value, …)` (the contract creates a `recovery` record on a `Closed` pocket, `PocketLogic.sol:141-153`), then the normal `/v1/transfer` → mint → `confirmPullback`. The mint lands as free vault balance.
  - else if dust: the slow path, then `pocket-return` of the withdrawn USDC to the vault.
    - For a `Closed` pocket the USDC lands as free balance and no `recordManualReturn` is needed.
    - The contract accepts `recordManualReturn` only for `Funded`/`Draining` pockets (`PocketLogic.sol:245-247`).
- `executePullback` must never call `writeOffPocket` for a `Closed` pocket (`pullback.ts:590-618` today does).
- The test named in T-053, `payer_pocketClose_sweepsGasAndRecoversLateBalance`, becomes mandatory for the producer task.

### 6. Nanopayment cap accounting (CZ-27 `gateway-nano`)
- `nanoSpent` counts every `gateway_transfers` row in `received`, `batched`, `confirmed` or `completed`, and excludes only `failed`.
- Today only `completed` is counted (`postgres-projection.ts:245,250`), which under-counts in-flight spend against the cap.

## Affected tasks
- T-032 (indexer Gateway poll), T-037 (pocket key retirement), T-052 (halt drain), T-053 (pullback, late funds, slow path), T-040 (local stack config).
- New task TA-20 (producer) and TA-21 (server consumers) in the Track A plan.

## Decision
- Accepted by Zaryab on 2026-10-25 with the Track A replan (context and briefs in `docs/builder-prompts/track-a/`).

## Applied
- CZ-19 §5.3 `pocket_balances`, §5.4 three queries, §5.6 scope and freshness (`server-acceptance-evidence-selection.md`)
- CZ-27 §5.2 write-off and slow-withdraw rows, §5.3 retirement rule, signer reads, nano caps (`server-autonomy-roi-keys.md`)
- CZ-15 §5.3 step 7 value and write-off, late-funds pass, slow-path value (`server-planning-and-payment.md`)
- 03 `czar-vault.md` `writeOffPocket` signer note (contract unchanged)
- `@czar/config`: `indexer.gatewayBalanceMaxAgeSeconds`, `payer.gatewayRecoveryPollSeconds`; `chain.gatewayApiBaseUrl` is defined by SCR-130
- Spec 01 §8.4 already marks the on-chain `availableBalance` view as GAP; no change needed there
- Task T-124 and the T-053 note (`phase-1-tasks.md`)
