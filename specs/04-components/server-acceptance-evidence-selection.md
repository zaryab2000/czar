# Server: acceptance, evidence, Selection Layer, indexer (spec 04)

- **Date:** 2026-10-18. **Status:** draft for review. Conventions: `cross-cutting.md`. Data shapes: spec 02 only (cited "02 §n", schema files by name, OpenAPI `operationId`s). Contract behaviour: spec 03 only (cited "03 `<file>` §n").
- **Components:** CZ-16 acceptance checker and ERC-8183 evaluator; CZ-17 evidence producer and publisher; CZ-18 Selection Layer services; CZ-19 indexer. All run in `apps/server` (CZ-19 in `apps/indexer`).
- **Reading order:** CZ-19 first (everything else reads its projections), then CZ-16, CZ-17, CZ-18.
- **Status wording:** Czar is a production system that moves user funds.

---

## CZ-19 Indexer

### 1. Identity

| Item | Value |
|---|---|
| CZ ID, name | CZ-19, Indexer |
| Phase | 1 |
| Product / roadmap | supports §6.8 envelopes, §6.11 ROI ledger, §6.22 proof of demand; roadmap 2.1, 2.6, 2.13 |
| Decisions | D11, D13, D22, D25, D27 |
| Package | `@czar/indexer` (`apps/indexer`), Ponder 0.18.x (A9-05) |

### 2. Responsibilities and non-responsibilities

- **Does:** read every relevant Arc event, maintain the server's mirrors (02 §4.8–§4.11) plus `settlements` and `anchors`, poll the Gateway API for off-chain nanopayment status, raise alerts (`Upgraded`, lag, anomalies), and serve the queries in §4.
- **Does not:** sign anything, call any contract function that changes state, hold keys, or decide money. The vault is the source of truth; the indexer is a cache that can always be rebuilt (spec 01 §16.1).

### 3. Runtime

- One Ponder process per network (`testnet` in Phase 1), with its own Postgres schema `idx_<network>`. Restarts re-sync from Ponder's checkpoint. Update = deploy a new image; a schema change triggers a full re-index from `indexer.startBlock` (the factory deployment block).
- Resource budget: one small container; Arc testnet emits ~0.5 s blocks (p1-A7), so steady state is a few RPC calls per second.

### 4. Interfaces

| Direction | What | Reference |
|---|---|---|
| In (chain) | `eth_getLogs` pages ≤ `indexer.getLogsBlockRange` blocks; `eth_getBlockByNumber`; `eth_call` for views (`authorizationState`, `isTransferSpecHashUsed`, `getJob`/`jobs`) | A9-06; 03 `czar-vault.md` §10 |
| In (Circle) | `GET https://gateway-api-testnet.circle.com/v1/x402/transfers?from=<pocket>&pageSize=100` (keyless on testnet) | A2-29, A2-30, p1-G10 |
| Out (projections, read by CZ-12, CZ-15, CZ-16, CZ-17, CZ-22) | `Envelope`, `Reservation`, `PocketRecord` (with `PullbackRecord`), `JobRecord`, `settlements`, `anchors`, `alerts` | 02 §4.8–§4.11, §4.20 |
| Out (queries) | listed in §5.4 | |
| Out (alerts) | `alerts` table rows plus a webhook to the on-call channel | spec 01 §16.2 |

Events consumed (all with `indexed` fields as defined in the cited specs):

| Contract (pinned) | Events | Reference |
|---|---|---|
| `CzarVaultFactory` | `VaultCreated`, `GuardianPaused`, `GuardianUnpaused`, `VersionApplied`, `GuardianChanged` | 03 `czar-vault-factory.md` §7 |
| every `CzarVault` (address set grows from `VaultCreated`) | `EnvelopeOpened`, `EnvelopeClosed`, `EnvelopeForceClosed`, `Reserved`, `Settled`, `Released`, `ReservationFinal`, `PocketRegistered`, `PocketGasGranted`, `PocketFunded`, `PullbackRequested`, `PullbackConfirmed`, `PullbackCancelled`, `PocketClosed`, `ManualReturnRecorded`, `JobOpened`, `JobFunded`, `JobSynced`, `JobRefunded`, `LimitsSet`, `AutoLimitRaised`, `AutoLimitLowered`, `Frozen`, `Unfrozen`, `SignersRotated`, `PasskeySet`, `OwnerActionExecuted`, `Withdrawn`, `BalanceSynced`, `NativeReceived` | 03 `czar-vault.md` §9.1 |
| USDC `0x3600…0000` and the EIP-7708 system emitter `0xffff…fffe` | `Transfer(from, to, value)` where `from` or `to` is a known vault, pocket or Czar merchant payout address; `AuthorizationUsed(authorizer, nonce)` where `authorizer` is a known vault | A1-18, SL-F4 (native amounts are 18-decimal and are divided by `10^12`, A1-05) |
| GatewayWallet `0x0077…19B9` (mainnet `0x7777…00eE`) | `Deposited(token, depositor, sender, value)`, `DelegateAdded`, `DelegateRemoved`, `BatchProcessed(batchId, signer, token)` | A2-02, A2-04, A2-27 |
| GatewayMinter `0x0022…475B` (mainnet `0x2222…C205`) | `AttestationUsed(token, recipient, transferSpecHash, sourceDomain, sourceDepositor, sourceSigner, value)` where `recipient` is a known vault | 02 §6.3.2; Gateway `Mints.sol` lines 47–55 (read in spec 02 session) |
| ERC-8183 Circle instance `0x0747…4583` (later `CzarJobEscrow`) | `JobCreated`, `BudgetSet`, `JobFunded`, `JobSubmitted`, `JobCompleted`, `JobRejected`, `JobExpired`, `PaymentReleased`, `Refunded`, `EvaluatorFeePaid`, plus admin events `RoleGranted`, `RoleRevoked`, `HookWhitelistUpdated`, and on the Czar instance `PlatformFeeUpdated`, `EvaluatorFeeUpdated`, `PaymentTokenAllowlistUpdated`, `Paused`, `Unpaused`, `EmergencyWithdraw` | 03 `job-escrow-adapter.md` §2; A4-06 to A4-09 |
| `OpenEvidenceLog` | `Committed(publisher, kind, seq, root, prev, uriHash, uri)`, `Revealed(...)` | 03 `open-evidence-log.md` §8 |
| every pinned proxy: USDC, GatewayWallet, GatewayMinter, ERC-8183, ERC-8004 Identity/Reputation/Validation | `Upgraded(address implementation)` | FD-18; A1-01, A2-20, A4-09, A5-11 |

### 5. Internal design

#### 5.1 Chain configuration

- Ponder `createConfig({ chains: { arcTestnet: { id: 5042002, rpc: [primary, keyed fallback], pollingInterval, ethGetLogsBlockRange } } })` (A9-05 names these keys). Primary `https://rpc.testnet.arc.io` (A9-08), fallback a keyed provider from the Arc docs list (A9-07). `rpc.testnet.arc.network` is never configured (A9-08).
- `indexer.getLogsBlockRange = 9999` blocks: Arc caps `eth_getLogs` at 10,000 (A9-06, error `-32012`).
- `-32014` ("safely retry", A9-06): exponential backoff `indexer.rpcRetryBaseMs` 250 ms, up to `indexer.rpcRetryMax` 6, then fail over to the keyed provider for `indexer.failoverHoldSeconds` 300.
- Finality: Arc is final on inclusion (p1-A7 "Final on inclusion"; SL-F2). No reorg window. `indexer.confirmationBlocks = 1` is kept as a cheap guard against provider lag and is re-checked on mainnet in the pre-mainnet checklist (03 `security-and-testing.md` §5).

#### 5.2 Sync state machine

```mermaid
stateDiagram-v2
  [*] --> Backfill: start from checkpoint or indexer.startBlock
  Backfill --> Backfill: page ≤ 9,999 blocks · -32012 → halve range · -32014 → retry
  Backfill --> Live: head reached (lag ≤ indexer.maxLagBlocks)
  Live --> Live: poll head · apply events · poll Gateway API
  Live --> Lagging: lag > indexer.maxLagBlocks
  Lagging --> Live: caught up
  Lagging --> Failover: lag > 2 × indexer.maxLagBlocks or RPC errors > indexer.rpcErrorAlertPerMin
  Failover --> Live: fallback provider healthy
  Live --> Halted: Upgraded on a pinned proxy → path flag set, page on-call
  Halted --> Live: operator clears the halt after review
```

