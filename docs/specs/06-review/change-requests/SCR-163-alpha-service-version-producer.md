# SCR-163: Alpha service-version producer, version drift, and the exact-transfer indexer query (amends SCR-162 §1)

| Field | Value |
|---|---|
| ID | SCR-163 |
| Filed by | chief architect, 2026-10-31, from the orchestrator's 4A-6 question: `RankingDecision.ranked[].version_id` requires an `SlVersionId`, but SCR-162 §1 left alpha observations at `ver_unknown` |
| Spec and section | SCR-162 §1; SCR-160 §5.1, §6.2 (H4 clearing), §9.2, §9.3; `ranking-decision.schema.json` 1.2 `ranked[].version_id` |
| Status | Accepted (Zaryab's delegation; recorded by his merge) |

## Ruling: build the version producer now, minimally (option 1)

- **Rejected: deferring rated ranking until T-115.** Ranking is the point of Flow 4A.
- **Rejected: allowing `ver_unknown` in the decision schema.** It weakens a verified field, and H4 could still never clear.
- **What is built instead:** only the version identity and its table. T-115's capability cards, retrieval and card storage stay in T-115.

## 1. Version id (canonical; replaces the deferral in SCR-162 §1)

- `versionId = "ver_" + hex(keccak256(utf8(JCS({payTo, resource: {url, method}, schemaHash}))))[0:32]`, via `@czar/hashing` `serviceVersionId()`. Its parts:
  - `payTo`: the live 402 `payTo`, lowercase
  - `resource`: the service's registered `resource` (`selection.czarRegisteredServices`; SCR-137)
  - `schemaHash`: keccak256 of the JCS of the validated `extensions.bazaar.schema` that the sanitizer keeps (SCR-137, `registered/index.ts`), or `null` when none is declared
- **Computed by:**
  - the CZ-18 registered selector, at probe-before-plan
  - CZ-15, at the pre-check probe it already makes before signing (CZ-15 §5.2 step 1), from that same live 402
- **The observation's `version_id`** is the value CZ-15 computed from its own pre-check probe for that call. A resumed attempt that skips the pre-check (SCR-159 §1) uses the value saved in its `reserve.sent` pre-checked calls. `ver_unknown` is written only when no probe result exists (for example, rows from before this SCR).

## 2. Table (in the 4A-6 migration)

```sql
CREATE TABLE service_versions (
  network text NOT NULL,
  service_id text NOT NULL,
  version_id text NOT NULL CHECK (version_id ~ '^ver_[0-9a-f]{32}$'),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, service_id, version_id)
);
```

- Every computation upserts: insert on first sight, otherwise update `last_seen_at`.

## 3. Effects

- **Ranking (SCR-160 §9.2–§9.3):**
  - Counts, and `ranked[].version_id`, use the candidate's **current** version: the `version_id` from this query's probe.
  - Ratings bound to an older version don't count toward the current one, because a new version starts at zero (SCR-160 §9.2).
  - A candidate with no successful probe in this query is not ranked. It goes to `excluded[]` with `gate = "probe-failed"`, the existing CZ-13 behaviour.
- **H4 clearing (SCR-160 §6.2) is now live:** when a new `version_id` row appears for the service, every uncleared H4 for it gets `cleared_at`.
- **Rows at `ver_unknown`** never count toward any ranked version.

## 4. Tests (4A-6)

- **Vectors:**
  - the same inputs give the same `versionId`
  - a changed `payTo`, `resource.url`, or Bazaar schema changes it
  - an absent schema gives `schemaHash = null`
- **Probe round trip:** a probe writes `service_versions`, and a second identical probe only moves `last_seen_at`.
- **Counts:** 3 good ratings on version A, then a schema change to version B → B is unrated, and A's counts are kept but not used.
- **H4:** an H4 on version A is cleared when version B is first seen; it stays when the same version is re-probed.
- **Schema:** every `ranked[].version_id` matches `^ver_[0-9a-f]{32}$`; every `unverified[]` entry for a probed candidate carries `version_id`; the decision validates as `RankingDecision` 1.3.

## 5. Version drift inside a step (amendment, 2026-10-31)

- **Within one pre-check:** before reserving or signing, CZ-15 computes the version from each live pre-check of a multi-call step. When the versions differ, the step stops: no reserve, no signature. It ends `failed` with `StepError {code: "service-version-drift", message: "precheck", retryable: false}`.
- **On a resumed, partly paid step:**
  - The new pre-check must also match the `version_id` already saved on the step's settled calls. Those settled calls keep their saved version and are rated under it (SCR-160 §7, §9.2).
  - When the live version differs from the saved one, CZ-15 signs no further call. The settled calls stand, and the step ends `done` with the results it already has (SCR-159 §3), with the remaining indices recorded per call as `service-version-drift`. When it has no paid results, it ends `failed` with `service-version-drift`.
- **Evidence:** a `step_executions` row `precheck.version-drift` with `{serviceId, savedVersionId?, liveVersionIds[]}`. Ids only; no merchant text.

## 6. Selector-to-payer version race (amendment, 2026-10-31)

- **Ruling: stop before payment** (alpha). The owner approved a supplier whose interface and rating were those of version A. Paying version B under A's rating would spend on an unapproved, unrated interface.
- **Where A comes from:** `Plan` 1.3 commits no version, but `Plan.rankingDecisionIds` points to the stored `RankingDecision`, whose `ranked[].version_id` or, for an unrated candidate, `unverified[].version_id` (`RankingDecision` 1.3: an optional field added by this SCR, written by CZ-18 from the query's probe) for the step's `serviceId` is the version CZ-18 used. That is the expected version. The stored decision row is immutable (`ranking_decisions`), so it is the linked record. No `Plan` field is added. When the entry has no `version_id` (no successful probe), CZ-13 cannot have planned that candidate (it is excluded as `probe-failed`).
- **Rule:**
  - At the pre-check, CZ-15 compares the live version with the expected version for the step's `serviceId`.
  - When they differ, it stops before reserving or signing, and ends the step `failed` with `StepError {code: "service-version-drift", message: "selection", retryable: false}`. That is a re-plan case (cross-cutting §5.2).
  - A re-plan treats version B as unrated, so the plan needs the owner's approval (`approvalReasons ["unrated"]`).
  - Until re-planning is wired (SCR-161 §6), the step simply fails.
- **No expected version:** when the plan has no stored decision, or the decision has no entry for the `serviceId` (plans created before this SCR), CZ-15 does not stop for this reason, and it records `selectionVersionId: null` in the evidence row.
- **Evidence:** a `step_executions` row `precheck.version-drift` with `{serviceId, selectionVersionId, liveVersionId, rankingDecisionId}`.
- **Code:** cross-cutting §5.2 gains `service-version-drift` (the interface changed after selection or within a step; not retryable; re-plan).

## 7. Exact-transfer indexer query (CZ-19 §5.4 addition, 2026-10-31)

- **Purpose:** verified transfer provenance for a settled `x402-exact` call. It is used where no HTTP response exists (the no-response receipt, SCR-162 §6), and it may be used for any x402 receipt.
- **Route:** `GET /settlements/x402-transfer`, **internal only**.
  - It is served on the indexer's loopback API and called only by the server (CZ-15, CZ-17).
  - It is never exposed through `openapi.yaml`, the app, or any public host.
- **Query (all required):**
  - `network` (`Caip2`; must equal the indexer's configured chain, else `400`)
  - `vault` (`Address`)
  - `nonce` (`Hash32`, the EIP-3009 authorization nonce)
  - `payTo` (`Address`)
  - `amount` (`Amount6`)
  - `asset` (`Address`; must equal the configured canonical USDC, else `400`)
- **Match rule:** return a transaction only when one indexed, canonical transaction contains both:
  - (a) `AuthorizationUsed(authorizer = vault, nonce)` emitted by `asset`
  - (b) `Transfer(from = vault, to = payTo, value = amount)` emitted by `asset` (6-decimal ERC-20 value)
- **What is not proof:**
  - The vault's booking transaction (`settle` / `Settled`) is never proof.
  - A `Transfer` in a different transaction is never proof.
- **Deduplicating emitters:**
  - On Arc a USDC transfer can also appear as an EIP-7708 native-transfer log (18-decimal value, system emitter) in the same transaction. Matching uses **only** logs emitted by `asset`. The EIP-7708 log is ignored for matching and never counted as a second match.
  - Logs are keyed by `(transactionHash, logIndex)`, so a re-delivered event is one log.
- **Response `200`:**
  - `transferTx`, `blockNumber`, `blockHash`
  - `authorizationUsed: {logIndex, emitter}`
  - `transfer: {logIndex, emitter, from, to, value}`
  - `indexedHead` (the indexer's block at answer time)
- **`404`:** nothing matches yet.
  - The server retries inside its existing bounded reconciliation window (`payer.reconcileSeconds` interval, up to `validBefore + payer.reconcileGraceSeconds` by chain time).
  - It never signs a receipt without a `200`.
  - When the window ends with no proof, the call has no receipt and no H1. It is recorded as `settlement-unproven` in `step_executions`.
- **`409`:** ambiguous. More than one transaction matches, or the matched transaction has more than one `asset` `Transfer` log with exactly these `(from, to, value)`. Fail closed: no receipt, no fact, and the alert `indexer_transfer_ambiguous` (ids only).
- **`400`:** invalid parameters, or `network`/`asset` mismatch.
- **`5xx` or unreachable:** treated like `404` within the window.
- **Tests:**
  - match across both emitters, with exactly one match counted
  - the booking transaction alone → `404`
  - a `Transfer` in another transaction → `404`
  - two matching transfers in one transaction → `409`
  - a wrong asset → `400`
  - a server retry ending in `settlement-unproven` with no receipt

## 8. Tests added by this amendment

- **Drift within a step:** two pre-checks with different versions → no reserve, no signature, `service-version-drift`.
- **Resumed partial step:** 2 settled calls at version A, then a live version B → no new signature; the step is `done` with 2 results, rated under A, and the remaining indices are recorded as `service-version-drift`.
- **Selector race:** the stored `RankingDecision` names A and the live version is B → stop before reserve with `service-version-drift` (`selection`); the evidence row has both ids.
- **No stored decision** → no stop, and the evidence has `selectionVersionId: null`.
- **The §7 indexer tests.**

## Owner and impact

- **Owner:** 4A-6 (Lane 3) builds §1 to §3, test first.
- **CZ-15:** the version computation at its pre-check, the `version_id` written at the observation insert, and §5–§6 belong to 4A-6.
- **Indexer:** §7 belongs to the package that builds the no-response receipt (SCR-162 §6). The route is added to the CZ-19 §5.4 query list.

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.
