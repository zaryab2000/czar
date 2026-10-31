# SCR-162: Flow 4A alpha: open questions from 4A-2, 4A-3 and 4A-4

| Field | Value |
|---|---|
| ID | SCR-162 |
| Filed by | chief architect, 2026-10-31, from the orchestrator's question list after merged PRs #178 (4A-2), #179 (4A-4) and #180 (4A-3) |
| Spec and section | SCR-160 §5.2, §6.2, §7.4, §8.2, §8.3; SCR-161 §5; spec 02 §4.6 (`Step.alternates`), §4.15 (`StepResult`); CZ-13 step 7 (alternates); CZ-15 §5.2–§5.4; CZ-17 §5.1 |
| Status | Accepted (Zaryab's delegation; recorded by his merge) |

Each item states the canonical behaviour, then whether it is **required for the alpha** (before Flow 4A is called done) or **deferred** (recorded, with the trigger that brings it back).

## 1. H4 clearing (`service_versions` producer)

- **Canonical:**
  - A service version is `ver_` + hex(keccak256(JCS({payTo, resource: {url, method}, schemaHash})))[0:32], where `schemaHash` is the hash of the validated Bazaar schema from the live 402 (SCR-137; null when none is declared).
  - CZ-18 computes it at probe-before-plan and persists `service_versions(service_id, version_id, first_seen_at)` on first sight. A new `version_id` for a service is the verified shape change that clears H4 (SCR-160 §6.2).
  - The producer belongs to T-115 (capability cards and versions), which is not built.
- **Alpha: deferred.**
  - An H4 block is permanent in the alpha. That's fail-closed and safe: the supplier stays in `excluded[]` with the explanation "Blocked: it returned text that tried to hijack the agent."
  - Observations keep `version_id = 'ver_unknown'`.
  - **Trigger to build:** T-115, or the first H4 fact seen on testnet, whichever comes first.

## 2. Ordinary Gateway and job receipts

- **Canonical:**
  - **Gateway (`gateway-batched`):**
    - The pocket loop runs the same boundary as vault-direct (`runBoundary`: screen, reader, CZ-16 acceptance) on each nanopayment response.
    - CZ-15 builds the per-call `StepResult` from it. `bodyCommit` is the SL `responseCommit` of the verified response body, computed exactly as vault-direct computes it.
    - CZ-17 signs the receipt leaf once the Gateway row for `(pocket, nonce)` is `completed`, with the `gateway-batched` `PaymentRef`.
  - **ERC-8183 job:**
    - The verified result is the deliverable that CZ-16's evaluator accepted. Its content hash is stored as `acceptance_decisions.deliverableHash` (SCR-143), and CZ-15 persists the deliverable (the evaluator never writes `StepResult`).
    - CZ-15 builds the `StepResult` from it, with `callIndex = 0` and `bodyCommit = deliverableHash`.
    - CZ-17 signs the receipt leaf after the escrow reaches `Completed`, with the `erc8183-job` `PaymentRef`.
- **Alpha: deferred.**
  - Both rails are off (`routing.gatewayEnabled = false`, `routing.jobEnabled = false`).
  - Added to the exit-report lists "Before `routing.gatewayEnabled` is turned on" and "Before `routing.jobEnabled` is turned on".
  - Until then the alpha claims SCR-160 §14 item 2 for `x402-exact` only.

## 3. Rating ownership (replaces the `envelopes` join in SCR-160 §7.4 check 5)

- **Canonical:** there is no `envelopes` table. The historical ownership record is `objectives.envelope_ref`, which the opening watcher writes when the approved plan's envelope opens (`opening-watcher.ts`). Check 5 becomes:
  - `objectives.user_id = principal.userId`
  - `objectives.envelope_ref` is set
  - every resolved observation has `envelope_ref = objectives.envelope_ref`, `user_id = principal.userId`, and `vault` = the vault embedded in that `envelope_ref`
- **The current check** (observation owner, *current* `users.vault`, and the vault in `envelope_ref`) fails closed and is correct while each owner has exactly one vault (factory `vaultOf`). But it depends on a mutable column.
- **Alpha: required** (small). Replace the `users.vault` comparison with the `objectives.envelope_ref` binding above, and add one test: an observation from another envelope of the same owner is refused `403 not-your-payment`.

## 4. Alternate payees

- **Canonical:**
  - `Step` gains `alternateServices` (`Plan` 1.4): an array of ≤ 2 `{payee, serviceId, resource: {url, method}}`, one per entry of `alternates`, in the same order. It is in `planHash`.
  - The on-chain `PayeeLeaf` is unchanged.
  - CZ-15 may pay an alternate only at its bound `resource`, and only when the live 402 `payTo` equals the bound `payee`. The observation then carries the bound `serviceId`.
- **Alpha: required:**
  - (a) CZ-13 emits `alternates: []` (and so no alternate leaves) until `Plan` 1.4 lands. The owner then never approves a payee Czar cannot attribute.
  - (b) **Attribution guard:** a receipt counts toward a supplier only when the `payTo` in its `dedup_key` equals the step's `payee`. Rating binding (SCR-160 §7.2), health facts (§6) and counts (§9.2) skip non-matching rows. They keep their settlement facts but are never attributed. This covers already-signed alternate payments, which exist only in local sessions: there is no testnet history.
- **Deferred:** `alternateServices` and `Plan` 1.4. **Trigger:** before alternates are re-enabled.

## 5. Result cards and counters

- **`amountDisplay`:**
  - **Canonical:** the sum of the objective's settled `LedgerReceipt.amount` values (the same CZ-19 `receiptsForLedger` facts that `listReceiptsRoute` reads), formatted by the same `formatUsd`.
  - **Alpha: deferred.** The field is optional and omitted. **Trigger:** 4A-7 may add it if it reuses that read path without a new query; otherwise post-alpha.
- **Counters:** the server has no metrics producer. Structured log events are the alpha form of the SCR-160 §8.3 counters (as SCR-158 §5 did for the signer).
  - **Alpha: required.** Events, with enum fields only, under the logging allowlist:
    - `ratings_prompt_shown` `{surface, steps}`
    - `ratings_posted` `{surface, value}`
    - `ratings_corrected` `{surface}`
  - The event names are fixed so a later metrics producer can map them one to one. Prometheus counters are stage 2.

## 6. A paid call with no HTTP response

- **Canonical `StepResult`:**
  - `status = "no-response"` (already in the enum)
  - `fields = []`, `flags = []`, no `bodyRef`
  - `bodyCommit = NO_RESPONSE_COMMIT = keccak256(utf8("czar:no-response:v1"))`, exported from `@czar/hashing`
  - The sentinel is explicit and can never equal a real body's commitment. `keccak256` of empty bytes is **not** used, because that would claim an empty body was received.
- **Acceptance:** CZ-16's `delivery` check is `fail`, with reason `no-response`.
- **Receipt:** when the payment settles, CZ-17 signs the receipt leaf as for any settled call, carrying that `StepResult`'s `bodyCommit`. A third party sees a paid call with no response.
- **H1 attribution (amends SCR-161 §5):** `delivered = 0`, and H1 for a settled no-response call, only when **seller failure is evidenced**:
  - (a) no resume, crash recovery or lease loss happened between `auth.signed` and the final attempt
  - (b) the final attempt ended with a seller-side transport outcome: connection refused, connection reset, or a timeout after the connection was established
- **Otherwise `delivered = NULL` and no fact.** This covers DNS failure, network unreachable, a local abort, a resume after a crash, and lease loss.
- CZ-15 records the outcome code of each attempt in `step_executions` (`call.attempt`, enum codes only).
- **Alpha: required.** This StepResult shape is what 4A-2's producers emit for this case, and the H1 rule replaces SCR-161 §5's unconditional `delivered = 0`.
- **Tests:**
  - settle + connection reset → H1
  - settle + resume after a crash → no fact
  - settle + DNS failure → no fact
  - the `StepResult` validates and its `bodyCommit` equals the sentinel

## 7. #180 review (H3 from mined job history): accepted

- `job-chain-adapter.ts` reads the complete mined event history of the exact `(escrow, jobId)` from the job's opening block, in `indexer.getLogsBlockRange` chunks. An incomplete range is unknown evidence and never a fact.
- H3 fires on a verified `JobRejected` (with the excluded reasons kept out) or on expiry with no `JobSubmitted` in complete history. This is the canonical source.
- **The same history proves SCR-160 §5.2's `delivered = 0` for `Expired` from `Funded`** (complete history with no `JobSubmitted`). No second source is designed.
- **Deferred** with the job path: the trigger is "before `routing.jobEnabled` is turned on".

## Summary for the orchestrator

| # | Item | Alpha |
|---|---|---|
| 1 | H4 clearing producer | deferred (H4 permanent in alpha) |
| 2 | Gateway and job StepResult/receipt | deferred (rails off) |
| 3 | Ownership via `objectives.envelope_ref` | **required** |
| 4 | No alternates emitted; payee attribution guard | **required** (Plan 1.4 deferred) |
| 5 | `amountDisplay` | deferred (optional) |
| 5 | Rating log events | **required** |
| 6 | No-response StepResult sentinel; evidenced-only H1 | **required** |
| 7 | #180 H3 source | accepted; `delivered = 0` from history deferred with jobs |

## Decision
- Architect rulings under Zaryab's delegation. Recorded by his merge.