- `Backfill`: deterministic; the same events always rebuild the same projections.
- `Halted` affects only the flagged path (`paths.vaultDirectHalted`, `paths.pocketHalted`, `paths.jobsHalted` in the server's runtime flags); other paths continue.

#### 5.3 Projections (tables)

| Table | Key | Built from | Serves |
|---|---|---|---|
| `vaults` | `vault` | `VaultCreated` | owner lookup, address set for filters |
| `envelopes` (02 §4.8 fields) | `(vault, envelopeId)` | `EnvelopeOpened`, `Settled`, `Released`, `PocketFunded`, `PullbackConfirmed`, `PocketClosed`, `JobFunded`, `JobSynced`, `JobRefunded`, `EnvelopeClosed`, `EnvelopeForceClosed` | `getEnvelope`, `listEnvelopes`, CZ-15 |
| `reservations` (02 §4.9) | `(vault, reservationId)` | `Reserved`, `Settled`, `Released`, `ReservationFinal`; `settledMask`/`doneMask` from per-index events | CZ-15 settle/finalize work queue |
| `pockets` (02 §4.10) + `pullbacks` | `pocket`, `(vault, pullbackId)` | `PocketRegistered`, `PocketGasGranted`, `PocketFunded`, `PullbackRequested`, `PullbackConfirmed`, `PullbackCancelled`, `PocketClosed`, `ManualReturnRecorded`; `AttestationUsed` matched by `transferSpecHash` | pullback confirm queue, ledger |
| `jobs` (02 §4.11) | `jobKey` | `JobOpened`, `JobFunded`, `JobSynced`, `JobRefunded` plus escrow events matched by `(jobEscrow, jobId)` | CZ-16 evaluator queue, CZ-15 sync queue |
| `settlements` | `(rail, network, payer, payTo, nonce)` (SL `dedup_key`) | `AuthorizationUsed` + matching `Transfer` for `x402-exact`; Gateway API rows for `gateway-batched`; `JobCompleted`/`Refunded` for jobs | CZ-17 settlement proof (SL-C8 step 2), `listReceipts` |
| `gateway_transfers` | `transferId` | Gateway API polling: `id, status, fromAddress, toAddress, amount, nonce, txHash, createdAt, updatedAt` (SL-F19 field list; statuses `received, batched, confirmed, completed, failed`, A2-29) | pocket receipts, `pending` → `completed` display (A2-26) |
| `anchors` | `(publisher, kind, seq)` | `Committed`, `Revealed` | CZ-17 `prev` lookup, third-party verification pages |
| `dependency_state` | `proxy` | `Upgraded`, ERC-8183 admin events | alerts |
| `alerts` | `alertId` | §5.5 rules | on-call |
| `checkpoint` | network | Ponder internal | restart |

- Amount normalization: native `Transfer` logs from `0xffff…fffe` carry 18-decimal values; the indexer stores `value / 10^12` as `Amount6` (A1-05, p1-A4). ERC-20 logs from `0x3600…0000` are already 6-decimal. Both emitters are filtered so a settlement is counted once (dedupe by tx hash + log pair, SL-C8 step 2).

#### 5.4 Queries served (exact list)

| Query | Consumer | Returns |
|---|---|---|
| `envelopeByRef(envelopeRef)` | CZ-12 (`getEnvelope`), CZ-15, CZ-22 | `Envelope` + its reservations, pockets, jobs |
| `reservationsNeedingSettle(vault)` | CZ-15 | reservations `Active`/`Finalizing` whose derived nonces appear in `AuthorizationUsed` but are not in `settledMask` |
| `reservationsNeedingFinalize(now)` | CZ-15 | reservations with `validBefore < now` and `state != Final` |
| `pullbacksToConfirm()` | CZ-15 | `Pending` pullbacks whose `transferSpecHash` appears in `AttestationUsed` |
| `pullbacksToCancel(block)` | CZ-15 | `Pending` pullbacks with `requestedAtBlock + 3000 ≤ block` and no `AttestationUsed` (03 `czar-vault.md` §3 `PULLBACK_CANCEL_DELAY_BLOCKS`) |
| `jobsToSync()` | CZ-15 | vault jobs whose escrow status (from events) differs from the vault's `JobSynced` state |
| `jobsAwaitingEvaluation()` | CZ-16 | jobs with `JobSubmitted` and no `JobCompleted`/`JobRejected` |
| `receiptsForLedger(user, cursor)` | CZ-12 (`listReceipts`), CZ-25 | `LedgerReceipt` rows with `status` from settlement state (`reserved, settled, pending, completed, released, refunded, failed`) |
| `latestAnchor(publisher, kind)` | CZ-17 | `prev` root and `seq` |
| `anchorByBatch(root)` | CZ-17, verification page | `Committed` row |
| `dependencyState()` | CZ-15 routing flags | halted paths |

#### 5.5 Alerts (named parameters)

| Alert | Rule | Parameter (default, reason) | Action |
|---|---|---|---|
| `dependency-upgraded` | any `Upgraded` on a pinned proxy, or ERC-8183 `RoleGranted`, `HookWhitelistUpdated`, fee setters | — | halt the affected path, page (FD-18, spec 01 §16.2) |
| `indexer-lag` | head − indexed > `indexer.maxLagBlocks` | 120 blocks (≈ 1 min at 0.5 s, p1-A7) | failover RPC; UI "syncing" badge |
| `reserve-rate` | `Reserved` events per minute per vault or globally > `indexer.reserveRateAlertPerMin` | 60 per vault, 600 global (10× the expected peak) | page; guardian pause candidate (K6) |
| `settle-after-verify-failures` | `Released` with a matching merchant 200 response (from CZ-15 logs) > `indexer.settleFailRateBps` | 500 bps per hour | investigate Facilitator or merchant |
| `pocket-stale` | pocket `Draining` or `Funded` with `envelope.state = Closed` for > `indexer.pocketStaleHours` | 24 h | retry pullback; start the 7-day withdrawal (A2-13) |
| `anchor-missed` | no `EVIDENCE_BATCH` `Committed` within `2 × evidence.batchIntervalMinutes` while leaves exist | — | re-run CZ-17 publisher |
| `gateway-poll-failing` | Gateway API errors > `indexer.gatewayPollFailMax` consecutive | 10 | mark Gateway degraded; pocket path shows "delayed" |

#### 5.6 Gateway API polling

- Every `indexer.gatewayPollSeconds` (30 s; the first status `received` lands in ~1.2 s and `completed` 0–16 min later, A2-24 to A2-26) the indexer calls `GET /v1/x402/transfers?from=<pocket>` for every pocket in `Funded`/`Draining` and `?to=<payout>` for Czar merchant payout addresses (A2-28). `pageSize` max 100, cursor in the `link` header (p1-G10).
- A `txHash` on a `completed` row is cross-checked against `BatchProcessed` (A2-27). API-only rows are graded `rail-api`; when the API is down, `onchain-netted` from batch deltas with flag `rail-api-unavailable` (SL-C8 step 2).

### 6. Behaviour

1. Start: load checkpoint; if none, backfill from `indexer.startBlock`.
2. Page logs per contract set with address filters; apply handlers in block order; write projections in one transaction per block range.
3. At head: poll every `indexer.pollingIntervalMs` (1,000 ms; two blocks); run Gateway polling on its own timer.
4. On `Upgraded`: write `dependency_state`, set the halt flag, raise `dependency-upgraded`.
5. On restart: Ponder resumes from the checkpoint; handlers are idempotent (upserts keyed as in §5.3).
- Alternate paths: RPC range error → halve the page; provider down → failover; Gateway API down → degraded mode; schema migration → full re-index behind a maintenance flag while the old projections keep serving reads.

### 7. AI usage

None.

### 8. Privacy

- Everything the indexer stores is `public` (chain) or `server-only` (Gateway API rows keyed by pocket address). No objective text, no user ids beyond `vault → userId` mapping held by CZ-12. Retention: permanent for chain rows; Gateway rows 1 year.

### 9. Security

- Keys: none. Read-only RPC credentials (K19) in the secret store.
- Threats (spec 01 §13): "dependency upgraded against Czar" → `Upgraded` alerts halt paths before money moves; "server compromised" → a corrupted projection cannot move funds (the vault enforces); "indexer lag" → UI shows syncing, vault is the truth (spec 01 §14.1).
- A poisoned RPC provider could hide events; two providers and a periodic cross-check of `latest` block hashes between them (`indexer.crossCheckEveryBlocks` 600) raise `provider-divergence`.

### 10. Failure handling

| Failure | Behaviour | User sees | Idempotency / retry |
|---|---|---|---|
| `-32012` | halve range, retry | none | automatic |
| `-32014` | backoff, retry, failover | none | automatic |
| both providers down | `Failover` → alert; projections stale | "Syncing with the network" badge in the app | resume when any provider answers |
| Gateway API down | degraded; pocket receipts stay `pending` | "Small-payment network delayed" (spec 01 §14.1) | poll resumes |
| DB down | process exits; supervisor restarts | syncing badge | checkpoint |
| handler bug | process stops at the block; alert | syncing badge | fix, re-index from checkpoint |

### 11. Observability

- Metrics: `czar_indexer_head_lag_blocks`, `czar_indexer_events_total{contract,event}`, `czar_indexer_rpc_errors_total{code}`, `czar_indexer_gateway_poll_seconds`, `czar_indexer_alerts_total{alert}`.
- Logs: block numbers, tx hashes, event names, addresses, amounts only (`cross-cutting.md` §4).

### 12. Interface wording

Surfaced through CZ-22 only: "Syncing with the network" (lag), "Small-payment network delayed; your funds are safe in a pocket wallet" (Gateway down), "Temporarily unavailable" (halted path).

### 13. Performance and cost

- Backfill from the factory block at ≤ 9,999 blocks per call: Arc testnet produces ≈ 172,800 blocks/day, so one day of chain is ≈ 18 `eth_getLogs` calls per contract set. Live: ≈ 4 RPC calls per second across contract sets. Cost: RPC quota only; no gas.

### 14. Tests and definition of done

- Unit: every handler against synthetic logs (fixtures generated from the 03 event signatures); decimal normalization of a native `Transfer`; `settledMask` bit math for 128 indices.
- Integration: `arc-anvil` fork at a pinned block with scripted vault flows (03 `security-and-testing.md` §3.4) → projections equal the vault's views (`envelopes`, `reservations`) read by `eth_call`.
- Chaos: kill the process mid-page and assert identical projections after restart; inject `-32012`/`-32014`.
- Alerts: synthetic `Upgraded` event halts the path flag within one block.
- Definition of done: all §5.4 queries implemented and covered; lag alert fires in a staged outage; Gateway polling shows `received → completed` on a real testnet nanopayment; re-index from genesis reproduces the live projections byte for byte.

### 15. Dependencies

Ponder 0.18.x (A9-05), viem 2.57.x (A9-05), Postgres 16; hosted fallbacks Goldsky or Envio for both networks (A9-02, A9-04) if Ponder proves unreliable. Open question: Arc public RPC rate limits are unpublished (A9 GAP); the keyed provider is required for production.

**Mainnet differences:** contract addresses per `cross-cutting.md` §8; mainnet explorer API cannot be used (A9-11); Gateway API may need a key (K12); finality assumption re-verified pre-mainnet.

---

## CZ-16 Acceptance checker and ERC-8183 evaluator

### 1. Identity

| Item | Value |
|---|---|
| CZ ID, name | CZ-16, Acceptance checker and evaluator |
| Phase | 1 (delivery, structural, requirement checks; evaluator on Circle's instance); 2 (full profiles, consensus, corrections route); 3 (independent validators) |
| Product / roadmap | §6.14 pay on acceptance; §6.21 acceptance profiles; roadmap 2.2 |
| Decisions | D27, D35 |
| Package | `apps/server` module `acceptance`; prompts: none in Phase 1 (deterministic checks only) |

### 2. Responsibilities and non-responsibilities

- **Does:** run the acceptance profile on every step output and every ERC-8183 deliverable; produce an `AcceptanceReport` (02 §4.14) with `reportHash`; decide pass/fail/inconclusive; for jobs, call `complete` or `reject` on the escrow with the evaluator key K7; tell the paying agent whether the plan may continue.
- **Does not:** refund x402 payments (impossible for third parties, spec 01 §9; no Czar credits, D35); read raw seller text into any planner; call any vault function (CZ-15 calls `claimJobRefund` on its request).

### 3. Runtime

- Server worker pool; each check runs in a sandbox (Node `vm` context with no `require`, no network, no timers beyond `acceptance.sandboxTimeoutMs`; SL-C7 reuse). Budget: ≤ 50 MB per check, `acceptance.sandboxTimeoutMs` 5,000 ms.
- The evaluator loop wakes on `jobsAwaitingEvaluation()` from CZ-19 and on a timer `acceptance.evaluatorPollSeconds` 15.

### 4. Interfaces

| Direction | What | Reference |
|---|---|---|
| In | step output bytes + headers from CZ-15 (after P-01 screen), `Step` (02 §4.6), the merchant's sanitized `extensions.bazaar.info/schema` (02 §11.3) | 02 §4.6, §11.3 |
| In | `JobRecord` (02 §4.11) + deliverable bytes fetched from the `deliverable` hash's URI (by CZ-15's fetcher, screened) | 02 §4.11 |
| Out | `AcceptanceReport` (`schemas/acceptance-report.schema.json`), `decision`, `reportHash` | 02 §4.14, §5.2 |
| Out | contributes `schema-mismatch` to `StepResult.flags` (CZ-15 assembles the `StepResult`, 02 §4.15) | 02 §4.15 |
| Out (chain, K7) | `complete(jobId, reason = reportHash, "")` / `reject(jobId, reason = reportHash, "")` on the ERC-8183 instance | 03 `job-escrow-adapter.md` §2, §3 |
| Out | `report` rows to CZ-17 | §CZ-17 |
| Events consumed | `JobSubmitted` (via CZ-19), `JobExpired` | 03 `job-escrow-adapter.md` §2 |

### 5. Internal design

#### 5.1 Order in the step pipeline

`CZ-15 receives body → P-01 screen (ai-prompts.md) → CZ-16 checks → P-02 reader builds StepResult (flags include CZ-16 results) → CZ-15 continues or stops`. The checker never calls a model in Phase 1. The reader never sees the checker's internals, only `flags`.

#### 5.2 Phase 1 profiles (`profile_default_set` for task class `data-json`, SL-C7)

| Check | Kind | Pass | Fail | Inconclusive / not_checked | Parameter |
|---|---|---|---|---|---|
| `delivery` | delivery | HTTP 2xx, body present, received within `min(maxTimeoutSeconds, acceptance.deliveryTimeoutMs)` and body ≤ `acceptance.maxBodyBytes` | non-2xx, empty body, timeout, oversize | `inconclusive` when the request itself failed before any response (`no-response`), `not_checked` when the step was unpaid | `acceptance.deliveryTimeoutMs` 30,000 (SL-C7 "limit = min(maxTimeoutSeconds, 30 s)"); `acceptance.maxBodyBytes` 5,242,880 (SL-C2 `Q03` 5 MB) |
| `structural` | structural | body parses as the declared `mimeType` and validates (Ajv 8, 2020-12) against the merchant's sanitized `schema`; with no schema, the JSON key-tree matches the `shape_hash_advisory` from earlier observations of this service version (SL-C1) or, with no history, parse-only | parse error, schema violation | `inconclusive` when no schema and no history (parse-only pass is recorded as `structural: inconclusive` with `detail.parseOk = true`) | `acceptance.schemaMaxBytes` 8,192 (02 §11.3) |
| `requirement` | requirement | every key named in `Step.inputTemplate.expectedKeys` is present and non-empty | a named key missing | `not_checked` when the step has no `expectedKeys` | — |

- `correctness` (reference, consensus) is structurally missing in Phase 1 and is listed in `missing_dimensions_for_class` (SL-C10 step 2). The user wording never claims correctness was checked.
- Result semantics follow SL-C7 exactly: only `pass` and `fail` enter posteriors; `inconclusive` and `not_checked` do not.

#### 5.3 Decision rule

```mermaid
stateDiagram-v2
  [*] --> Screened: P-01 returned allow
  [*] --> Quarantined: P-01 flagged injection-suspect
  Screened --> Checked: delivery, structural, requirement run in sandbox
  Checked --> Pass: delivery pass ∧ structural ∉ {fail} ∧ requirement ∉ {fail}
  Checked --> Fail: any check fail
  Checked --> Inconclusive: delivery inconclusive (no response) or sandbox timeout
  Quarantined --> Fail: report with flags [injection-quarantined]
  Pass --> [*]: continue plan · report row to CZ-17
  Fail --> [*]: stop plan step · report row · StepError
  Inconclusive --> [*]: retry policy (CZ-15) · report row
```

- `Pass` lets CZ-15 run the next step; `Fail` stops the step (alternate payee only via a new reservation, 02 §7.5); `Inconclusive` lets CZ-15 retry per its policy with the same `paymentId`.
- Quarantine: the body is kept in the object store (`bodyRef`), shown to the user as "This result looked unsafe and was set aside", never delivered into the workflow.

#### 5.4 Report and hash

- `AcceptanceReport` = SL `ValidationReportCore` fields + Czar additions (02 §4.14): `obs_id` (the receipt's id), `profile_id` (`prof_` + hash of the profile JSON, SL §5.1), `method_version` = the executor code hash (SL-C7 `code_hash`), `validator = {id: "czar-evaluator", address: K7 address}`, `assignment = {kind: "buyer-local"}`, `checks[]`, `conflict_flags = ["self-reported-checks"]`, `cost_usd = 0`, `created_at`, `limits = ["no-correctness-check"]`, `envelopeRef`, `stepIndex`, `jobKey?`, `decision`, `reportHash = keccak256(jcs(report minus reportHash))` (02 §5.2).
- `reportHash` is the ERC-8183 `reason` (03 `job-escrow-adapter.md` §3) and the `outcomeHashes[]` entry in the `demand-proof` leaf (02 §4.17).

#### 5.5 Evaluator for ERC-8183 jobs

| Step | Action | Reference |
|---|---|---|
| 1 | CZ-19 reports `JobSubmitted(jobId, provider, deliverable)` for a vault-client job | 03 `job-escrow-adapter.md` §2 |
| 2 | CZ-15's fetcher resolves the deliverable: `deliverable` is a `bytes32`; the provider publishes the content at the URI agreed in the job's off-chain brief (convention `https://<provider-host>/.well-known/czar-deliverable/<deliverable-hex>`, D53; stored as `JobRecord.deliverableUri`, 02 §4.11, AM-08; the EIP fixes only the `bytes32`, A4-03); the fetched bytes must hash (keccak256) to `deliverable`, else `inconclusive` with `detail.hashMismatch` | A4-03 |
| 3 | P-01 screen on the bytes; CZ-16 runs the job's profile in the sandbox | §5.2 |
| 4 | `Pass` → `complete(jobId, reportHash, "")`; `Fail` → `reject(jobId, reportHash, "")`; both signed by K7 through the KMS policy that allows only these two selectors on the pinned escrow address | K7 (spec 01 §7.2); 03 `job-escrow-adapter.md` §5 |
| 5 | `Inconclusive` → wait and retry every `acceptance.evaluatorPollSeconds` until `expiredAt`; after expiry CZ-15 calls the vault's `claimJobRefund(jobKey)` (anyone may call it, 03 `czar-vault.md` §5.5; Circle's instance has no caller check, EIP reference line 690; the Czar instance adds a 1 h grace when `Submitted`) | 03 `job-escrow-adapter.md` §2 |
| 6 | After the tx: CZ-15 `syncJob(jobKey)` mirrors the state into the vault; CZ-17 gets the `report` row | 03 `czar-vault.md` §5.5 |

- `optParams` is always empty; the `reason` is only the hash (p1-E7: calldata is public).
- Idempotency: one decision per `jobKey`, recorded in `acceptance_decisions` before the tx is sent; on restart the evaluator re-reads `getJob` (or `jobs`) and, if the status is already `Completed`/`Rejected`, records the decision as observed instead of sending again. A tx that reverts `WrongStatus` is treated as "already decided by someone else" and reconciled from events.

#### 5.6 Conflict of interest

Czar judges work it planned and paid for. Mitigations in Phase 1, all visible:
- Deterministic checks only; no rubric or model judge (SL-C7 excludes `rubric` until calibration data exists).
- Every report is anchored in an evidence batch (CZ-17) so a provider can show exactly which check failed.
- `conflict_flags = ["self-reported-checks"]` and `evaluator-affiliated` (SL-C8 step 2) keep Czar-evaluated job outcomes out of the correctness posterior; they count for `delivery` only.
- Phase 2: the SL corrections route (`POST /v1/corrections`, SL §8.4) gives providers a public response channel; Phase 3: independent validators by committed salt (SL-C7). The decisions log keeps "an AI dispute judge may be added later" as an open item (not designed here).

#### 5.7 Storage

| Table | Fields |
|---|---|
| `acceptance_reports` | `reportHash` PK, `envelopeRef`, `stepIndex`, `jobKey?`, `obsId`, `profileId`, `methodVersion`, `decision`, `checks` (JSON), `flags`, `createdAt`, `bodyRef` |
| `acceptance_decisions` | `jobKey` PK, `decision`, `reportHash`, `txHash?`, `state` (`Pending`, `Sent`, `Confirmed`, `Observed`) |
| `profiles` | `profileId` PK, `taskClass`, `version`, `json`, `codeHash` |

#### 5.8 Parameters

| Parameter | Default | Reason |
|---|---|---|
| `acceptance.deliveryTimeoutMs` | 30,000 | SL-C7 delivery limit |
| `acceptance.maxBodyBytes` | 5,242,880 | SL-C2 `Q03` |
| `acceptance.schemaMaxBytes` | 8,192 | 02 §11.3 |
| `acceptance.sandboxTimeoutMs` | 5,000 | deterministic checks are fast; a slow check is a bug |
| `acceptance.evaluatorPollSeconds` | 15 | jobs are minutes-scale; no need for sub-second |
| `acceptance.deliverableMaxBytes` | 20,971,520 | job deliverables are larger than API bodies; bounded for the sandbox |
| `acceptance.deliverableFetchTimeoutMs` | 30,000 | matches delivery |

### 6. Behaviour

- Main path (x402 step): receive `(body, headers, step, schema)` → screen result → run checks → report → return `decision` and `flags` to CZ-15.
- Main path (job): §5.5.
- Alternate: P-01 unavailable (model cap or outage) → the body is treated as `injection-suspect` only if the regex pre-screen in P-01's fallback matches; otherwise checks run and the report carries `limits += ["screen-unavailable"]`; the result is still delivered with the warning label (the vault bound, not the screen, protects money).
- Alternate: schema invalid after sanitizing → `structural: inconclusive`, `detail.schemaDropped = true`.

### 7. AI usage

None in Phase 1. The checker consumes P-01's output (`allow` / `flag`) produced by CZ-15. Fallback with no model: regex pre-screen (ai-prompts.md P-01 fallback list) plus deterministic checks.

### 8. Privacy

- Inputs are merchant bodies (`server-only`, object store, 30-day retention unless the user keeps the result, spec 01 §11.1). Reports are `hash-on-chain` for `reportHash` and `public` as SL `report` rows with `disclosure = hash-only` (no body, only commits and check results, SL §11). Deliverables for jobs are retained 30 days.

### 9. Security

- Keys: K7 evaluator (KMS policy: `complete`/`reject` selectors on the pinned escrow only). Never K3.
- Threats: "malicious merchant or agent" → fail stops the plan; job rejects refund the vault (03 §8.5 flow); "poisoned seller text" → checks run on bytes in a sandbox without network, no model reads them here; "model hijacked" → a hijacked reader cannot change a deterministic check result; "server compromised" → the worst the evaluator key can do is release reserved job budgets to the named provider (spec 01 §7.2 K7 blast radius).

### 10. Failure handling

| Failure | Behaviour | User sees | Retry |
|---|---|---|---|
| sandbox timeout | `inconclusive`, `limits += ["sandbox-timeout"]` | "Result could not be checked" | CZ-15 retries the check once (`acceptance.checkRetries` 1) |
| deliverable unreachable | `inconclusive`; poll until `expiredAt`; then `claimJobRefund` | "Waiting for the specialist's work (until <time>)" | automatic |
| deliverable hash mismatch | `fail` → `reject` | "Work did not match what was submitted; money back" | none |
| K7 tx reverts `WrongStatus` | reconcile from events | none | none |
| K7 unavailable (KMS down) | decision stored `Pending`; retry; alert after `acceptance.kmsRetryMax` 10 | "Finalizing" | automatic |
| profile missing for task class | `not_checked` for structural/requirement; delivery still runs | "Delivered (not checked)" | none |

### 11. Observability

- Metrics: `czar_acceptance_checks_total{check,result}`, `czar_acceptance_decisions_total{decision,rail}`, `czar_evaluator_tx_total{action,outcome}`, sandbox duration histogram.
- Logs: `reportHash`, `envelopeRef`, `stepIndex`, `jobKey`, check results, flags; never bodies.

### 12. Interface wording (shown through CZ-22 and CZ-11 labels)

| Path / state | Exact wording |
|---|---|
| x402 or nanopayment step, before the check | "Checked before the next step" |
| x402 step passed | "Checked: delivered and well-formed. Correctness is not checked." |
| x402 step failed | "This step failed its check. $<amount> was already paid to <host> and cannot be refunded. The plan stopped here and this merchant's rating was lowered." |
| x402 step inconclusive | "This step could not be checked. Czar will retry once." |
| ERC-8183 job, before decision | "Money back if rejected" |
| job completed | "Accepted. $<budget> released to the specialist." |
| job rejected | "Rejected. $<budget> returned to your vault." |
| job expired without a decision | "The specialist did not finish in time. $<budget> is being returned to your vault." |
| quarantined | "This result looked unsafe and was set aside. Nothing from it was used." |
| Czar's own merchants | the x402 wording plus "Czar's own service: refunded by policy on failure" (refund is a new transfer by Czar, spec 01 §8.8; no D35 conflict because it is Czar's own merchant revenue, not a credit) |

Never used: "verified correct", "guaranteed", "refund" for third-party x402 (D35).

### 13. Performance and cost

- Deterministic checks: < 50 ms typical; Ajv compile cached per `profileId`. Evaluator tx gas: `complete`/`reject` ≈ 90k gas on the base contract (03 `czar-job-escrow.md` §11), paid by Czar's relayer in USDC.

### 14. Tests and definition of done

- Unit: each check × each result; schema sanitizing drop cases; `reportHash` reproduces from a stored fixture; `conflict_flags` always present.
- Injection: bodies containing "ignore previous instructions", JSON with a `"instructions"` key, HTML comments with tool-install commands (FL-1 text) → checks unaffected, flags carry P-01's result; a body that is schema-valid but contains a payee-change instruction passes `structural` and is still labelled by P-01 (documents that structural ≠ safe).
- Integration (`arc-anvil` fork, Circle testnet ABI): `JobSubmitted` → evaluator `complete` with `reason = reportHash` → `PaymentReleased`; `reject` → `Refunded` to the vault; expiry → `claimJobRefund` by an unrelated address.
- Crash: kill the evaluator between storing `Pending` and sending; restart sends once; kill after sending; restart observes `Completed` and does not resend.
- Definition of done: all wording strings in §12 exist as i18n keys; one real testnet job completed and one rejected with K7 through the KMS; reports appear as `report` rows in an anchored batch.

### 15. Dependencies

Ajv 8 (2020-12), Node `vm` sandbox (or a Wasm runtime, SL-C7), viem 2.57.x, KMS client (AR-1). Deliverable URI convention: D53, `JobRecord.deliverableUri` (AM-08).

**Mainnet differences:** evaluator targets `CzarJobEscrow` (D32) with the 1 h `EVALUATION_GRACE_PERIOD`; fees may be non-zero (≤ 500 bps) and are shown in the job wording as "after fees".

---
## CZ-17 Evidence producer and publisher

### 1. Identity

| Item | Value |
|---|---|
| CZ ID, name | CZ-17, Evidence producer and publisher |
| Phase | 1 (receipts, reports, demand-proof and soul-version leaves, hourly anchors); 2 (15-minute batches, 5-minute feature snapshots, corrections, exposure logs) |
| Product / roadmap | §6.21 anchoring, §6.22 proof of real demand; roadmap 2.13 |
| Decisions | D2, D25, D27 (evaluator-affiliated flag) |
| Package | `apps/server` module `evidence`; `@czar/hashing` for trees; `@czar/vault-client` for the `SL_RECEIPT` envelope |

### 2. Responsibilities and non-responsibilities

- **Does:** sign receipts, build leaves, batch them, pin archives, commit roots to `OpenEvidenceLog`, store and serve `EvidenceBatch` objects, and publish the third-party verification kit.
- **Does not:** rank (CZ-18), judge (CZ-16), or hold user text. It never anchors anything but hashes and public SL rows.

### 3. Runtime

- One publisher worker per network with a single leader lock (`evidence.leaderLockKey`), so only one process commits (the per-publisher `prev` chain would otherwise race, 03 `open-evidence-log.md` §12). Timer `evidence.batchIntervalMinutes`; early flush at `evidence.maxLeavesPerBatch`.

### 4. Interfaces

| Direction | What | Reference |
|---|---|---|
| In | `PaymentRef` + step context from CZ-15 after settlement proof | 02 §4.12 |
| In | `AcceptanceReport` rows from CZ-16 | 02 §4.14 |
| In | `SoulVersionSubmission` via `submitSoulVersion` (CZ-12 forwards) | OpenAPI `submitSoulVersion`; 02 §4.18 |
| In | `EnvelopeClosed` / `EnvelopeForceClosed` projections from CZ-19 (triggers the `demand-proof` leaf) | 03 `czar-vault.md` §9.1 |
| Out (chain, K8) | `OpenEvidenceLog.commit(Kind.EVIDENCE_BATCH, root, prev, uriHash, uri)` | 03 `interfaces/IOpenEvidenceLog.sol`; SL §7.1 |
| Out | `EvidenceBatch` (`schemas/evidence-batch.schema.json`), served at a public read path (Phase 1: a public HTTPS `archiveUri` on Czar's object store, D54; Phase 2 adds `GET /v1/snapshots`, SL-C11, and IPFS pins) | 02 §4.20 |
| Out | `observation` rows (receipts) and `report` rows to CZ-18's evidence processor | SL-C8 |
| Signatures | SL `Receipt` (02 §6.2) signed under the vault's ERC-1271 kind `SL_RECEIPT` (agent key K3 inner signature, 02 §6.3.3) for `x402-exact`; by the pocket key K4 for `gateway-batched` **before the key is destroyed**; under the vault's `SL_RECEIPT` kind for `erc8183-job` receipts too, since the vault is the job client (02 §4.13, AM-10) | 02 §4.13, §6.3.3 |

### 5. Internal design

#### 5.1 When leaves are created

| Leaf type | Trigger | Content | Signer |
|---|---|---|---|
| `observation` (SL `Observation`, `kind = receipt`) | CZ-15 confirms settlement (`settle` on-chain for vault-direct; Gateway row `received` for pocket; `JobCompleted`/`Refunded` for jobs) | `ObservationCore` (SL §5.4) with `payment = PaymentRef`, `payment_ref_hash`, commits of request and response (`sl-req-v1`, SL-C5), timings, `outcome`, `disclosure = "hash-only"`, plus Czar `SO` fields `envelopeRef`, `stepIndex` (02 §4.13) | vault (`SL_RECEIPT`) or pocket key |
| `report` | CZ-16 produces an `AcceptanceReport` | `ValidationReportCore` fields (02 §4.14) | K7 as `ValidationReport` EIP-712 (02 §6.2) |
| `demand-proof` | envelope reaches `Closed` with all steps resolved (settled, released, refunded or written off) | `DemandProofLeaf` (02 §4.17): `userPseudonym`, `observationHashes[]`, `objectiveHash`, `soulVersionHash`, `planHash`, `envelopeRef`, `approval{approver, txHash, blockNumber}` from the `EnvelopeOpened` tx, `paymentRefHashes[]` (one per settled step), `outcomeHashes[]` (one `reportHash` per step), `closedAt` | none (content-addressed) |
| `soul-version` | `submitSoulVersion` accepted | `SoulVersionLeaf` (02 §4.18) with the server's `userPseudonym` for the current epoch | none |
| `assessment`, `correction`, `exposure`, `submission-log` | Phase 2 (SL-C8, SL-C10, SL-C11) | SL §5 | — |

- `userPseudonym = keccak256(abi.encode(userSecret, epoch))` rotating every `evidence.pseudonymEpochDays` 90 (02 §7.1).
- A leaf is never created from an envelope that only has `local` steps (no payment, nothing to prove).

#### 5.2 Batch lifecycle

```mermaid
stateDiagram-v2
  [*] --> Collecting: leaves appended to the open batch
  Collecting --> Built: timer (evidence.batchIntervalMinutes) or evidence.maxLeavesPerBatch · root computed (czar-merkle-v1)
  Built --> Stored: archive uploaded to Czar's object store at a public HTTPS archiveUri · uriHash = keccak256(utf8(archiveUri)) (D54; IPFS pins are Phase 2)
  Stored --> Committed: commit(EVIDENCE_BATCH, root, prev=latest(K8,EVIDENCE_BATCH).root, uriHash, archiveUri) mined
  Committed --> Confirmed: CZ-19 sees Committed(publisher=K8, root) · EvidenceBatch.committedTx set
  Stored --> Stored: upload failure → retry with backoff
  Committed --> Stored: PrevMismatch revert → re-read latest, retry same root
  Confirmed --> [*]
```

- `Built`: leaves sorted by leaf hash; tree per 02 §5.3 (`EVIDENCE_LEAF` tag, `leafTypeHash`, `contentHash = H(leaf object)`, double-hashed leaves, `commutativeKeccak256` nodes, odd carried up). Root is deterministic from the stored leaf set, so a crash anywhere rebuilds the same root.
- `Pinned`: archive = JSON Lines, one leaf object per line, in leaf-hash order, plus a header line `{batchId, publisher, kind, prev, root, leafCount, merkleRule: "czar-merkle-v1", hashRule: "czar-hash-v1"}`. Only public rows per SL §11 (`hash-only` receipts carry commits, status, timings, payment refs, flags; no bodies). Two independent pins (`evidence.pinProviders` = 2) and a copy in Czar's object store (03 `open-evidence-log.md` §11).
- `Committed`: `prev` is read from `latest(K8 address, EVIDENCE_BATCH)` right before sending; `PrevMismatch` means another commit landed (should not happen with the leader lock) → re-read and retry with the same root (03 `open-evidence-log.md` §12). The commit tx sets `maxFeePerGas ≥ 20 Gwei` (p1-A6).
- Phase 1 cadence: `evidence.batchIntervalMinutes` 60, `evidence.maxLeavesPerBatch` 1,000 (03 `open-evidence-log.md` §11); Phase 2: 15 minutes plus `FEATURE_SNAPSHOT` every 5 minutes (SL-C11).

#### 5.3 Proof-of-real-demand chain

```
observationHashes[] ──(inside)──> objectiveHash ──(inside)──> planHash
      │                                │                          │
      │  (user holds preimages)        │ EnvelopeOpened(objectiveHash, planHash, approverIsOwner) on-chain
      ▼                                ▼                          ▼
soulVersionHash (soul-version leaf) ── demand-proof leaf ── paymentRefHashes[] ── outcomeHashes[]
                                              │
                                       EVIDENCE_BATCH root on OpenEvidenceLog
```

- Each link is a hash inclusion: `objectiveHash` preimage contains `observationHashes` and `soulVersionHash` (02 §5.2); `planHash` preimage contains `objectiveHash` and `payeeRoot`; the `EnvelopeOpened` event carries `objectiveHash` and `planHash` and whether the owner (passkey UserOp) or the agent (within allowance) approved; each `paymentRefHash` resolves to an on-chain or rail settlement; each `outcomeHash` resolves to an anchored `report` row.

#### 5.4 What a third party can verify, and how

| Step | They do | They learn |
|---|---|---|
| 1 | Read `Committed(publisher = Czar K8, kind = EVIDENCE_BATCH, root, prev, uriHash, uri)` from `OpenEvidenceLog` (or `latest(publisher, kind)`) | an anchored root and its `archiveUri` |
| 2 | Fetch `archiveUri` over HTTPS; check `keccak256(utf8(archiveUri)) == uriHash` (D54); rebuild the tree with `czar-merkle-v1` (02 §5.3, published in the policy tarball); check it equals `root`; check `prev` matches the previous `Committed` | the archive is the committed one and the chain is unbroken |
| 3 | Find a `demand-proof` leaf; recompute `contentHash = H(leaf)` and the leaf hash | the leaf is in the batch |
| 4 | Read the `EnvelopeOpened` event at `envelopeRef` and `approval.txHash`; compare `objectiveHash`, `planHash`, `approverIsOwner` | a vault owner (passkey holder) or the agent within an on-chain allowance approved exactly that objective and plan, at that block |
| 5 | For each `paymentRefHash` with the archive's `PaymentRef` row: `x402-exact` → find `AuthorizationUsed(vault, nonce)` and the `Transfer(vault → payTo, amount)` log (A1-18); `gateway-batched` → `GET /v1/x402/transfers?nonce=<nonce>&from=<pocket>` keyless (p1-G10, A2-30) and the `BatchProcessed` tx (A2-27); `erc8183-job` → `JobCompleted` / `Refunded` events on the escrow | money really moved to that payee for that objective |
| 6 | For each `outcomeHash`: find the `report` row with that `reportHash` in the same or an earlier batch; read `checks[]` | what was checked and what passed |
| 7 | Optionally recompute a ranking from the published snapshots with the recompute kit (SL §8.5) | Czar's ranking follows from the anchored evidence |

- **They cannot verify:** the observation preimages (only the user holds the `ActivityEvent`s, D25) and the soul beliefs (only the user can reveal a belief against `sectionHashes`, 02 §5.2). What is proven is: a specific passkey-owned vault approved a specific objective hash before paying, and the objective hash commits to specific observation hashes that existed before the approval. That is the "stranger test" evidence the roadmap describes (roadmap 2.13), stated without overclaiming.
- A one-page "Verify a Czar purchase" guide with the step list above and the policy tarball link ships with Phase 1 (`evidence.verifyGuideUrl`).

#### 5.5 Storage

| Table | Fields |
|---|---|
| `leaves` | `leafHash` PK, `batchId?`, `leafType`, `contentHash`, `content` (JSON, public rows only), `createdAt` |
| `batches` (02 §4.20) | `batchId` PK, `publisher`, `kind`, `prevRoot`, `root`, `leafCount`, `archiveUri`, `uriHash`, `cid?` (Phase 2), `state`, `committedTx?`, `seq?` |
| `receipt_signatures` | `obsId` PK, `signer`, `kind` (`SL_RECEIPT` \| `pocket-eoa` \| `agent-eoa`), `signature` |
| `pseudonyms` | `userId`, `epoch`, `pseudonym` (derived; `userSecret` lives in the KMS as a data key) |

#### 5.6 Parameters

| Parameter | Default | Reason |
|---|---|---|
| `evidence.batchIntervalMinutes` | 60 (Phase 2: 15) | spec 01 §15.3 cadence; gas 03 `open-evidence-log.md` §13 |
| `evidence.maxLeavesPerBatch` | 1,000 | early flush keeps archives small |
| `evidence.pinProviders` | 2 | SL-C11 two independent pins |
| `evidence.pinRetryMax` / `evidence.pinRetryBaseMs` | 8 / 2,000 | transient pin failures |
| `evidence.commitRetryMax` | 5 | `PrevMismatch` or RPC errors |
| `evidence.pseudonymEpochDays` | 90 | address hygiene (spec 01 §11.3) |
| `evidence.receiptSignTimeoutMs` | 10,000 | KMS round trip |
| `evidence.pocketReceiptBeforeDestroyMs` | 60,000 | pocket receipts must be signed before CZ-15 destroys K4 |

### 6. Behaviour

1. CZ-15 reports a settled step → build `ObservationCore` → sign (vault kind `SL_RECEIPT` via K3; pocket key for Gateway) → store leaf.
2. CZ-16 reports → store `report` leaf.
3. CZ-19 signals envelope closed → gather the envelope's `paymentRefHashes` and `outcomeHashes` → build `demand-proof` leaf.
4. Timer → `Built → Pinned → Committed → Confirmed` (§5.2).
5. Serve `EvidenceBatch` and archives; CZ-18 ingests `observation` and `report` rows.
- Alternate: envelope force-closed with written-off pockets → `demand-proof` still built; written-off steps have no `paymentRefHash` and their `outcomeHash` is the report with `outcome = unknown`.
- Alternate: receipt signing fails (KMS) → leaf stored unsigned with `provenance: unverified`; retried; an unsigned receipt is never anchored (SL-C8 step 1 would reject it).

### 7. AI usage

None.

### 8. Privacy

- Leaves are `public` by construction (02 §4.17, §4.18, §4.20: hashes, public refs, `hash-only` receipts). `userSecret` is `server-only` (KMS data key). Archives are permanent; `receipt_signatures` 1 year.
- Address hygiene: a user's vault address is visible with every payment (p1-G10); pseudonyms rotate; the user is told this plainly in the app (spec 01 §11.3).

### 9. Security

- Keys: K8 publisher (KMS policy: `commit` and `reveal` on the pinned `OpenEvidenceLog` only); K3 for `SL_RECEIPT` inner signatures (non-spending kind, 03 `czar-vault.md` §6.3); K7 for reports; K4 for pocket receipts.
- Threats: "server compromised → evidence forgery under Czar's name": detectable by recompute, moves no money (spec 01 §13); "Selection Layer operator misconduct": per-publisher hash chain, archives bound by the on-chain root and `uriHash` (`archiveUri` in Phase 1, CID in Phase 2, D54), anyone may publish under their own address (SL §10).

### 10. Failure handling

| Failure | Behaviour | Retry |
|---|---|---|
| object store down | stay `Built`; alert `anchor-missed` after 2 intervals | backoff |
| commit reverts `PrevMismatch` | re-read `latest`, retry same root | `evidence.commitRetryMax` |
| commit tx dropped (fee below 20 Gwei) | re-send with `maxFeePerGas ≥ 20 Gwei` (p1-A6) | automatic |
| archive upload fails after commit | root anchored; upload later to the same `archiveUri`; content must rebuild `root` (03 `open-evidence-log.md` §12) | until success |
| leader crash mid-batch | new leader rebuilds the same root from stored leaves; if a `Committed` with that root exists, it moves to `Confirmed` | deterministic |
| K8 unavailable | batches queue; alert | automatic |

### 11. Observability

- Metrics: `czar_evidence_leaves_total{type}`, `czar_evidence_batches_total{state}`, `czar_evidence_commit_gas`, time from `Built` to `Confirmed`.
- Logs: batch ids, roots, archive URIs, tx hashes, leaf counts.

### 12. Interface wording (through CZ-22 receipts)

| State | Exact wording |
|---|---|
| leaf created, not anchored | "Proof pending (anchored within the hour)" |
| anchored | "Proof anchored on Arc · batch <seq> · view" (links the verification page) |
| soul version anchored | "Soul version <n> anchored (only a hash; your soul stays on your computer)" |

### 13. Performance and cost

- Phase 1: 24 commits/day ≈ 3.4M gas ≈ 0.07 USDC/day at 20 Gwei; Phase 2 ≈ 0.94 USDC/day (03 `open-evidence-log.md` §13). Tree build is O(n log n) in leaves; 1,000 leaves in milliseconds.

### 14. Tests and definition of done

- Unit: tree roots reproduce fixtures built by the same rule in Foundry (03 `security-and-testing.md` §3.1); `demand-proof` leaf content hash stable under field reordering (JCS); pseudonym rotation.
- Integration: a scripted envelope on `arc-anvil` → leaves → batch → `commit` → `Committed` seen by CZ-19 → `EvidenceBatch.committedTx` set; `PrevMismatch` injected by a second commit → retry succeeds.
- Third-party drill: an engineer outside the team follows §5.4 with only the public guide and reproduces the root and every chain link for the Phase 1 scenario (`phase-1-acceptance-scenario.md`).
- Definition of done: one real testnet batch anchored with a `demand-proof` leaf whose `EnvelopeOpened` event matches; archive pinned twice; verification guide published.

### 15. Dependencies

`@czar/hashing`, viem 2.57.x, the S3-compatible object store, KMS (D61, AR-1). IPFS pinning with two providers is Phase 2 (D54).

**Mainnet differences:** `OpenEvidenceLog` at the same CREATE2 address (A9-15); gas at mainnet prices; Gateway transfer lookups may need a key (K12).

---

## CZ-18 Selection Layer services

### 1. Identity

| Item | Value |
|---|---|
| CZ ID, name | CZ-18, Selection Layer services |
| Phase | 1 lite; 2 full; 3 probers, validators, exploration, fix-it feedback |
| Product / roadmap | §6.21 Selection Layer, §6.18–§6.19 (Phase 3); roadmap 2.8–2.11 (later) |
| Decisions | D2, D8, D15, D27 (evaluator-affiliated), D36 |
| Package | `apps/server` module `selection`; SL components C1, C3, C4, C8, C9, C10 (lite), C2, C11 (Phase 2), C6, C7 (Phase 3) |

### 2. Responsibilities and non-responsibilities

- **Does (Phase 1 lite, spec 01 §15.2–§15.3):** keep Czar's index of registered merchants (Czar's own first); query Circle's catalog live without persisting it (02 §12.3); attribute observations to services by `(payTo, origin)` (SL-C1); verify settlement for Czar's own receipts (SL-C8 step 2); keep Beta posteriors (SL-C9); rank with `pol_default_v1` (SL-C10) and serve `RankingDecision` to the planner and `find_service`; serve the Czar index item shape (02 §12).
- **Does not:** sell position (ever); score unverified services; ingest or mirror Circle's catalog (D15, p1-D8); run probes or independent validators before Phase 3; read ERC-8004 feedback except from trusted clients (FD-19, Phase 2).

### 3. Runtime

- Server module with Postgres tables (§5.5); ranking reads a materialized snapshot refreshed every `selection.snapshotRefreshSeconds` 300 (Phase 2: anchored every 5 minutes, SL-C10). Live 402 probes are HTTP requests with a 2 s timeout (`selection.probeTimeoutMs`).

### 4. Interfaces

| Direction | What | Reference |
|---|---|---|
| In | `observation` and `report` rows from CZ-17; `settlements` from CZ-19 | SL-C8 |
| In | merchant registrations (Czar's own merchants in Phase 1; `POST /v1/index/submit` in Phase 2, SL-C2) | SL-C2 |
| In (live) | `GET https://api.circle.com/v2/x402/discovery/resources` with `limit ≤ 200`, `offset`, `network`, `supportsVanillax402`, `supportsCircleGateway` (keyless; cached ≤ 3600 s) | p1-D1, p1-D2, A3-37, F4-01 to F4-03 |
| In (live) | the merchant's 402 (`PAYMENT-REQUIRED`) for probe-before-plan | p1-D7, 02 §11.2 |
| Out | `RankingDecision` (`schemas/ranking-decision.schema.json`) to CZ-13 and to the MCP `find_service` tool (mapped to its output fields `ranked[]`, `unverified[]`, `insufficientEvidence`, `policyVersion`, `snapshotId`) | 02 §4.19; `02/mcp/czar-mcp-tools.md` §2.2 |
| Out | index items at `GET /v2/x402/discovery/resources` and `/search` in the dual shape | 02 §12.1; `listIndexResources`, `searchIndexResources` in 02 api/openapi.yaml (AM-07) |
| Out | `extensions.czar.evidence` figures for CZ-22 displays | 02 §12.2 |

### 5. Internal design

#### 5.1 Phase scope

| SL component | Phase 1 lite | Phase 2 full | Phase 3 |
|---|---|---|---|
| C1 identity and attribution | `(payTo, origin)` linking from Czar's own probes; claims ladder `unclaimed`/`wallet-verified` for Czar merchants | domain verification, ERC-8004 reads (identity only), operator clusters | — |
| C2 indexer | Czar-registered merchants; live Circle query, no mirror | crawler, submissions, on-chain `payTo` leads, admission codes | — |
| C3 retrieval | capability-tag match (exact tags from the planner's taxonomy) | BM25 + embeddings (≤ 1,024 dims, C1-13) with raw floors and RRF | — |
| C4 eligibility | network, rail, price, `unknown_policy` | full gates incl. latency and data policy | — |
| C5 receipts | CZ-17 signs Czar's own receipts | outside buyers (Receipt SDK) | — |
| C6 probers | none | one Czar prober with commit/reveal on Czar's merchants | open prober set |
| C7 validators | CZ-16 only (`buyer-local`) | — | independent validators by salt |
| C8 evidence processor | settlement proof, dedup, attribution for Czar receipts; flags `self-reported-checks`, `evaluator-affiliated` | funding graph, corrections, inclusion tickets | — |
| C9 reputation | Beta posteriors, half-life, `n_eff`, badges | carried priors, probe gap, calibration | — |
| C10 ranker | `pol_default_v1` over the refreshed snapshot | anchored snapshots, `dry_run_policy`, exposure log | exploration slot (§6.18) |
| C11 publication | via CZ-17 batches | `GET /v1/snapshots`, policy releases, ERC-8004 mirror (trusted clients only) | fix-it feedback (§6.19) |

#### 5.2 Ranking inputs and the "unknown is not bad" rule

- Dimensions in Phase 1: `delivery`, `structural`, `requirement` (from CZ-16 results on Czar's own receipts), `latency_p50/p95`, `price_match` (SL-C9). `correctness` is structurally missing (no reference or consensus profiles yet) and is named in `missing_dimensions_for_class` on every decision (SL-C10 step 2).
- Posteriors: `Beta(1,1)` prior; weight `d_i = 0.5^(age/H)`, `H = selection.halfLifeDays` 14; `n_eff = Σ w_i d_i`; a service with `min n_eff < selection.nMin` (5) on any required dimension is **unverified** (SL-C9, SL-C10 step 3).
- Eligible uses: Czar-evaluated job outcomes count for `delivery` only (`evaluator-affiliated`, SL-C8 step 2); `buyer-local` structural checks weigh 0.25 (SL-C7).
- Score: `L_D = BetaQuantile(q = selection.riskQuantile 0.2, α, β)`, `quality = Π L_D`, `score = quality − w_cost × cost_term − w_latency × latency_term` with `selection.wCost` 0.2, `selection.wLatency` 0.1; unknown latency scores as the candidates' median, never best (SL-C10 steps 4–7).
- **Unknown is not bad:** unverified services appear in `unverified[]` with their `n_eff`, never with a score; `insufficient_evidence = true` when nothing is ranked; `unknown_policy = exclude` is the planner's default (`selection.plannerUnknownPolicy`), so the planner never pays an unverified service unless the user's spending posture enables exploration (Phase 3 slot, D36 alternates still come only from `ranked[]`). Badges (`single-source`, `low-check-coverage`, `probe-gap`, `carried-prior`, `consensus-only`) are passed through to `find_service.ranked[].badges` and the app.
- Explanations are templated strings (SL-C10 step 8), never model-generated: `"<n_eff> checked calls over <days> days; delivery lower bound <L>; correctness not checked."`
- No demand feature in the score (SL-C10). Czar's own merchants are ranked by the same rules and carry `source: czar-registered`.

#### 5.3 Live catalog use and probe-before-plan

- On every planner or `find_service` query: fetch Circle's catalog page(s) filtered by `network` (`eip155:5042002` returns 134 items, mostly RPC, p1-D6; mainnet 2,195) and by `supportsVanillax402` / `supportsCircleGateway`, merge in memory with Czar's index, and discard Circle's descriptions and metadata after the response (02 §12.3). Persisted for `circle-live`: `resource`, `payTo`, `network`, `fetchedAt`, `expiresAt = fetchedAt + selection.catalogTtlSeconds` (3600, p1-D2), `etag`.
- Catalog text is retrieval-only; it never affects the score (SL-C3) and is never shown to the planner raw (it is reduced to capability tags by P-02-style structured extraction in Phase 2; Phase 1 uses Circle's `category` and `tags` fields only).
- Before any plan step is priced, CZ-13 asks CZ-18 to probe the live 402 (`selection.probeTimeoutMs` 2,000): the live `amount`, `payTo`, `scheme` and `network` win over any item (p1-D7 ≈ 10% drift). A probe is an unpaid request; the response is parsed by `@czar/x402` with sanitizing (02 §11.3).
- `category=DATA_ENRICHMENT` is rejected by Circle's filter (F4-03); Czar filters client-side.

#### 5.4 Attribution and settlement proof (Phase 1)

- `attribute(core)`: `payTo ∈ service.pay_to[]` linked by Czar's own probe origin (`linked_by: probe-origin`) → confidence 1.0; else `payto-unlinked` (SL-C1).
- `verifySettlement`: `x402-exact` → `settlements` row from CZ-19 (`AuthorizationUsed` + `Transfer(vault → payTo, amount)`) → grade `onchain`; `gateway-batched` → Gateway API row with `toAddress == payTo` and equal amount → `rail-api`, or `onchain-netted` from `BatchProcessed` deltas when the API is down; `erc8183-job` → escrow events (SL-C8 step 2). `dedup_key = rail:network:payer:payTo:nonce`.

#### 5.5 Storage

| Table | Key fields |
|---|---|
| `services` (SL `ServiceRecord`) | `service_id`, `origin`, `method`, `path_pattern`, `pay_to[]`, `claim`, `admission`, `sources[]`, `probe_eligible` |
| `service_versions` | `version_id`, `requirements_hash`, `openapi_hash`, `shape_hash_advisory` |
| `observations` | `obs_id`, `ObservationCore` JSON, `sig`, `received_at` |
| `assessments` | `assessment_id`, `obs_id`, provenance, `dedup_key`, `independence`, `eligible_uses[]`, `flags[]`, `assessed_with` |
| `reputation` | `(service_id, version_id, task_class, dimension)`, `α`, `β`, `n_eff`, `badges[]`, `lineage_root`, `policy_version` |
| `ranking_decisions` | `query_id`, `RankingDecision` JSON, retained `selection.decisionRetentionDays` 90 (SL-C10) |
| `catalog_cache` | `resource` PK, `payTo`, `network`, `fetchedAt`, `expiresAt`, `etag` (TTL-purged; nothing else from Circle) |
| `policy_releases` | `policy_version`, tarball hash, params (Phase 2 anchored as `POLICY_RELEASE`) |

#### 5.6 Parameters

| Parameter | Default | Reason |
|---|---|---|
| `selection.halfLifeDays` | 14 | SL-C9 `data-json` |
| `selection.nMin` | 5 | SL-C10 unverified threshold |
| `selection.riskQuantile` | 0.2 | SL-C10 default; user posture may lower it |
| `selection.wCost` / `selection.wLatency` | 0.2 / 0.1 | SL-C10 |
| `selection.catalogTtlSeconds` | 3,600 | p1-D2 `max-age=3600` |
| `selection.probeTimeoutMs` | 2,000 | planner latency budget |
| `selection.plannerUnknownPolicy` | `exclude` | money never goes to unverified services by default |
| `selection.snapshotRefreshSeconds` | 300 | matches the Phase 2 5-minute snapshot cadence |
| `selection.decisionRetentionDays` | 90 | SL-C10 |
| `selection.retrieveK` | 50 | SL-C3 |

### 6. Behaviour

1. Query (`task_class`, constraints) → retrieve candidates (Czar index + live Circle, in memory) → eligibility gates → load posteriors → unverified split → score → `RankingDecision` with explanations, `excluded[]`, `missing_dimensions_for_class`, `snapshotId`, `policy_version`.
2. On new receipts/reports → assess → update posteriors incrementally → next snapshot refresh.
- Alternate: Circle Discovery down or slow → Czar index only, decision carries `missing += ["catalog-live-unavailable"]` and freshness; nothing is served from an expired cache (02 §12.3).
- Alternate: no eligible candidates → `insufficient_evidence = true`; CZ-13 marks the objective "no supplier".

### 7. AI usage

None in Phase 1 (retrieval is tag-based; explanations are templates). Phase 2 embeddings use the pinned model in the policy tarball (C1-01, C1-02); still no model in scoring.

### 8. Privacy

- `server-only` for index and decisions in Phase 1; SL rows become `public` through CZ-17 per SL §11. No user data enters the Selection Layer beyond pseudonymous receipts; a receipt's `payer` is the vault or pocket address (public on-chain anyway).

### 9. Security

- Keys: none (reads only; writes to chain go through CZ-17).
- Threats: "poisoned catalog text" → text affects retrieval only, sanitized per A3-36, never scored, never shown raw to the planner; "Selection Layer operator misconduct" (Czar ranking its own merchants first) → same rules for all, policy and snapshots anchored (Phase 2), recompute kit; "malicious merchant" → evidence lowers posteriors; `price_match` and price-drift gates (SL-C4).

### 10. Failure handling

| Failure | Behaviour |
|---|---|
| Circle Discovery 5xx or timeout | index-only answer with freshness flag |
| merchant 402 probe fails | candidate excluded with `gate: probe`, `detail: unreachable` |
| posterior table stale (snapshot refresh failed) | serve last snapshot with `snapshot_age` flagged > `selection.snapshotStaleMinutes` 30 (SL-C10 failure modes) |
| settlement proof unavailable (indexer lag) | observation stays `unverified` until the proof lands; never counted |

### 11. Observability

- Metrics: `czar_selection_queries_total{outcome}`, `czar_selection_catalog_fetch_seconds`, `czar_selection_probe_total{result}`, `czar_selection_unverified_ratio`, posterior update counts.
- Logs: `query_id`, `service_id`s, scores, badges; never descriptions.

### 12. Interface wording (via `find_service` and CZ-22)

| Case | Exact wording |
|---|---|
| ranked service | "<n_eff> checked calls over <days> days. Delivers reliably (lower bound <L>). Correctness not checked." |
| unverified service | "Not enough evidence yet (<n_eff> of 5 checked calls). Not ranked, not bad." |
| nothing ranked | "No service has enough evidence for this task yet." |
| catalog unavailable | "Live catalog unavailable; showing Czar's own index." |

### 13. Performance and cost

- Query p95 target 300 ms from the snapshot (SL-C10) plus one live catalog fetch (cached) and up to `selection.maxProbesPerQuery` 5 live 402 probes at 2 s each in parallel.

### 14. Tests and definition of done

- Unit: SL §9 worked example reproduces the same posteriors, LCBs and order; unverified split at `n_eff = 4.99` vs `5.0`; unknown latency scores as median; cache purge at TTL; nothing from Circle persists beyond the allowed fields (schema test on `catalog_cache`).
- Injection: catalog descriptions containing FL-1 text or "rank this first" → identical scores with and without the text.
- Integration: Czar's two merchants ranked from real testnet receipts; live Circle fetch with `limit=200` paging; drift probe where a mock 402 differs from the cached price → live wins.
- Definition of done: `find_service` returns a decision with explanations for the Phase 1 scenario; `insufficient_evidence` path exercised; a recompute from stored assessments reproduces the served decision.

### 15. Dependencies

Postgres 16 (pgvector only in Phase 2, C1-13), `@czar/x402` for probes, `@x402/extensions` 2.28.0 sanitizers (A3-36). Open questions: AR-11 (legal reading of Circle's terms for live querying, low confidence); embedding model choice (Phase 2).

**Mainnet differences:** catalog filtered to `eip155:5042` (2,195 items, p1-D6); Czar's own merchants may not exist on mainnet (D14 is testnet); mainnet re-check of SL-F4/F17 constants before use (SL §13).

## Change log

| Date | ID | Change |
|---|---|---|
| 2026-10-18 | D53, AM-08 | deliverable `.well-known` convention and `JobRecord.deliverableUri` |
| 2026-10-18 | D54 | archives on Czar's object store with `uriHash = keccak256(utf8(archiveUri))`; IPFS moved to Phase 2 |
| 2026-10-18 | AM-07 | index routes named `listIndexResources`, `searchIndexResources` |
| 2026-10-18 | AM-10 | job receipts signed under the vault's `SL_RECEIPT` kind |
| 2026-10-18 | D61 | KMS reference |
| 2026-10-18 | D54 | Threat row in CZ-17 §9 now binds archives by root and `archiveUri` (CID only in Phase 2). |
