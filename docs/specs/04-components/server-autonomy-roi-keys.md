# Earned autonomy, ROI ledger, key management (spec 04)

- **Date:** 2026-10-18. **Status:** draft for review. Conventions: `cross-cutting.md`. Data shapes: only `docs/specs/02-data-and-protocol/` (cited "02 §n", OpenAPI `operationId`s, MCP tool names) and `docs/specs/03-smart-contracts/` (cited "03 `<file>` §n").
- **Components:** CZ-24 earned autonomy, CZ-25 ROI ledger, CZ-27 key management. All Phase 1, all on Czar's server.

---

## CZ-24 Earned autonomy

### 1. Identity

| Item | Value |
|---|---|
| CZ ID, name | CZ-24, earned-autonomy engine |
| Phase | 1 (basic: one global category plus the plan's category); 2 (per-category tuning) |
| Product | §6.6 earned autonomy; roadmap 1.4 |
| Decisions | D11 (limits live in the vault), D25 (server computes, vault enforces), D40 (raise step ≤ 20% of `userMax`, at most once per week), D21 (security for white-collar users) |
| Contract surface | 03 `czar-vault.md` §5.6 `raiseAutoLimit`, `lowerAutoLimit`; events `AutoLimitRaised`, `AutoLimitLowered`, `LimitsSet`; invariant INV-9 |
| Signed message | 02 §6.2 `AutonomyRaise(bytes32 category,uint256 newLimit,uint64 periodId,uint256 nonce,uint256 deadline)`, signed by K5 |

### 2. Responsibilities and non-responsibilities

- **Does:** compute each user's track record per category from receipts and acceptance results; propose bounded raises; sign them with K5 through CZ-27; relay them; lower limits at once on bad outcomes; show the user why a limit changed.
- **Does not:** enforce anything (the vault does, 03 `czar-vault.md` §5.6, INV-9); raise above `userMax` (only the owner sets that, 03 §5.1 `setCategoryLimits`); open envelopes (CZ-15 does, within the allowance); touch K3.

### 3. Runtime

- A scheduled job inside `@czar/server` (`autonomy.evaluateCron`, default daily at 03:00 UTC) plus an event-driven path (lower on `wrong`, refund or freeze) triggered by CZ-12 and CZ-19.
- Stateless between runs except the tables in §5.3; restart-safe (every proposal is idempotent on `(vault, categoryId, periodId)`).
- Resource budget: O(receipts in window) per user per day; no model calls.

### 4. Interfaces

| Direction | What | Where defined |
|---|---|---|
| In | `LedgerReceipt` rows (status `settled`, `completed`, `refunded`, `failed`) | OpenAPI `listReceipts`; CZ-25 tables |
| In | `report_outcome` results (`useful`, `not-useful`, `wrong`, `unused`, `reasonCode`, `minutesSavedActual`) | 02 `mcp/czar-mcp-tools.md` §2.5 |
| In | `AcceptanceReport.decision` per step | 02 §4.14 (CZ-16) |
| In | vault events `AutoLimitRaised`, `AutoLimitLowered`, `LimitsSet`, `Frozen`, `JobRefunded` | 03 `czar-vault.md` §9.1 via CZ-19 |
| In | current `limits[categoryId]` (`userMax`, `autoLimit`, `periodId`, `usedInPeriod`, `lastRaiseAt`) | 03 `czar-vault.md` §4 (RV-031) via CZ-19 projection |
| Out | `raiseAutoLimit(categoryId, newLimit, periodId, deadline, sig)` relayed by the relayer service | 03 `czar-vault.md` §5.6 |
| Out | `lowerAutoLimit(categoryId, newLimit)` called with K3 (agent) or K5 | 03 `czar-vault.md` §5.6 |
| Out | per-category limit summary for the app | OpenAPI `getMe` (`Me` limits fields) |

### 5. Internal design

#### 5.1 Track-record score

For one `(vault, categoryId)` over the window `autonomy.windowDays`:

- A purchase `i` is **positive** when all hold: its step's `AcceptanceReport.decision = pass`; its `LedgerReceipt.status ∈ {settled, completed}`; no `report_outcome` of `wrong` or `not-useful` for its `paymentId`; it was not refunded.
- A purchase is **negative** when any holds: acceptance `fail`; `report_outcome.outcome ∈ {wrong, not-useful}`; `JobRefunded` after `reject`.
- Recency weight: `d_i = 0.5^(age_days_i / autonomy.halfLifeDays)`.
- Diversity weight: `w_i = 1 / sqrt(k_i)` where `k_i` is the index of purchase `i` among purchases to the same payee in the window (first purchase to a payee counts fully, the tenth a third; stops one merchant from building the whole record).
- Score: `S = Σ_{positive} w_i d_i`. Negatives are not subtracted; a single negative blocks raises (§5.2).

#### 5.2 Raise rule (within D40)

Run once per period per category:

1. `periodId = floor(now / PERIOD_LENGTH)` (`PERIOD_LENGTH` = 604,800 s, 03 `czar-vault.md` §3).
2. Skip if `now < lastRaiseAt + PERIOD_LENGTH` (raises at least one period apart, D40, RV-031) or `autoLimit == userMax`, or the vault is frozen or paused (the vault refuses raises then, RV-030).
3. Skip if any negative purchase, any `JobRefunded`, any `Frozen` event, or any guardian pause occurred within `autonomy.windowDays`. Skip if `S < autonomy.minScore`.
4. `stepMax = userMax × MAX_RAISE_STEP_BPS / BPS` (= 20% of `userMax`, D40; contract constant `MAX_RAISE_STEP_BPS = 2000`, 03 `czar-vault.md` §3).
5. `f(S) = autonomy.baseAtomic × S` (floored to an integer).
6. `newLimit = min(userMax, autoLimit + min(stepMax, f(S)))`. If `newLimit ≤ autoLimit`, skip.
7. Build `AutonomyRaise{category: categoryId, newLimit, periodId, nonce: vault.autonomyNonce, deadline: now + autonomy.raiseDeadlineSeconds}` (02 §6.2); request a K5 signature from CZ-27 (§CZ-27 5.2); relay `raiseAutoLimit(...)` with the relayer's gas; wait for `AutoLimitRaised` from CZ-19.

#### 5.3 Lower rule

Immediately (event-driven), with **K3** as `msg.sender` (03 `czar-vault.md` §5.6 `lowerAutoLimit` accepts owner, agent or autonomy; K5 sends no transactions and has no gas, CZ-27 §5.1, RV-017). Every lowering also bumps `autonomyNonce`, so any raise signed earlier can no longer land (RV-030):

| Trigger | New limit |
|---|---|
| `report_outcome.outcome = wrong` for a purchase in the category | `autoLimit × autonomy.lowerFactorBps / BPS` |
| `JobRefunded` after evaluator `reject`, or acceptance `fail` on a settled x402 step | same |
| `Frozen` event (user freeze) | `0` for every category (D60), as a follow-up agent step and not atomically (D63): the `frozen` flag already blocks spending, then K3 calls `lowerAutoLimit(categoryId, 0)` per category once CZ-19 indexes `Frozen` (atomic contract version is stage 2, `stage-2-backlog.md` §3 P2-15); the vault accepts `newLimit == autoLimit` (RV-008), so no category needs special-casing; `freeze()` itself already bumped `autonomyNonce`; CZ-15 opens no envelope by itself until every lowering for the latest `Frozen` event is mined (RV-030); limits stay at 0 after unfreeze until earned back |
| guardian pause | no on-chain change (the vault reads `guardianPaused()`); evaluation paused |

- Lowering never waits for the period roll and is never blocked by `lastRaiseAt`.
- Worst case per category (RV-031): raises are spaced a full period apart, but the allowance resets on the calendar boundary, so a compromised K3 can open up to `2 × autoLimit` within seconds around a boundary (never more than `2 × userMax`); spec 01 §7.3 and §13 state this bound.

#### 5.4 Phase 1 categories

- Every plan carries `category` (02 §4.5) hashed to `categoryId`. Phase 1 tracks two keys per user: the plan's category and `general` (`keccak256("general")`), where `general` is the fallback the planner uses when no category fits. Per-category tuning of `autonomy.baseAtomic` and `halfLifeDays` is Phase 2.

#### 5.5 State machine

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Evaluating: evaluateCron or periodId changed
  Evaluating --> Idle: skip (rule 2, 3, 6)
  Evaluating --> Proposed: newLimit computed
  Proposed --> Signed: K5 signature from the signer service
  Signed --> Relayed: raiseAutoLimit tx sent
  Relayed --> Confirmed: AutoLimitRaised seen by CZ-19
  Relayed --> Idle: revert RaiseAlreadyThisPeriod | RaiseTooLarge | Expired | BadSigner (logged, no retry this period)
  Idle --> Lowering: wrong | refund | freeze event
  Lowering --> Confirmed: AutoLimitLowered seen
  Confirmed --> Idle
```

| From | To | Trigger | Who | Event |
|---|---|---|---|---|
| Idle | Evaluating | cron tick or new `periodId` | scheduler | log `autonomy_evaluate` |
| Evaluating | Proposed | §5.2 steps 1–6 pass | CZ-24 | row in `autonomy_proposals` |
| Proposed | Signed | CZ-27 returns the K5 signature | signer | audit entry |
| Signed | Relayed | relayer submits `raiseAutoLimit` | relayer (gas in USDC, `maxFeePerGas ≥ 20 Gwei`, p1-A6) | tx hash stored |
| Relayed | Confirmed | `AutoLimitRaised(categoryId, old, new, periodId)` | CZ-19 | user notice |
| Idle | Lowering | §5.3 trigger | CZ-12 / CZ-19 | `lowerAutoLimit` tx |
| Lowering | Confirmed | `AutoLimitLowered` | CZ-19 | user notice |

#### 5.6 Storage

| Table | Fields | Notes |
|---|---|---|
| `autonomy_scores` | `vault`, `categoryId`, `periodId`, `score`, `positives`, `negatives`, `computedAt` | rebuilt daily; idempotent |
| `autonomy_proposals` | `proposalId` (ULID), `vault`, `categoryId`, `periodId`, `oldLimit`, `newLimit`, `nonce`, `deadline`, `state`, `txHash?`, `revertName?` | unique on `(vault, categoryId, periodId)` |
| `autonomy_lowerings` | `vault`, `categoryId`, `trigger`, `paymentId?`, `oldLimit`, `newLimit`, `txHash`, `at` | audit |

#### 5.7 Parameters

| Parameter | Default | Unit | Reason |
|---|---|---|---|
| `autonomy.evaluateCron` | `0 3 * * *` (UTC) | cron | once a day is enough for a weekly step |
| `autonomy.windowDays` | 28 | days | four periods of evidence |
| `autonomy.halfLifeDays` | 14 | days | same half-life as the Selection Layer posteriors (SL-C9) |
| `autonomy.minScore` | 3 | score | roughly three fresh positive purchases before any raise |
| `autonomy.baseAtomic` | 500000 (0.50 USDC) | atomic | one unit of score adds half a dollar of weekly allowance; small by design |
| `autonomy.lowerFactorBps` | 5000 | bps | halve on a problem; fast down, slow up |
| `autonomy.raiseDeadlineSeconds` | 3600 | s | a signed raise is useless after an hour |
| `autonomy.relayRetries` | 2 | count | reverts are not retried; only RPC errors |
| `PERIOD_LENGTH`, `MAX_RAISE_STEP_BPS` | 604800, 2000 | contract | read-only mirrors of 03 constants (D40) |

### 6. Behaviour

**Main path (raise):** daily cron → for each `(vault, categoryId)` with activity → compute `S` (§5.1) → rules 1–6 (§5.2) → store proposal → request K5 signature (§CZ-27) → relay `raiseAutoLimit` → on `AutoLimitRaised`, mark `Confirmed` and show a notice in the app (`getMe` shows the new limit).

**Alternate paths:**
- Vault reverts `RaiseAlreadyThisPeriod` (owner raised manually this period): mark proposal `Superseded`; nothing else.
- Vault reverts `RaiseTooLarge` (owner lowered `userMax` between evaluation and relay): recompute next period.
- `Expired` or `BadSigner` (rotation between sign and relay): discard; next period.
- Lower path: any trigger in §5.3 → `lowerAutoLimit` at once with K3 → notice.
- No activity in the window: nothing happens; limits neither rise nor fall (decay is implicit: `S` falls, so the next raise is smaller).

### 7. AI usage

None. Pure rules.

### 8. Privacy

- Handles: `paymentId`s, outcome enums, amounts, category ids, vault addresses (`server-only` / `public`). No goal text, no merchant bodies.
- Retention: `autonomy_scores` 1 year; proposals and lowerings 1 year (audit).

### 9. Security

- Keys: K5 (sign `AutonomyRaise`) through CZ-27 only; K3 for `lowerAutoLimit` (the lowering direction is safe, 03 `czar-vault.md` §2).
- Permissions: the vault enforces `newLimit ≤ userMax`, the 20% step and one raise per period (INV-9); a compromised CZ-24 can at most raise every user to their own `userMax` over several weeks, never above it (spec 01 §13 "Czar server compromised").
- Threats addressed: a hijacked agent cannot raise limits (K3 is not accepted by `raiseAutoLimit`); a merchant cannot farm the score (diversity weight; acceptance must pass; user `wrong` reports block raises).

### 10. Failure handling

| Failure | Behaviour | User sees | Idempotency |
|---|---|---|---|
| RPC down at relay | retry `autonomy.relayRetries` with backoff; then drop until next period | nothing | proposal row keyed by period |
| Indexer lag | evaluation uses the projection; a raise confirmed late still lands in the same period (vault checks `periodId`) | delayed notice | `AutoLimitRaised` is the truth |
| Signer denies K5 | log `kms_denied`; no raise | nothing | — |
| Revert names | as §6 | nothing | — |
| User unfreezes | limits stay lowered until earned back | "Limits start low after a freeze" | — |

### 11. Observability

- Metrics: `czar_autonomy_proposals_total{state}`, `czar_autonomy_lowerings_total{trigger}`, `czar_autonomy_score` histogram.
- Logs: vault, categoryId, periodId, old/new limits, tx hash, revert name. Never outcome reasons in free text.
- Alerts: raise reverts > `autonomy.revertAlertPerDay` (10); any raise relayed without a matching proposal row (should never happen).

### 12. Interface wording (shown by CZ-22 through `getMe`)

| State | Wording |
|---|---|
| raise confirmed | "Czar can now start objectives up to $X per week in <category> without asking. Your maximum stays $Y." |
| lowered after a problem | "Limit lowered after a problem with <merchant host>. Czar will ask before spending in <category> above $X." |
| lowered after freeze | "Limits reset after your freeze. They grow back as objectives succeed." |
| at maximum | "Czar is at the maximum you set for <category> ($Y). Raise it in Settings if you want." |
| no history yet | "Czar asks before every objective until it has a track record in <category>." |

### 13. Performance and cost

- One daily pass over ≤ `autonomy.windowDays` of receipts per user: milliseconds. One `raiseAutoLimit` tx per category per week at most: ≈ 60k gas ≈ 0.0012 USDC at 20 Gwei (03 gas estimates; measure).

### 14. Tests and definition of done

- Unit: score formula with fixed fixtures (positives, negatives, diversity, decay); every rule in §5.2 and §5.3 with one failing input each.
- Fuzz: random receipt histories → `newLimit` always ≤ `userMax`, raise ≤ 20% of `userMax`, at most one raise per period; matches INV-9 on an `arc-anvil` vault.
- Integration: proposal → signer → relay → `AutoLimitRaised` on `arc-anvil`; revert paths produce the right `revertName`.
- Definition of done: all above green; a `wrong` report lowers within one block of the event; the app shows the §12 wording; no model calls; parameters in `@czar/config`.

### 15. Dependencies

`@czar/vault-client` (03 interfaces), `@czar/hashing` (`AutonomyRaise` digest per 02 §6.2 test vector), CZ-27 signer, CZ-19 projections, CZ-25 ledger. Open question: the Phase 2 per-category parameters (OD below).

---

## CZ-25 ROI ledger

### 1. Identity

| Item | Value |
|---|---|
| CZ ID, name | CZ-25, ROI ledger |
| Phase | 1 (simple); 2 (full monthly statement) |
| Product | §6.11 ROI ledger; roadmap 2.6 |
| Decisions | D25 (minutes estimates come from the daemon), D31 wording (statements never claim raw data never left the machine), D35 (no Czar-paid credits appear in the ledger) |
| API | `listReceipts` → `LedgerReceipt`; `getMonthlyStatement` → `MonthlyStatement` (OpenAPI) |

### 2. Responsibilities and non-responsibilities

- **Does:** keep one ledger row per payment with cost and minutes saved; roll them into monthly statements; serve both to the app; feed CZ-24 with outcomes.
- **Does not:** estimate minutes itself (the daemon does, 02 §4.4 `minutesSaved`; the user corrects via `report_outcome.minutesSavedActual`); convert currency (Phase 1 shows USD only, USDC 1:1, D51); pay or refund anything.

### 3. Runtime

- Part of `@czar/server`; rows are written from CZ-15 and CZ-19 events; statements are materialized by `roi.statementCron` and on demand.

### 4. Interfaces

| Direction | What | Defined in |
|---|---|---|
| In | settlement states from CZ-19 (`Settled`, `Released`, `PocketFunded`, pullbacks, `JobSynced`, `JobRefunded`; Gateway transfer statuses `received|batched|confirmed|completed|failed`) | 03 `czar-vault.md` §9.1; A2-29 |
| In | `ObjectiveSubmission.minutesSaved` and `hourlyBand` | 02 §4.4 |
| In | `report_outcome` (`outcome`, `minutesSavedActual`) | 02 mcp §2.5 |
| Out | `LedgerReceipt` page | `listReceipts` |
| Out | `MonthlyStatement` | `getMonthlyStatement` |
| Out | positives/negatives per `paymentId` | CZ-24 |

### 5. Internal design

#### 5.1 What is measured

| Measure | Rule |
|---|---|
| cost per step | the settled amount: `x402-exact` = `unitAmount` at `Settled`; `gateway-batched` = the transfer `amount` counted at `received`, flagged `pending` until `completed` (0–16 min, A2-24 to A2-26); `erc8183-job` = `budget` at `JobSynced(Completed)`; released or refunded steps cost 0 |
| cost per objective | Σ step costs plus pocket gas grants and written-off pocket balance (`PocketClosed.writtenOff`) |
| minutes saved per objective | `minutesSaved` from the submission; replaced by `minutesSavedActual` when the user reports one (`report_outcome`), else multiplied by `roi.unverifiedFactorBps` (7000) until any `useful` report arrives |
| minutes per receipt | objective minutes split across its settled steps in proportion to cost |
| value of time | `hourlyBand` midpoint (A $15, B $40, C $75, D $150, E $250 per hour; the exact amount never leaves the machine, 02 §4.4) × minutes / 60; shown as "about" |

#### 5.2 Monthly statement

`MonthlyStatement{month, totalSpent, totalSpentDisplay, totalMinutesSaved, objectives, receipts, byCategory}` (OpenAPI). `byCategory` rows carry spent and minutes per `category`. Pending Gateway amounts are included in `totalSpent` and listed separately as pending in the receipts page.

#### 5.3 Storage

| Table | Fields |
|---|---|
| `ledger_receipts` | `receiptId` (`res_`? no: ledger rows use `paymentId` as key), `paymentId`, `objectiveId`, `envelopeRef`, `stepIndex`, `rail`, `amount`, `status` (`reserved|settled|pending|completed|released|refunded|failed`), `merchantLabel` (origin host only), `minutesSaved`, `minutesSource` (`estimate|reported`), `category`, `settledAt`, `updatedAt` |
| `monthly_statements` | `userId`, `month`, the `MonthlyStatement` fields, `materializedAt` |
| `outcome_reports` | `paymentId`, `outcome`, `reasonCode`, `minutesSavedActual`, `reportedAt` |

Rows are rebuilt deterministically from CZ-19 projections plus `outcome_reports`; a rebuild never changes totals unless new events arrived.

#### 5.4 Parameters

| Parameter | Default | Reason |
|---|---|---|
| `roi.statementCron` | daily 04:00 UTC | cheap; on-demand refresh too |
| `roi.unverifiedFactorBps` | 7000 | estimates are optimistic; discount until a user confirms |
| `roi.pendingMaxMinutes` | 20 | after this a Gateway payment still `received` is flagged for CZ-19 to re-poll (A2-26 says ≤ 16 min) |
| display currency | USD (D51) | USDC shown 1:1 as USD; no exchange-rate provider in Phase 1 |

### 6. Behaviour

- Step settles → row `settled` (or `pending` for Gateway) → objective closes → minutes split → statement refreshed → `report_outcome` arrives → minutes and status updated → CZ-24 reads positives/negatives.
- Refund or release → row `refunded` / `released`, cost 0, minutes 0.

### 7. AI usage

None.

### 8. Privacy

- `LedgerReceipt.merchantLabel` is the origin host only; the objective appears as its redacted title; no goal text beyond that; no addresses in statements. Classes: `server-only` rows, `public` amounts and tx hashes. Retention 1 year (spec 01 §11.1).

### 9. Security

- Read-only over money; no keys. Threat: a hijacked model cannot inflate ROI into a limit raise, because CZ-24 only counts acceptance-passed, user-not-rejected purchases.

### 10. Failure handling

| Failure | Behaviour | User sees |
|---|---|---|
| Gateway status never `completed` | stays `pending`; CZ-19 re-polls; after `roi.pendingMaxMinutes` an alert | "Paid, settling (up to 16 min)" then "Paid" |
| indexer lag | statements lag; `updatedAt` shown | "Updated 3 min ago" |
| conflicting `report_outcome` (two reports) | last report wins; both kept in `outcome_reports` | — |

### 11. Observability

- `czar_roi_receipts_total{rail,status}`, `czar_roi_pending_gateway_minutes` histogram. Logs carry ids and amounts only.

### 12. Interface wording

| Item | Wording |
|---|---|
| receipt line | "<objective title> · <step>: $0.10 · about 20 min saved" |
| pending Gateway | "Paid, settling (up to 16 min)" |
| monthly headline | "Czar saved you 14 hours for $9 this month." |
| unverified estimate note | "Time saved is Czar's estimate until you confirm it." |
| currency note | "Shown in USD; USDC counts 1:1 as USD." (D51; the local-currency wording is superseded, RV-047) |

### 13. Performance and cost

- O(receipts) per statement; no external calls (D51; the FX-source GAP is superseded, RV-047).

### 14. Tests and definition of done

- Unit: cost rules per rail and state; minutes split; factor application; statement totals equal the sum of rows.
- Integration: a full objective on `arc-anvil` with one of each rail produces the expected rows and a statement; a `report_outcome` with `minutesSavedActual` replaces the estimate.
- Definition of done: `listReceipts` and `getMonthlyStatement` return schema-valid objects; rebuild from projections is idempotent (same totals twice); wording in §12 appears in the app.

### 15. Dependencies

CZ-19 projections, CZ-12 outcome intake, OpenAPI schemas. No FX source in Phase 1 (D51, RV-047).

---

## CZ-27 Key management

> **Phase 1 hosting (D70, D78, D80):** the signer runs on Zaryab's Mac with backend `signer.backend = local-keystore` (§3). Every "KMS" reference below means "the configured signer backend"; parameter names keep the `kms.` prefix for continuity. Policies, rate limits, audit rows and the denied-selector list apply unchanged. `gcp-kms` is the stage-2 backend (`stage-2-backlog.md` §6). Keeping every server key on one Mac is an accepted, documented testnet exception (D80, §5.2 "Dual control").

### 1. Identity

| Item | Value |
|---|---|
| CZ ID, name | CZ-27, key management and signer service |
| Phase | 1 |
| Product | §10 trust and safety |
| Decisions | D25 (server signs only inside envelopes), D26 (passkeys for users), D30 (owner UserOps), D41 (owner-only manual pocket credit, so no server key can credit funds), D70, D71 (pocket leaves), D72 (freeze enforced off-vault), D78 (keystore location and passphrase), D80 (single-Mac custody) |
| Spec 01 | §7.2 key inventory K1–K20, assumption AR-1 (a KMS with secp256k1 and signing policies) |

### 2. Responsibilities and non-responsibilities

- **Does:** hold every server key behind the signer service: in Phase 1 an encrypted local keystore on Zaryab's Mac (D70, D78); in stage 2 Google Cloud KMS (D61 as amended; whether an HSM is required is decided at the pre-mainnet audit, AR-1), including the relayer gas key (D62); enforce per-key signing policies in the signer service, which checks the request shape before any key is used; keep K3, K7, K8 and the relayer funded with native gas within caps (§5.5, RV-017); create pocket keys and retire them only when every balance is zero (§5.3, RV-004); run rotation and compromise runbooks; log every signature.
- **Superseded by D70/D78 (RV-028):** "hold every server key in a cloud KMS" for Phase 1.
- **Does not:** hold user keys (K1 passkeys stay in the platform authenticator, D1-02); decide what to pay (CZ-15 does, inside the vault's rules); hold K14–K16 (device-side).

### 3. Runtime

- **Phase 1 (D70, D78):** `signer` is a local process on Zaryab's Mac, the only process that opens the keystore. Other local services call it over a Unix domain socket (`signer.socketPath`, mode 0600, owned by the user) with a per-service token from the macOS keychain; no TCP port. Stateless except its audit table (local Postgres) and rate counters.
  - **Keystore location (D78):** `signer.keystorePath` = `~/Library/Application Support/Czar/signer/keystore/` (directory 0700, files 0600), always **outside the repository**. The signer refuses to start if the resolved path is inside any git working tree (`git rev-parse --show-toplevel` succeeds from it) or is world- or group-readable.
  - **Passphrase (D78):** stored in the macOS keychain item `signer.keychainService` = `dev.czar.signer.keystore`, read by the signer process itself through `@napi-rs/keyring`. It is never passed on the command line, never in an environment variable, never in a file, and never logged. The config loader rejects any configuration key or `CZAR_*` environment variable whose name contains `passphrase`, `secret`, `private` or `mnemonic` (cross-cutting §3), so the env overlay cannot carry it.
  - **Keychain access (D80 hardening, unverified):** the keychain item's access list should name the signer's own executable rather than the generic `node` binary, so other Node processes run by the same user cannot read it. Whether `@napi-rs/keyring` sets a per-application ACL on macOS was not verified (review RV-045); T-035 checks it and records the result.
- **Stage 2:** the same service on Cloud Run with `signer.backend = gcp-kms` (secp256k1 keys with key policies, AR-1), reached over mTLS. If secp256k1 is unavailable, the AR-1 fallback in §6.
- **Superseded by D70/D78 (RV-028):** "a small service in `@czar/server`'s network segment … over mTLS … one replica per region" for Phase 1.

### 4. Interfaces

| Call (internal) | Caller | Returns |
|---|---|---|
| `sign(keyId, kind, payload)` where `kind ∈ {vault-call, usdc-3009, gateway-burn, sl-receipt, autonomy-raise, evaluator-call, sl-validation-report, oel-commit, merchant-seller-proof, relayer-tx, gas-refill, gateway-nano, pocket-delegate, pocket-return, pocket-slow-withdraw}` | the owning service identity only (§5.2) | 65-byte ECDSA signature or a signed transaction |
| `createPocketKey(planId)` / `retirePocketKey(pocket)` | CZ-13 (at planning, D71: the pocket address goes into the plan's `payeeRoot`) / CZ-15 | pocket address; `retirePocketKey` refuses unless §5.3's zero-balance rule holds |
| `getSecret(name)` for K11–K13, K17–K19 | the owning service | secret value in memory only |
| audit rows | CZ-16 of operations | — |

### 5. Internal design

#### 5.1 Key inventory and key types

| Key | Type | Owner service | Allowed signing kinds | Sends transactions (needs gas, §5.5) |
|---|---|---|---|---|
| K3 `agentSigner` | secp256k1 ECDSA | CZ-15 paying agent | `vault-call` (only `ICzarVault` selectors in the allowlist, to the caller's vault address, plan-checked, §5.2), `usdc-3009`, `gateway-burn`, `sl-receipt` (vault-bound `ReceiptAttestation`, RV-013) | yes: every agent-only vault call has K3 as `msg.sender` |
| K4 pocket keys (one per pocket, so one per envelope with a `gateway-nano` step) | secp256k1 ECDSA, created at planning (D71), retired only under §5.3 | CZ-15 | `gateway-nano`, `pocket-delegate`, `pocket-return`, `pocket-slow-withdraw` (§5.2); nothing else, in particular no `approve`, `permit` or `transfer` of USDC except the vault-return transfer (RV-055) | yes, from its own `grantPocketGas` grant |
| K5 `autonomySigner` | secp256k1 ECDSA | CZ-24 | `autonomy-raise` (02 §6.2 digest only). K5 **never sends transactions**: raises are relayed by the relayer key; the D60/D63 lowering and every automatic lowering are sent by K3 (RV-017) | no |
| K6 guardian | secp256k1 ECDSA, interactive confirmation (dual control in stage 2, D80) | ops | `pause`/`unpause` on `CzarVaultFactory` only | yes, rarely (funded once by hand) |
| K7 evaluator | secp256k1 ECDSA | CZ-16 evaluator | `evaluator-call`: `complete`/`reject` on the configured job escrow only; `sl-validation-report`: the SL `ValidationReport` digest signed as K7 itself (not through a vault) | yes |
| K8 publisher | secp256k1 ECDSA | CZ-17 | `oel-commit`: `commit`/`reveal` on `OpenEvidenceLog` only | yes |
| K9 claim relayer (P2) | secp256k1 ECDSA | CZ-21 | `scheduleRelease`/`executeRelease` on `BuilderEscrow` only | P2 |
| K10 merchant payout keys | secp256k1 ECDSA, one per service | CZ-20 | `merchant-seller-proof` (Facilitator `SellerRequest`, p1-F4), Gateway sweep burn intents with `destinationRecipient` = the treasury address | no |
| K11 Facilitator Console key | secret | CZ-20 | HTTPS header only | — |
| K21a, K21b test-provider keys (H7, N12) | secp256k1 ECDSA, one per instance | CZ-20 §5.11 | `provider-call`: `setBudget`/`submit` on the configured escrow; `BriefRequest` and `DeliverableUpload` signatures for its own jobs | testnet only; never a vault role |
| K12 Gateway API key (mainnet slot) | secret | CZ-15, CZ-20 | HTTPS header only | — |
| K13 GitHub OAuth secret (P2) | secret | CZ-21 | OAuth exchange only | — |
| K17 VAPID key | secret | CZ-23 (stage 2, D69) | push signing only; not created in Phase 1 | — |
| K18 model API keys | secret | CZ-13, CZ-16, Czar proxy for the daemon | model HTTPS only | — |
| K19 RPC provider keys | secret | CZ-19, relayer | RPC HTTPS only | — |
| K20 factory admin | secp256k1 ECDSA, interactive confirmation (dual control in stage 2, D80), timelocked on-chain | ops | `queueGuardian`, `queueDefaults`, ownership transfer on the factory only (`setDefaults`, `queueVersion` superseded by RV-015/D73) | yes, rarely (funded once by hand) |
| relayer gas key | secp256k1 ECDSA | relayer | `relayer-tx`: plain transactions that anyone may send — `raiseAutoLimit` with a K5 signature, `settle`, `finalize`, `confirmPullback`, `syncJob`, `claimJobRefund`, `closeEnvelope` after expiry, `GatewayMinter.gatewayMint`, `executeOwnerAction` (D30 fallback); `gas-refill` (§5.5). Never an agent-only, owner-only or guardian selector (they would revert `NotAgent`/`NotOwner` anyway; spec 01 §7.2 as amended by RV-017) | yes; balance capped at `kms.relayerMaxBalanceAtomic` |
| K1, K2, K14, K15, K16 | not in the signer | user device / app | K1 passkey (platform authenticator, D1-02); K2 Circle client key (app config, public-facing); K14 DB key, K15 device token, K16 hook token in the OS keychain (B6-17, B6-19) | — |

- All Phase 1 keys are created by task T-105 (M1, before the testnet deployment, RV-016), except K4 (per plan) and K10 (by the merchants task).

#### 5.2 Signer policy (what a key store cannot check)

A key store signs any 32-byte digest it is asked to sign; it cannot see that a digest is a USDC authorization to the wrong payee. So the policy lives in the `signer` service, which rebuilds every digest from structured fields and refuses anything else. **Freeze state (D72):** every kind marked "spends" below first reads the vault's `frozen` flag and the factory's `guardianPaused` from the CZ-19 projection; if either is set, or the projection's view of them is older than `signer.freezeStateMaxAgeSec` (30 s), the request is denied (`kms_denied: frozen`). Fail closed.

| Kind | Spends? | Request shape the signer requires | Checks before signing |
|---|---|---|---|
| `vault-call` (K3) | for the spending selectors | `{vault, selector, args}` | `vault ∈ vaults from the factory projection`; `selector` in the K3 allowlist: `openEnvelope`, `reserve`, `reserveWithDigests`, `settle`, `finalize`, `registerPocket`, `grantPocketGas`, `fundPocket`, `requestPullback`, `confirmPullback`, `cancelPullback`, `writeOffPocket`, `openJob`, `fundJob`, `syncJob`, `claimJobRefund`, `closeEnvelope`, `lowerAutoLimit`, `freeze`. **Never signable for K3:** `withdraw`, `unfreeze`, `rotateSigners`, `setCategoryLimits`, `setPasskey`, `recordManualReturn`, `forceCloseEnvelope`, `setMaxPullbackFee`, `raiseAutoLimit`, `executeOwnerAction`, any factory selector, any selector not in the allowlist (RV-055). Args are ABI-encoded by the signer, not by the caller. **Plan checks (RV-032):** `openEnvelope` args must equal a stored `Plan` (`planHash`, `payeeRoot`, `cap`, `maxStepAmount`, `pocketCapBps`, `expiresAt`, `category`) whose approval state is `auto-approvable` (no payee outside the user's previously approved payees, `planner.newPayeeNeedsApproval`) and whose `pocketCapBps` follows D71; `reserve`/`openJob`/`registerPocket` args must be a leaf of the envelope's stored plan with that step's `expectedCalls` not used up; `writeOffPocket` is denied while the pocket has an open slow withdrawal (§5.3, RV-004). The spending selectors (`reserve*`, `registerPocket`, `grantPocketGas`, `fundPocket`, `openJob`, `fundJob`, `openEnvelope`) apply the freeze check |
| `usdc-3009` (K3) | yes | `{vault, reservationId, index, to, value, validBefore}` | the signer reads the reservation from the CZ-19 projection: `to == payee`, `value == unitAmount` (RV-035), `index < count`, `validBefore` equal; recomputes `nonce` (02 §7.2) and the digest with `USDC_DOMAIN_SEPARATOR` (02 §6.1); only then signs; returns the 02 §6.3.1 envelope (or 65 bytes in `digest` mode) |
| `gateway-burn` (K3) | no (money returns to the vault) | `{vault, pullbackId}` | reads `PullbackRecord` from the projection (`Pending`, `block.number ≤ maxBlockHeight`); rebuilds the `BurnIntent` digest exactly as 03 `czar-vault.md` §6.2 (recipient = vault); signs; returns the 02 §6.3.2 envelope. Allowed while frozen (D72 pullbacks) |
| `sl-receipt` (K3) | no | `{vault, receipt: SlReceipt}` (the 13 SL `Receipt` fields) | rebuilds the `Receipt` struct hash from the fields; requires `receipt.paymentRefHash` to equal the `paymentRefHash` of a payment of **this vault** that the indexer has seen settled (`Settled` event, Gateway `completed`, or job `Completed`); signs the vault-bound `ReceiptAttestation` digest under that vault's `CzarVault` domain (02 §6.3.3, RV-013). An opaque `structHash` is refused |
| `autonomy-raise` (K5) | no | `{vault, categoryId, newLimit, periodId, deadline}` | vault not frozen; `newLimit > autoLimit`, `newLimit ≤ userMax` and the D40 step from the projection; at least `PERIOD_LENGTH` since `lastRaiseAt`; nonce from the vault; digest per 02 §6.2 |
| `evaluator-call` (K7) | `complete`: yes; `reject`: no | `{escrow, jobId, decision, reportHash}` | `escrow` is the configured instance; `jobKey` exists in the projection with `evaluator == K7 address`; `reportHash` (or a `czar:` reason tag: `unfunded-submit`, `deliverable-missing`, `fees-changed`, `late`, `owner-froze`) exists in CZ-16's table; for `complete`, the client vault must not be frozen or paused (D72); **a `reject` is always signed, whatever the vault's freeze or pause state, because it only refunds the vault (N8, D87)** |
| `sl-validation-report` (K7) | no | `{report fields}` | rebuilds the SL `ValidationReport` digest; `checksCommit` exists in CZ-16's table |
| `oel-commit` (K8) | no | `{kind, root, prev, uriHash, uri}` | `prev` equals the publisher's latest root in the projection; `root` exists in `EvidenceBatch` rows; `uri` matches `czar-archive:<root>` (D78) |
| `merchant-seller-proof` (K10) | no | `{service, purpose, method, bodyHash, network, nonce, expiry}` | 5-minute expiry; `network` is the configured chain (p1-F4) |
| `gateway-nano` (K4) | yes | `{pocket, payTo, amount, validBefore, nonce}` | `pocket` is `Funded`/`Draining` for an `Open` envelope; vault not frozen or paused (D72); `payTo` is a kind-1 leaf payee of a `gateway-nano` step of that envelope's plan; cumulative per step ≤ that step's `stepCap`; cumulative per pocket ≤ `funded` |
| `pocket-delegate` (K4) | no | `{pocket, vault}` | one `GatewayWallet.addDelegate(USDC, vault)` transaction, where `vault` is the pocket's owning vault |
| `pocket-return` (K4, RV-004) | no | `{pocket, kind: usdc \| native, amount}` | either `USDC.transfer(owningVault, amount)` with `amount ≤` the pocket EOA's ERC-20 balance, or a plain native send of `amount` to `owningVault` (which has `receive()`); the destination is always the pocket's own vault, never caller-supplied |
| `pocket-slow-withdraw` (K4) | no | `{pocket, step: initiate \| withdraw, value?}` | `GatewayWallet.initiateWithdrawal(USDC, value)` or `withdraw(USDC)` only, and only after the Gateway API has been unreachable for `payer.pullbackApiDownHours` (CZ-15) or the owner asked for it in the app; `withdraw` pays the pocket EOA, so a `pocket-return` transfer follows at once |
| `relayer-tx` (relayer) | no | `{to, selector, args}` | `(to, selector)` in the relayer allowlist (§5.1 row); value 0 |
| `provider-call` (K21a/K21b) | no | `{escrow, jobId, action: setBudget \| submit \| brief-request \| deliverable-upload, args}` | `escrow` is the configured instance; the job's `provider` is this key; `submit` only with a `contentHash` already accepted by `uploadJobDeliverable`; never signs for a job whose evaluator is not K7 |
| `gas-refill` (relayer) | no | `{target, amount}` | `target ∈ {K3, K7, K8}` addresses; `amount ≤ signer.gas.<key>.maxAtomic − balance(target)` (§5.5) |

- Per-key rate limits: `kms.maxSignaturesPerMin` per key (K3 600, K4 120 per pocket, K5 10, K7 60, K8 10, K10 300, relayer 120); excess is denied and alerted.
- **Dual control (D80):** in stage 2, K6 and K20 requests need two approver identities within `kms.dualControlWindowMinutes` (30). In Phase 1 there is one person and one Mac, so dual control cannot be met; instead every K6/K20 request needs an interactive confirmation in the signer CLI (Zaryab types the action and the target address; the macOS keychain prompts for the login password) and raises an alert. A compromise of the Mac yields every server key at once; this is the accepted testnet exception (D80), bounded by testnet-only funds and listed in `stage-2-backlog.md` §6.
- Every signature writes an audit row: key id, kind, digest, purpose ids (`envelopeRef`, `reservationId`, `pullbackId`, `jobKey`, `batchId`), caller identity, outcome. No raw text, no payloads.
- The signer holds keys only in memory after unlocking the keystore; no other process can read the keystore passphrase (§3).

#### 5.3 Pocket-key lifecycle (K4)

```mermaid
stateDiagram-v2
  [*] --> Created: createPocketKey(planId) at planning; address goes into the plan's payeeRoot as a kind-4 leaf (D71)
  Created --> Discarded: plan never approved (key held no funds) · retirePocketKey
  Created --> Registered: CZ-15 calls registerPocket(envelopeId, pocket, proof) with K3
  Registered --> GasGranted: grantPocketGas (K3)
  GasGranted --> DelegateSet: pocket-delegate tx (K4) · DelegateAdded
  DelegateSet --> Funded: fundPocket (K3) after isAuthorizedForBalance check
  Funded --> Paying: gateway-nano authorizations signed by K4 (refused while frozen, D72)
  Paying --> Draining: requestPullback (K3); burn intent signed by K3 as the vault (never K4)
  Draining --> Closed: writeOffPocket (K3, no pending pullback) or forceCloseEnvelope (owner) · PocketClosed
  Closed --> Sweeping: recovery pullbacks for any Gateway balance; pocket-return for EOA USDC and native gas
  Sweeping --> Retired: every balance zero for signer.pocketKeyRetainHours · retirePocketKey
  Retired --> [*]
```

- `confirmPullback` never closes a pocket; only `writeOffPocket` and `forceCloseEnvelope` do (RV-049; the earlier diagram edge "confirmPullback → Closed" is superseded).
- **Retirement rule (RV-004):** `retirePocketKey` destroys K4 only when all of these read zero: the Gateway API balance for the pocket (`/v1/balances`), on-chain `GatewayWallet.availableBalance(USDC, pocket)` and `withdrawingBalance(USDC, pocket)` (`Balances.sol` lines 60, 69 at `c21d2d2`), the pocket EOA's USDC balance; no `Pending` pullback; no slow withdrawal open; and native balance below `signer.pocketDustAtomic` (the cost of one more sweep). Then the key is kept a further `signer.pocketKeyRetainHours` (24) and destroyed. A slow withdrawal keeps the key for at least `withdrawalDelay` (1,209,600 blocks ≈ 7 days) plus `signer.slowWithdrawMarginHours` (24). **Superseded by RV-004:** "destroyed after `PocketClosed` and `kms.pocketKeyGraceHours` (48), unless the pocket closed with `outstanding = 0`".
- **Threat note (RV-063):** a leaked K4 can sign a Gateway burn intent from the pocket to **any** recipient (`Burns.sol` lines 332–333), and on-chain a revoked delegate's intents still pass `_wasEverAuthorizedForBalance`, including intents signed after revocation (`Delegation.sol` lines 100–128, 153–164); only Circle's API refuses them. So a leaked K4 can move the pocket's whole Gateway balance, not only nanopayments. The bound is the pocket balance (≤ 25% of one envelope, D22), which is why pockets stay small and short-lived. **Superseded:** "a leaked K4 can spend only nanopayments and the slow withdrawal".
- The slow path (`pocket-slow-withdraw`, A2-13 to A2-15) runs when Circle's API has been down for `payer.pullbackApiDownHours` or the owner asks; the withdrawn USDC lands in the pocket EOA and K4 at once returns it with `pocket-return`; the owner then credits it with `recordManualReturn` (D41) if the pocket is still open. `writeOffPocket` is refused while the slow withdrawal is open.

#### 5.4 Parameters

| Parameter | Default | Reason |
|---|---|---|
| `signer.backend` | `local-keystore` (Phase 1); `gcp-kms` (stage 2) | D70 (RV-028: was missing from the tables) |
| `signer.keystorePath` | `~/Library/Application Support/Czar/signer/keystore/` | D78: outside the repository |
| `signer.keychainService` | `dev.czar.signer.keystore` | D78: passphrase only in the macOS keychain |
| `signer.socketPath` | `~/Library/Application Support/Czar/signer/signer.sock` | local IPC, no TCP port |
| `signer.freezeStateMaxAgeSec` | 30 | D72: freeze checks fail closed on a stale projection |
| `kms.maxSignaturesPerMin.K3` | 600 | ten reservations a second across all users is far above Phase 1 load |
| `kms.maxSignaturesPerMin.K4` | 120 per pocket | nanopayment bursts |
| `kms.maxSignaturesPerMin.K5` / `K7` / `K8` / `K10` / `relayer` | 10 / 60 / 10 / 300 / 120 | by expected volume |
| `kms.dualControlWindowMinutes` | 30 | stage 2 only (D80) |
| `signer.pocketKeyRetainHours` | 24 | keep K4 one more day after every balance reads zero (RV-004) |
| `signer.slowWithdrawMarginHours` | 24 | margin over Gateway's 7-day `withdrawalDelay` |
| `signer.pocketDustAtomic` | 500 (0.0005 USDC) | native balance below the cost of another sweep counts as zero |
| `kms.pocketKeyGraceHours` | — | superseded by the three rows above (RV-004) |
| `kms.relayerMaxBalanceAtomic` | 50000000 (50 USDC) | bounds gas-key loss |
| `signer.gas.K3.minAtomic` / `targetAtomic` / `maxAtomic` | 500000 / 2000000 / 5000000 (0.5 / 2 / 5 USDC) | §5.5; ≈ 0.003–0.006 USDC per agent transaction at 20 Gwei, so 2 USDC is ≥ 300 transactions |
| `signer.gas.K7.*` | 100000 / 500000 / 1000000 | §5.5; `complete`/`reject` ≈ 0.002 USDC each |
| `signer.gas.K8.*` | 100000 / 500000 / 1000000 | §5.5; ≈ 0.07 USDC per day of commits (03 `open-evidence-log.md` §13) |
| `kms.auditRetentionDays` | 365 | spec 01 §16.3 |

#### 5.5 Gas for keys that send transactions (RV-017)

- The vault checks `msg.sender == agentSigner` (and the escrow checks `msg.sender == evaluator`, the log uses `msg.sender` as publisher), so these calls cannot go through the relayer: K3, K7 and K8 each pay their own gas in native USDC. **Superseded by RV-017:** spec 01's "server calls to the vault pay gas from Czar's relayer in USDC".
- **Balances:** each of K3, K7, K8 holds native USDC between `signer.gas.<key>.minAtomic` and `maxAtomic`. K5 sends no transactions (§5.1). K6 and K20 are funded once by hand with ≤ 0.1 USDC each.
- **Refill:** a `gas-refill` job runs every 5 minutes: for each key below `minAtomic`, the relayer key sends `targetAtomic − balance` (a `gas-refill` signature), never pushing a key above `maxAtomic`. The relayer itself is topped up by Zaryab from the testnet faucet; that is a funded-testnet step and needs his approval each time (AGENTS.md, Gate 0).
- **Alerts:** `czar_signer_gas_low{key}` when a key is below `minAtomic` after a refill attempt, and when the relayer is below the sum of all `targetAtomic`; CZ-15 pauses new reservations when K3 cannot pay for the next transaction ("Waiting on payment network") instead of failing mid-objective.
- **Bound:** a stolen K3, K7 or K8 can burn at most its `maxAtomic` in gas; the relayer cap bounds the total.

### 6. Behaviour

- **Signing:** service → `sign(...)` over mTLS → shape check → digest rebuilt → rate limit → KMS → audit → return. A failed check returns `kms_denied` with the rule name; nothing is signed.
- **Rotation runbooks:**

| Key | Runbook |
|---|---|
| K3 | create the new key; queue it as the factory default (`queueDefaults`, K20, 48 h timelock, RV-015) for new vaults; for existing vaults the app prompts each owner to run `rotateSigners` (UserOp); the signer accepts both keys until `kms.rotationOverlapDays` (14) end; old key disabled |
| K4 | per pocket; retired only under the §5.3 zero-balance rule (RV-004) |
| K5 | same as K3 (owner `rotateSigners`) |
| K7 | new key for new jobs; open jobs keep the old key until they close (jobs name the evaluator at creation, 03 `job-escrow-adapter.md` §5) |
| K8 | announce with a `POLICY_RELEASE` commit under the old publisher naming the new address (03 `open-evidence-log.md`); readers choose publishers |
| K9 (P2) | admin rotates the relayer role on `BuilderEscrow`; pending releases stay cancellable |
| K10 | new `payTo`; update the index entries and 402s; sweep the old Gateway balance |
| K11, K12 | Circle Console; overlap one day |
| K13 | GitHub app settings |
| K17 | new VAPID key; clients resubscribe on next open |
| K18, K19 | provider consoles; secrets rotated in the store |
| K14–K16 | device-side: the daemon re-keys the DB (`K14`), the app revokes and re-pairs (`K15`), the plugin regenerates the hook token (`K16`) |
| K6, K20 | factory `queueGuardian` (48 h timelock) / Ownable2Step transfer; interactive confirmation in Phase 1, dual control in stage 2 (D80) |

- **Compromise response:** suspected K3 or server breach → guardian `pause()` (K6; interactive confirmation in Phase 1, dual control in stage 2, D80; drill quarterly) → the signer stops every spending kind including pocket nanopayments and evaluator `complete` (D72) → CZ-15 requests pullbacks for every funded pocket → app shows the §12 banner → rotate K3 per runbook → unpause. Suspected K4 → `requestPullback` immediately; the attacker can burn the pocket's balance to any address (§5.3 threat note), so the loss is bounded by that balance; write off what does not come back. A compromise of the Mac in Phase 1 exposes every server key together (D80); the bound is testnet funds. Suspected K8 → `POLICY_RELEASE` naming a new publisher. User-level: `freeze()` by the owner or agent any time.
- **AR-1 fallback:** if no KMS offers secp256k1 with policies, the signer service holds software keys in an isolated network segment with disk encryption, the same policy code, and no inbound access except mTLS from Czar services; this is a weaker boundary and is listed as a risk until an HSM is in place.

### 7. AI usage

None.

### 8. Privacy

- Audit rows hold digests, ids and amounts only (`server-only`). No user text ever reaches the signer.

### 9. Security

- Keys: all of K3–K13, K17–K20 (holder), K14–K16 (documented, device-side).
- Threats (spec 01 §13): server compromised → the signer refuses out-of-shape requests, checks K3's envelope and reservation arguments against stored plans (RV-032), and rate-limits, so even a hijacked CZ-15 cannot sign a USDC digest to a non-payee or open an envelope for an unapproved payee set; agent key leak → rotation runbook plus guardian pause (the vault's per-step and per-envelope caps still bind, INV-1, INV-12); pocket key leak → the whole pocket balance (any recipient, §5.3), bounded by the pocket cap; evaluator key leak → bounded by open job budgets; publisher key leak → no funds, detectable by recompute; Mac compromise in Phase 1 → every server key (D80).
- The vault remains the final boundary; the signer is defence in depth (03 `security-and-testing.md` §1).

### 10. Failure handling

| Failure | Behaviour |
|---|---|
| key store unavailable (keystore locked, keychain denied) | all signing stops; CZ-15 pauses plans ("Waiting on payment network"); reservations expire safely (03 `czar-vault.md` §10) |
| freeze state unknown or stale (> `signer.freezeStateMaxAgeSec`) | every spending kind denied until the projection catches up (D72) |
| a key's gas below `minAtomic` and the relayer cannot refill | alert; CZ-15 stops starting reservations; nothing half-done |
| signer policy denies a legitimate request | logged with the rule; on-call reviews; never bypassed by a flag |
| projection stale (reservation not yet indexed) | `usdc-3009` denied until the `Reserved` event is indexed; CZ-15 retries with backoff `kms.projectionRetryMs` (500, ×5) |
| rate limit hit | denied, alert; CZ-15 backs off |

### 11. Observability

- `czar_signer_signatures_total{key,kind,outcome}`, `czar_signer_denied_total{key,rule}`, latency histogram. Alert on any denial for K6/K20, any K3 denial rate > `kms.denyAlertPerMin` (5), KMS errors.

### 12. Interface wording (ops console and app banners)

| State | Wording |
|---|---|
| guardian pause (app banner) | "Czar paused all spending while we check something. Your money is safe in your vault. You can still withdraw." |
| after unpause | "Spending is back on. Czar signed no new payments while paused." (D72: the signer refuses every spending kind while paused. Payments signed before the pause could still settle, so the earlier wording "Nothing was spent while paused" is superseded, RV-007.) |
| key rotation prompt (app) | "Czar updated its signing key. Approve the update so objectives can keep running." |

### 13. Performance and cost

- Signing latency target ≤ 150 ms including the KMS round trip (`kms.signTimeoutMs` 2000). KMS request costs are a few dollars per million; negligible at Phase 1 volume.

### 14. Tests and definition of done

- Policy unit tests: for every kind, one accepted request and one denied per rule (for example a `usdc-3009` request with `to` outside the reservation, `value > unitAmount`, `index ≥ count`; a `vault-call` to `withdraw`; a `gateway-burn` for a `Cancelled` pullback; an `evaluator-call` for a job whose evaluator is another address).
- Replay: the 02 §6.4 test vectors reproduce through the signer (digest equality before signing).
- Rotation drills: K3 overlap window; K4 destroy after `PocketClosed`; K7 new-jobs-only.
- Compromise drill: guardian pause on `arc-anvil` blocks every spending digest (INV-4), the signer refuses `gateway-nano` and `evaluator-call complete` (D72), CZ-15 requests pullbacks for funded pockets, and the app shows the §12 banner.
- Named tests (RV fixes; also listed in 03 `security-and-testing.md` §3.8): `signer_gatewayNano_whileFrozen_denied`, `signer_evaluatorComplete_whilePaused_denied`, `signer_evaluatorReject_whileFrozen_allowed` (D72, RV-007); `signer_slReceipt_unsettledPayment_denied`, `signer_slReceipt_opaqueStructHash_denied` (RV-013); `signer_openEnvelope_argsNotMatchingStoredPlan_denied`, `signer_reserve_leafNotInPlan_denied` (RV-032); `signer_k3_neverSignableSelectors_denied` for every selector in the never list (RV-055); `signer_k4_usdcApproveOrTransferElsewhere_denied`, `signer_k4_returnToOwningVault_allowed` (RV-004, RV-055); `signer_retirePocketKey_nonZeroBalance_refused` (RV-004); `signer_writeOff_duringSlowWithdraw_denied` (RV-004); `signer_gasRefill_aboveMax_denied`, `gasRefill_keepsK3K7K8WithinBounds` (RV-017); `signer_k5_sendTransaction_denied` (RV-017); `signer_keystoreInsideRepo_refusesStart`, `signer_passphraseFromArgvOrEnv_rejected` (D78, RV-028).
- Definition of done: no service other than the signer can open the keystore (or reach the KMS in stage 2); every signature has an audit row; K6/K20 need an interactive confirmation in Phase 1 (dual control in stage 2, D80); all drills documented.

### 15. Dependencies

Phase 1: the local keystore and the macOS keychain through `@napi-rs/keyring` (D70, D78); stage 2: Google Cloud KMS and mTLS (D61 as amended, AR-1). `@czar/vault-client`, `@czar/hashing`, CZ-19 projections (including the freeze state, D72). HSM vs KMS is decided at the pre-mainnet audit (D61); the relayer gas key is in the configured signer backend (D62 as amended by D70).

---

## Mainnet differences (all three components)

| Topic | Testnet | Mainnet |
|---|---|---|
| Keys | one set per environment, in the local keystore on one Mac (D80); testnet K3/K5/K7/K8 never reused on mainnet | separate Cloud KMS keys, dual control on K6/K20 from day one |
| Gateway API key | none needed (A2-30) | K12 slot filled |
| Facilitator | keyless trial (p1-F4) | K11 Console key |
| Autonomy defaults | `autonomy.baseAtomic` 0.50 USDC | re-tuned after measured outcomes; same D40 bounds |
| ROI amounts | testnet USDC labelled as such in the app | real money; still USD unless local currency is added later (D51) |
| Relayer balance cap | 50 USDC testnet | reviewed with real gas measurements |

## Change log

| Date | ID | Change |
|---|---|---|
| 2026-10-18 | D51 | USD only; `app.fxSource` removed |
| 2026-10-18 | D60 | freeze lowering via `lowerAutoLimit` stated precisely |
| 2026-10-18 | D61, D62 | cloud KMS with signer service; relayer gas key in KMS; HSM decided at pre-mainnet audit |
| 2026-10-19 | D63 | freeze lowering stated as a follow-up agent step, not atomic. |
| 2026-10-19 | D69 | K17 VAPID key is stage 2 with CZ-23. |
| 2026-10-19 | D69 | raise notice is shown in the app (no push in Phase 1). |
| 2026-10-19 | D70 | Phase 1 runs on Zaryab's Mac with a local software signer (encrypted keystore); Google Cloud (KMS, Cloud Run, e2-micro VM) moves to stage 2. |
| 2026-10-19 | RV-004 | K4 `pocket-return` and `pocket-slow-withdraw` kinds; zero-balance retirement rule replaces `kms.pocketKeyGraceHours`; recovery pullbacks; `writeOffPocket` refused during a slow withdrawal (SCR-004). |
| 2026-10-19 | RV-007 / D72 | freeze and guardian pause enforced by the signer for `gateway-nano` and evaluator `complete`; pullbacks on freeze; unpause wording narrowed (SCR-007). |
| 2026-10-19 | RV-013 | `sl-receipt` takes receipt fields, checks a settled payment, signs the vault-bound `ReceiptAttestation`; K7 uses `sl-validation-report` (SCR-013). |
| 2026-10-19 | RV-015 | K20 kinds: `queueGuardian`, `queueDefaults`; K3 rotation uses `queueDefaults`. |
| 2026-10-19 | RV-016 | Phase 1 keys created by T-105 before T-027. |
| 2026-10-19 | RV-017 | §5.5 gas for K3, K7, K8 with caps, refill job and alerts; K5 sends no transactions; relayer allowlist restated (SCR-017). |
| 2026-10-19 | RV-028 / D78 | §2, §3, §15 rewritten for the local keystore: path outside the repo, passphrase only in the keychain, `signer.backend` and related parameters (SCR-028). |
| 2026-10-19 | RV-032, RV-055 | `vault-call` checks K3 arguments against stored plans; full never-signable list. |
| 2026-10-19 | RV-045 / D80 | single-Mac custody stated as an accepted testnet exception; interactive confirmation for K6/K20 in Phase 1; keychain ACL hardening noted (unverified). |
| 2026-10-19 | RV-049, RV-063 | pocket diagram: `confirmPullback` never closes a pocket; leaked-K4 threat text corrected. |
| 2026-10-19 | RV-047 | CZ-25 leftover local-currency and FX text removed (D51). |
| 2026-10-20 | N8, D87 | K7 `reject` always signable; reason tags listed. |
| 2026-10-20 | H7, N12 | K21a/K21b test-provider keys and the `provider-call` policy. |
