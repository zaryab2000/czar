# SCR-160: Flow 4A, the owner's rating as the only quality signal; health facts; ranking by rated share

| Field | Value |
|---|---|
| ID | SCR-160 |
| Filed by | chief architect, 2026-10-30, from Zaryab's decisions F4-01 to F4-07 (30 Oct) and the Flow 4A technical PRD v3 |
| Spec and section | spec 02 §4.15 (`StepResult` 1.1), new §4.28 (`Rating`), §4.19 (`RankingDecision` 1.2), §4.5 (`Plan` 1.3 `approvalReasons`), §7.1 identifiers, §9.2 routes; `openapi.yaml`; CZ-13 (approval reasons); CZ-15 §5.2 (observation rows), §5.6; CZ-16 §5.4 (`obs_id` value); CZ-17 §5.1 (`obs_id` value); CZ-18 §5.2, §5.4, §5.5, §5.6, §12; CZ-19 §5.4 (settlement facts as the gate); CZ-20 lab expectations; CZ-22 §5.1, §12 (result cards); CZ-11 §8 (`audit_local` kind); cross-cutting §4 (allowlist, metrics) and §5.1 (codes); `phase-1-tasks.md` |
| Status | Accepted (Zaryab's decisions F4-01 to F4-07; recorded by his merge) |

This SCR is the normative specification of Flow 4A. The builder builds from it and from the files it amends in this PR. Nothing outside `docs/specs/` is a source of truth. Where an older CZ-18 sentence (Beta posteriors, `n_eff`, `pol_default_v1`, latency or cost terms, `fill_rate`, `delivery` as a dimension) contradicts this SCR, this SCR wins; those sentences are superseded and marked so in place.

Naming: the owner's judgement is a **rating** (`Rating`, `ratings`, `/v1/ratings`). The word "outcome" stays reserved for the existing MCP `report_outcome` / `POST /v1/outcomes` (CZ-24 input), which this SCR does not change.

---

## 1. Decisions this SCR records (Zaryab, 2026-10-30)

| # | Decision |
|---|---|
| F4-01 | No latency anywhere in evidence or ranking. No timing capture, no latency column, no latency term. |
| F4-02 | No inference from the owner's behaviour (cell edits, kept cells, re-runs). No verdict weights. |
| F4-03 | No fill rate for any paid step. `expectedKeys` on paid steps is not derived; `local` steps keep `expectedKeys = taskSpec.fields` (D82). The CZ-16 `requirement` check keeps its existing inputs. |
| F4-04 | The only quality signal is the paying owner's explicit **good** or **bad** on a delivered result: one rating per supplier per objective, bound to every settled payment that supplier received for that objective, counted once, written only by the owner of the vault that paid. |
| F4-05 | Four machine facts put a supplier behind the owner's approval or block it (health facts, §6). They never raise a supplier and never enter the score. |
| F4-06 | Earned autonomy (CZ-24) is unchanged by this SCR. |
| F4-07 | A rating may be changed once within `rating.windowDays` (14) of delivery; after that it is frozen. |

## 2. Invariants (every implementation and every test must hold them)

1. **The gate is a fact, never an inference.** An `observations` row is eligible for a rating only when `settled_at IS NOT NULL AND released_at IS NULL` (jobs: additionally `job_state = 'Completed'`), set only from a CZ-19 chain fact (vault `Settled`, `JobFunded`, job `Completed`) or the Gateway API row `completed`. No code sets `settled_at` from an HTTP 200, a `PAYMENT-RESPONSE` header or a merchant claim.
2. **Only the payer judges.** A rating is accepted only from a principal that resolves to the user who owns the vault that paid (§7.4 check 5). Devices and app sessions of that user share the right. Users with `users.controlled = true` have no right.
3. **One rating per supplier step per objective, counted once.** A rating binds to every eligible receipt (`obs_id`) of its `(objective_id, step_index)`. The ranker counts rating records, never receipts.
4. **Health facts never raise a supplier.** They add `approvalReasons` or exclude; they never enter the ordering among rated suppliers.
5. **Append, never overwrite.** `ratings` rows are never updated or deleted. A correction is a new row with `supersedes`. `observations` columns `settled_at`, `released_at`, `responded_at`, `delivered`, `settlement_tx` change only from `NULL` to a value; `job_state` may advance.
6. **Unrated is never scored.** A supplier with zero rating records for the `(network, service_id, version_id, task_class)` has no score, is listed in `RankingDecision.unverified[]` with `reason = "unrated"`, and any plan step that uses it carries `approvalReasons` containing `"unrated"` (§9.3).
7. **No model decides anything here.** Health facts, eligibility checks, counts, ordering and explanation strings are code.

## 3. Identifiers (spec 02 §7.1)

| Id | Format | Who mints | Rule |
|---|---|---|---|
| `obs_id` | `obs_` + lowercase hex(keccak256(utf8(`dedupKey`)))[0:32] | server (CZ-15 at `auth.signed`; jobs at `JobOpened`) | **Replaces** the random value at `apps/server/src/main.ts` (`obs_${random}`). Stable across crash-resume, unique per payment. `@czar/hashing` exports `obsId(dedupKey)` and `dedupKey(paymentRef)`. |
| `dedupKey` | `x402-exact`: `"x402-exact:" + network + ":" + lower(payer) + ":" + lower(payTo) + ":" + nonce`; `gateway-batched`: `"gateway-batched:" + network + ":" + lower(pocket) + ":" + lower(payTo) + ":" + nonce`; `erc8183-job`: `"erc8183:" + network + ":" + lower(escrowContract) + ":" + decimal(jobId)` | server | `nonce` as `0x` + 64 lowercase hex. This is SL `dedup_key` (CZ-18 §5.4) made exact. |
| `ratingId` | `rtg_<Ulid>` | server | `common.schema.json#/$defs/RatingId` |
| `service_id` for an ERC-8183 provider | `"svc_" + hex(keccak256(utf8(network + "\|" + lower(providerAddress) + "\|" + lower(escrowContract))))[0:32]` | server | `@czar/hashing` `serviceId()`. `providerAddress` is the SCR-121 proven address, never an x402 `payTo`. |

The receipt leaf's `obs_id` therefore carries the derived value. No leaf shape and no signature changes (reported to the Flow 7 review).

## 4. `StepResult` 1.1 (spec 02 §4.15; `schemas/step-result.schema.json`)

> **Timing (SCR-161):** the schema file stays at 1.0 until package 4A-2, because every StepResult producer is in the payer code that 4A-2 changes. The architect applies the 1.1 schema edit in the same window as 4A-2; the rules below are final.

- `schemaVersion` const `"1.1"`.
- New required fields: `callIndex` (integer 0–4095; the authorization index for vault-direct, the nanopayment index for pockets, `0` for a job), `obsId` (`SlObsId`).
- New optional field: `subjectIndex` (integer ≥ 0; the `TaskSpec` subject this call served, D84).
- **DECIDED:** one `StepResult` per paid call. CZ-15 writes one `step_executions` row with `phase = "call.result"` per call, `payload` = the `StepResult`.
- No `latencyMs`.

## 5. `observations` rows (CZ-15 §5.2 amendments; CZ-18 §5.5 replacement)

### 5.1 Table

The CZ-18 §5.5 row `observations | obs_id, ObservationCore JSON, sig, received_at` is **replaced** by:

```sql
ALTER TABLE users ADD COLUMN controlled boolean NOT NULL DEFAULT false;

CREATE TABLE observations (
  obs_id text PRIMARY KEY CHECK (obs_id ~ '^obs_[0-9a-f]{32}$'),
  user_id text NOT NULL REFERENCES users(user_id),
  vault text NOT NULL CHECK (vault ~ '^0x[0-9a-f]{40}$'),
  network text NOT NULL CHECK (network ~ '^eip155:[0-9]+$'),
  rail text NOT NULL CHECK (rail IN ('x402-exact','gateway-batched','erc8183-job')),
  service_id text NOT NULL,
  version_id text NOT NULL DEFAULT 'ver_unknown',
  task_class text NOT NULL,
  objective_id text NOT NULL REFERENCES objectives(objective_id),
  envelope_ref text NOT NULL CHECK (envelope_ref ~ '^eip155:[0-9]+:0x[0-9a-f]{40}:[0-9]+$'),
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 63),
  call_index integer NOT NULL CHECK (call_index BETWEEN 0 AND 4095),
  payment_ref_hash text NOT NULL CHECK (payment_ref_hash ~ '^0x[0-9a-f]{64}$'),
  payment_id text NOT NULL,
  dedup_key text NOT NULL UNIQUE,
  delivered smallint CHECK (delivered IN (0,1)),
  job_state text CHECK (job_state IS NULL OR job_state IN ('Opened','Funded','Submitted','Completed','Refunded','Released','Expired')),
  controlled boolean NOT NULL DEFAULT false,
  settlement_tx text CHECK (settlement_tx IS NULL OR settlement_tx ~ '^0x[0-9a-f]{64}$'),
  responded_at timestamptz,
  settled_at timestamptz,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (envelope_ref, step_index, call_index),
  CHECK (settled_at IS NULL OR released_at IS NULL)
);
CREATE INDEX observations_service ON observations(network, service_id, version_id, task_class, created_at DESC) WHERE settled_at IS NOT NULL;
CREATE INDEX observations_objective ON observations(objective_id, step_index, call_index);
CREATE INDEX observations_user ON observations(user_id, created_at DESC);
```

- `vault` is the paying vault: for a pocket row the pocket's vault; for a job row the vault that funded the escrow.
- `controlled` is copied from `users.controlled` at insert.
- `version_id` is the CZ-18 `service_versions.version_id` current at probe-before-plan; `'ver_unknown'` when none exists.

### 5.2 When rows are written and settled (the gate)

| Rail | Row written | `settled_at` set when (CZ-15 calls `markSettled(obs_id, now(), tx)`) | `released_at` set when (`markReleased(obs_id)`) |
|---|---|---|---|
| `x402-exact` | at `auth.signed`, `responded_at` and `delivered` NULL; `call.result` fills them (SCR-161 §5) | CZ-19 `authorizations.settled` is true for `(reservationId, index)` (the payer's settle phase, CZ-15 §5.2 step 6) | the index is released unused at `finalize` (step 8) |
| `gateway-batched` | at nanopayment signing, filled at the response (SCR-161 §5) | the Gateway row for `(pocket, nonce)` is `completed` (CZ-19 §5.6 poll) | the Gateway row is `failed` |
| `erc8183-job` | at `JobOpened` (`delivered = NULL`) | `JobFunded` is mined | the job is cancelled or `Released` unfunded |

- `settled_at` is the server clock when CZ-15 first observes the fact; `settlement_tx` is the hash when known (block timestamps are stage 2).
- `responded_at`: x402 and Gateway, when the response arrived; jobs, when the job reached `Completed`, `Refunded` or `Expired`.
- **`delivered`:** `1` when the CZ-16 `delivery` check passed; `0` when it failed, or the body was quarantined `injection-suspect` with the screen available; `NULL` for every "never a fact" case in §6.2. For a job: `1` on `Completed`, `0` on evaluator reject or `Expired` from `Funded`, `NULL` otherwise.
- **Idempotent on `obs_id`:** every write is `INSERT … ON CONFLICT (obs_id) DO UPDATE` for NULL→value columns only. Resume re-derives `obs_id` from the stored `PaymentRef`.
- **Mapping for CZ-24:** `payment_id` lets MCP `report_outcome` (keyed by `paymentId`) resolve to one row. `report_outcome` never creates a rating.

## 6. Health facts (new; CZ-15 writes, CZ-13 and CZ-18 read)

### 6.1 Table

```sql
CREATE TABLE supplier_health (
  fact text NOT NULL CHECK (fact IN ('settled-not-delivered','repeated-unsettled-failure','job-failed','injection-blocked')),
  obs_id text NOT NULL REFERENCES observations(obs_id),
  user_id text NOT NULL REFERENCES users(user_id),
  network text NOT NULL,
  service_id text NOT NULL,
  version_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  cleared_by_obs_id text REFERENCES observations(obs_id),
  PRIMARY KEY (fact, obs_id)
);
CREATE INDEX supplier_health_open ON supplier_health(network, service_id, user_id) WHERE cleared_at IS NULL;
```

### 6.2 The four facts

| Fact | Rail | Condition (evaluated by code from stored rows, at the moment named) | Effect while uncleared | Shared to I-F-7 |
|---|---|---|---|---|
| H1 `settled-not-delivered` | x402, Gateway | at `markSettled`: the row has `settled_at` set and `delivered` is `0` or `NULL` after CZ-15 exhausted `payer.callRetries` within `validBefore` | plan steps using this supplier for this owner carry `approvalReasons += "health-fact"` | yes |
| H2 `repeated-unsettled-failure` | x402, Gateway | at `markReleased`: this owner's last `health.consecutiveFailures` (3) rows for this `(network, service_id)` all have `released_at` set, with no settled row among them | same as H1 | no |
| H3 `job-failed` | ERC-8183 | at `syncJob`: `job_state` becomes `Expired` from `Funded` (nothing submitted), or the evaluator rejected with reason `reportHash`, `czar:deliverable-missing` or `czar:late` | same as H1 | yes |
| H4 `injection-blocked` | all | at the boundary result: the report's `flags` contains `injection-quarantined` and its `limits` does not contain `screen-unavailable` | the supplier is excluded from candidates (`RankingDecision.excluded[]` with `gate = "health-blocked"`) | yes |

- **Never a fact (Czar's own failures):** `screen-unavailable`, sandbox timeout, `czar:undecided`, `Expired` from `Submitted`, `czar:fees-changed`, `czar:owner-froze`, `czar:unfunded-submit`, a resume past `validBefore`. These write nothing to `supplier_health`.
- **Writing:** `INSERT … ON CONFLICT (fact, obs_id) DO NOTHING`.
- **Clearing:**
  - H1, H2, H3 are cleared **per owner**: when a plan step for the same `(network, service_id)` approved by that owner later settles with `delivered = 1`, every uncleared H1/H2/H3 row of that owner and supplier gets `cleared_at = now()` and `cleared_by_obs_id` = that row. The rows stay.
  - H4 is cleared only when a new `service_versions` row exists for the service (`shapeHash` change, CZ-18 §5.3b).
- **Reading:** CZ-13 and CZ-18 read `supplier_health WHERE cleared_at IS NULL`.
- `healthFacts(rows, reports, config)` is a pure function in `apps/server/src/evidence/health.ts`, unit-tested per fact and per "never a fact" case.

## 7. `Rating` (spec 02 new §4.28; `schemas/rating.schema.json`)

### 7.1 Stored object

| Field | Type | R | PC | Rule |
|---|---|---|---|---|
| `schemaVersion` | const `"1.0"` | yes | SO | |
| `ratingId` | `RatingId` | yes | SO | server-minted |
| `userId` | string | yes | SO | the owner |
| `vault` | `Address` | yes | SO | the paying vault |
| `objectiveId` | `ObjectiveId` | yes | SO | |
| `stepIndex` | integer 0–63 | yes | SO | the producing step (§7.3) |
| `network` | `Caip2` | yes | SO | from the receipts |
| `serviceId` | `SlServiceId` | yes | SO | from the receipts |
| `versionId` | `SlVersionId` or `"ver_unknown"` | yes | SO | from the receipts |
| `taskClass` | string ≤ 128 | yes | SO | from the step |
| `value` | enum `good` \| `bad` | yes | SO | binary; no third value, no number |
| `obsIds` | array of `SlObsId`, 1–4096 | yes | SO | every eligible receipt of the step at write time; resolved by the server, never trusted from the client |
| `surface` | enum `cli` \| `web` | yes | SO | set by the route |
| `supersedes` | `RatingId` or null | yes | SO | the one allowed correction (§7.5) |
| `createdAt` | `Timestamp` | yes | SO | server time |

Never present: cell values, subjects, file names or paths, free text.

### 7.2 Tables

```sql
CREATE TABLE ratings (
  rating_id text PRIMARY KEY CHECK (rating_id ~ '^rtg_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id text NOT NULL REFERENCES users(user_id),
  vault text NOT NULL CHECK (vault ~ '^0x[0-9a-f]{40}$'),
  objective_id text NOT NULL REFERENCES objectives(objective_id),
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 63),
  network text NOT NULL,
  service_id text NOT NULL,
  version_id text NOT NULL,
  task_class text NOT NULL,
  value text NOT NULL CHECK (value IN ('good','bad')),
  surface text NOT NULL CHECK (surface IN ('cli','web')),
  supersedes text REFERENCES ratings(rating_id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ratings_supplier ON ratings(network, service_id, version_id, task_class, created_at DESC);
CREATE INDEX ratings_objective ON ratings(objective_id, step_index, created_at DESC);
CREATE UNIQUE INDEX ratings_supersedes ON ratings(supersedes) WHERE supersedes IS NOT NULL;

CREATE TABLE rating_receipts (
  obs_id text PRIMARY KEY REFERENCES observations(obs_id),
  rating_id text NOT NULL REFERENCES ratings(rating_id)
);

CREATE VIEW ratings_effective AS
  SELECT DISTINCT ON (r.objective_id, r.step_index) r.*
  FROM ratings r
  WHERE NOT EXISTS (SELECT 1 FROM ratings n WHERE n.supersedes = r.rating_id)
  ORDER BY r.objective_id, r.step_index, r.created_at DESC, r.rating_id DESC;
```

- `rating_receipts` enforces one rating per receipt at the database level. A correction moves the receipts to the new row in the same transaction (`UPDATE rating_receipts SET rating_id = $new WHERE rating_id = $old`).
- Grants: `czar_api` owns everything; I-F-7's `czar_social` role gets `SELECT` on `observations`, `ratings`, `ratings_effective`, `supplier_health` only.

### 7.3 Producing step (attribution)

- A step is **producing** for an objective when the stored `results.provenance` (the `Result.provenance[]` of `openapi.yaml`) contains an entry with that `stepIndex` and `accepted = true`.
- Only producing steps may be rated. A step whose output only fed another step (a search that found the URL for an extract) is never rated; it gets health facts only.

### 7.4 Server checks, in order (both write routes; `czarCode` values per cross-cutting §5.1)

1. Request schema → `400 validation`.
2. `objectives.user_id = principal.userId` and a `results` row exists for the objective → else `404 unknown-objective`.
3. `users.controlled = true` for the principal → `403 controlled-user`.
4. The step is producing (§7.3) → else `422 not-producing`.
5. Resolve the eligible rows: `observations WHERE objective_id = $1 AND step_index = $2 AND settled_at IS NOT NULL AND released_at IS NULL AND (rail <> 'erc8183-job' OR job_state = 'Completed')`. Empty → `409 nothing-settled`. Every row's `vault` must equal the owner's vault for that objective (`envelopes` join on `envelope_ref`) → else `403 not-your-payment`. (This is the Unfairness Report's checks 2 and 3 in Phase 1: the principal is the authenticated owner, the owner owns the paying vault, and each settlement is a CZ-19 or Gateway fact. Check 1, "a trusted issuer", is Czar's own server, which wrote the row at the call; a T-049 signed `evidence_receipts` row with the same `obs_id` is linked when present, not required.)
6. Window: `now() ≤ results.created_at + rating.windowDays` → else `409 window-closed`.
7. `supersedes`: when `ratings_effective` has a row for `(objective_id, step_index)`, the request must name it → else `422 supersedes-required`; when named, it must exist, belong to the caller, be for the same `(objective_id, step_index)`, and have `supersedes IS NULL` (one correction only) → else `422 bad-supersedes`.
8. In one transaction: insert the `ratings` row; insert `rating_receipts` for every resolved `obs_id` (or move them from the superseded row).
9. Write outbox event `rating.recorded` `{ratingId, objectiveId, stepIndex}` (I-F-7 consumes it).
10. Request a ranking refresh (§9.5, debounced).

### 7.5 Window and correction (F4-07)

- `rating.windowDays` (14) counts from `results.created_at`.
- At most one correction per `(objective_id, step_index)`: a second row with `supersedes` = the first. Both rows stay; receipts move; `ratings_effective` shows the newest. A third row is refused.
- An unanswered prompt leaves nothing: no row, no inference, no reminder.

### 7.6 Routes (`openapi.yaml`; this PR adds them)

| Route | operationId | Auth | Body / query | Response |
|---|---|---|---|---|
| `POST /v1/ratings` | `submitRating` | DeviceToken (K15), `Idempotency-Key` (02 §9.3), bucket `daemon` | `RatingRequest {objectiveId, stepIndex, value, supersedes?}` | `202 RatingAccepted {ratingId, objectiveId, stepIndex, value, receipts, windowClosesAt}` |
| `GET /v1/objectives/{objectiveId}/rating-prompt` | `getRatingPrompt` | DeviceToken | — | `200 RatingPrompt {objectiveId, deliveredAt, windowClosesAt, steps: [{stepIndex, merchantLabel, receipts, effectiveRating: good\|bad\|none, ratingId?, canRate, canCorrect}]}` |
| `POST /v1/app/ratings` | `submitAppRating` | AppSession, `Idempotency-Key`, `appRateLimit` | `RatingRequest` | `202 RatingAccepted` |
| `GET /v1/app/results` | `listAppResults` | AppSession, `Cursor`, `Limit` | — | `200 Page<AppResultCard>` |

- `merchantLabel` = the host name of `Result.provenance[].origin` for the step (never the full URL).
- `canRate` = producing ∧ at least one eligible receipt ∧ inside the window ∧ no effective rating. `canCorrect` = inside the window ∧ an effective rating exists ∧ it has `supersedes IS NULL`.
- `AppResultCard = {objectiveId, deliveredAt, kind, stepCount, suppliers: [{stepIndex, merchantLabel, merchantIsCzar, receipts, effectiveRating, ratingId?, canRate, canCorrect}], amountDisplay?, windowClosesAt}`; `kind` = `TaskSpec.kind`; `amountDisplay` from `ledger_receipts` when present; no cell values, subjects or file names.
- The device routes authenticate with `authenticateDevice` inside the handler, as the other device routes do; the app routes use `appSessionVerifier`, `appRateLimit`, `parseIdempotencyKey` and `apiContracts` validation, as `createFreezeIntentRoute` does.

## 8. Prompt surfaces

### 8.1 `czar result` (daemon CLI; CZ-11)

- After `writeBackResult` prints `Result written: <path>` (SCR-147), the command calls `getRatingPrompt` and, for each step with `canRate`, prints one line and reads one key from stdin:

  `Was the result from {merchantLabel} good?  [g] good  [b] bad  [enter] skip`

- `g` → `POST /v1/ratings {value: "good"}`; `b` → `"bad"`; enter or any other key → nothing. A step already rated prints its current value and offers `[c] change` only while `canCorrect`; `c` then asks `[g]/[b]` and posts with `supersedes`.
- No TTY, `--no-prompt`, or a scripted run → no prompt and no output. `czar result <objectiveId>` run again inside the window shows the prompt (it re-polls the final status and re-reads the write-back file if present).
- After a post: `Thanks. Czar will rank {merchantLabel} {higher|lower} for tasks like this.`
- One `audit_local` row per post: `kind = 'rating'`, `destination = 'server'`, `bytes`, `payload_hash`, `summary_counts_json = {ratings: 1}` (CZ-11 §8 gains the kind).
- The prompt reads no file and sends ids and one enum only.

### 8.2 Web app (CZ-22 §5.1, §12)

- **Receipts** (`apps/web/app/receipts`): each objective group gets a result card from `listAppResults` with one row per supplier: `"{merchantLabel}: Good · Bad"`. Tap → `POST /v1/app/ratings`. The row shows the current value and a "Change" link while `canCorrect`.
- **Home** (`apps/web/app/home`): a "This week" section with the last 7 days' cards, same controls. Header: `"Czar did {n} tasks this week. Rate any you looked at."` Nothing is pushed.
- Wording (i18n keys `results.rating.*`): "Good"; "Bad"; "Change"; after a post: `"Thanks. Czar will rank {merchantLabel} {higher|lower} for tasks like this."`; after the window: "Rating closed".
- CZ-22 §12's "This was wrong" action is replaced by these cards.

### 8.3 Response-rate counters (cross-cutting §4)

- Server metrics: `czar_ratings_prompts_shown{surface}`, `czar_ratings_posted{surface,value}`, `czar_ratings_corrections{surface}`. Enum labels and counts only.

## 9. Ranking (CZ-18 §5.2 replacement; `apps/server/src/selection/ranking/`)

### 9.1 Inputs

- `ratings_effective` joined to `(network, service_id, version_id, task_class)`.
- `supplier_health WHERE cleared_at IS NULL`.
- `services`, `service_versions` for candidates and `price`.
- Everything keyed by `(network, service_id, version_id, task_class)`; nothing from `selection.marketNetwork` enters (D83 guards unchanged).

### 9.2 Counts (`supplier_counts`, the snapshot)

```sql
CREATE TABLE supplier_counts (
  network text NOT NULL,
  service_id text NOT NULL,
  version_id text NOT NULL,
  task_class text NOT NULL,
  good integer NOT NULL,
  bad integer NOT NULL,
  owners_rated integer NOT NULL,
  owners_bad integer NOT NULL,
  lower_bound double precision,
  lineage_root text,
  policy_version text NOT NULL,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (network, service_id, version_id, task_class)
);
```

- `good` = effective ratings with `value = 'good'`; `bad` likewise; `n = good + bad`. Each rating record counts once.
- `owners_rated` = distinct `user_id` among those ratings; `owners_bad` = distinct `user_id` with a `bad`.
- `lower_bound = WilsonLower(good, n, selection.confidenceZ)` when `n ≥ 1`, else `NULL`.
- `lineage_root = keccak256(utf8(sorted rating_ids joined by ","))` via `@czar/hashing`.
- No decay, no half-life, no weights. A new `version_id` starts at zero.
- **Replaces** the CZ-18 §5.5 `reputation` row (Beta `α`, `β`, `n_eff`). `assessments` is unused in Phase 1.

### 9.3 Ordering rule

1. `C = candidates(task_class)` (CZ-18 §5.3c retrieval; today the registered services); `E, X = filter(C, constraints)` (C4 gates unchanged, including `output-format`).
2. **Blocked:** a candidate with an uncleared H4 → `excluded[]` with `gate = "health-blocked"`, `detail = "injection-blocked"`.
3. **Rated** (`n ≥ 1`): ordered by `lower_bound` descending, then live price ascending, then `service_id` ascending. `ranked[].score = lower_bound`.
4. **Unrated** (`n = 0`): listed in `unverified[]` with `reason = "unrated"`, `n_eff = 0`. Never in `ranked[]`.
5. **Health-flagged** (an uncleared H1/H2/H3 for the querying owner): keeps its position in `ranked[]` (or `unverified[]`), gets badge `health-flagged`, and `features.health_facts` lists the open fact names.
6. **Incidents (I-F-7, when built):** an open incident re-sorts the candidate below every incident-free candidate of its list and adds badge `incident-open`.
7. `ranked[].features` = `{good, bad, owners_rated, owners_bad, lower_bound, health_facts: string[], price_atomic}` (numbers as JSON numbers; `price_atomic` as `Amount6`). `badges` ⊆ `{single-owner, health-flagged, incident-open}` (`single-owner` when `owners_rated = 1`). `missing_dimensions_for_class = ["correctness"]` stays (correctness is only ever the owner's rating).
8. `insufficient_evidence = ranked is empty`.
9. **CZ-13 planning from the decision:**
   - CZ-13 picks from `ranked[]` first. When `ranked[]` is empty and `selection.unverifiedWithApproval` is `true` (it must be), CZ-13 may plan the first `unverified[]` entry (`reason = "unrated"`); the exploration-slot mechanics of N1 are unchanged.
   - **`Plan.approvalReasons`** (schema 1.3, not in `planHash`): the plan carries `"unrated"` when any paid step's supplier is unrated for its task class, and `"health-fact"` when any paid step's supplier has an uncleared H1/H2/H3 for this owner. A plan with a non-empty `approvalReasons` is opened only by the owner's explicit approval (the passkey UserOp); CZ-15 never opens it under earned allowance. `Step.why.summary` names the reason in its templated sentence.
   - `Step.why.alternativesLost[].reason` gains `"unrated"` and `"health-blocked"`; `"unverified"` stays for the schema's compatibility and is not produced.
10. Not here: cost or latency terms, peer medians, posteriors, exploration beyond N1.

### 9.4 `WilsonLower(good, n, z)` (`lower-bound.ts`, no dependency)

- `p = good / n`; `lower = (p + z²/(2n) − z·sqrt(p(1−p)/n + z²/(4n²))) / (1 + z²/n)`.
- `z = selection.confidenceZ` (1.959964, the 95% two-sided normal quantile: a convention, not a tuned weight).
- Test vectors (tolerance 1e-4): `(1,1) → 0.2065`; `(2,2) → 0.3424`; `(5,5) → 0.5655`; `(9,10) → 0.5958`; `(8,10) → 0.4902`; `(3,6) → 0.1876`; `(0,1) → 0.0`; `(46,50) → 0.8116`; `(10,10) → 0.7225`; `(4,5) → 0.3755`.
- Good and bad count equally; the formula has no weight parameter.

### 9.5 Refresh, policy version, serving

- Recompute `supplier_counts` every `selection.snapshotRefreshSeconds` (300) and after every accepted rating, debounced by `selection.ratingRefreshDebounceSeconds` (30). The refresh runs behind the existing leader lease (`executor_leases`).
- `policy_version = "pol_" + hex(keccak256(utf8(JCS({"policy": "ratings-v1", "confidenceZ": <selection.confidenceZ>, "healthConsecutiveFailures": <health.consecutiveFailures>}))))[0:16]`, computed by code at startup (the `SlPolicyVersion` shape, as SCR-137 does for the interim producer). It replaces the literal `selection.policyVersion` key.
- `RankingDecision` 1.2 rows are stored in `ranking_decisions` as today; `query.risk_quantile = 0.05`, `query.weights = {}`; `snapshot_id` = keccak256 of the stored JCS `supplier_counts` snapshot; `snapshot_anchor_tx = null` (SCR-137).
- `findService` / `POST /v1/select` read the snapshot; `snapshot_age` flagged past `selection.snapshotStaleMinutes` (30).

### 9.6 Explanation strings (`explain.ts`; i18n keys `ranking.*`)

- Rated: `"{n} rating(s) from people who paid: {good} good, {bad} bad."`
- Rated, more than one owner: `"{owners_rated} owners rated it: {good} good, {bad} bad."`
- Unrated: `"No ratings yet. Czar will ask before using it."`
- Health-flagged, appended: `" Last time it took payment and delivered nothing; Czar will ask first."` / `" It failed {k} times in a row; Czar will ask first."` / `" It did not deliver the job; Czar will ask first."`
- Blocked (in `excluded[].detail` wording for CZ-22): `"Blocked: it returned text that tried to hijack the agent."`

### 9.7 Worked example (fixture `apps/server/test/selection/fixtures/worked-example.json`; must reproduce)

Three registered suppliers for `data-json.extract`, equal price, one owner:

| | M1 | M2 | M3 |
|---|---|---|---|
| ratings | 5 good, 0 bad | 9 good, 1 bad | none |
| health | none | none | none |
| `lower_bound` | 0.5655 | 0.5958 | null |
| result | `ranked[]` rank 2 | `ranked[]` rank 1 | `unverified[]` `unrated` |

- After the owner corrects one M2 good to bad (8 good, 2 bad): M2 `lower_bound` 0.4902, so M1 ranks first.
- After an H1 fact on M1 for this owner: M1 keeps rank 2 with badge `health-flagged`; a plan using M1 carries `approvalReasons ["health-fact"]`; after the owner approves such a plan and an M1 call settles with `delivered = 1`, the fact clears.
- After an H4 fact on M2: M2 is in `excluded[]` (`health-blocked`) until a new version exists.

## 10. What is removed from CZ-18 (superseded sentences)

- Dimensions `delivery`, `structural`, `requirement`, `latency_p50/p95`, `price_match` as ranking inputs; Beta posteriors, `Beta(1,1)`, `selection.halfLifeDays`, `n_eff`, `selection.nMin`, `BetaQuantile`, `selection.riskQuantile`, `selection.wCost`, `selection.wLatency`, the `score = quality − …` formula, the peer-median rule, `pol_default_v1`, the `"<n_eff> checked calls …"` explanation. CZ-16 results still exist as the use gate and feed `delivered` and H1/H4 only.
- The N1 "required dimensions by payment path" paragraph: there are no dimensions; the job path's only difference is the `Completed` eligibility rule (§5.2).
- The CZ-20 lab expectations `lab-search-slow` (latency) and `lab-extract-schemabreak` (fill): the lab test becomes "`steady` ranks above `flaky` once the owner rates `steady` good; `slow` is listed `unrated`; `schemabreak` gets an H1 fact after three settled undelivered calls".
- Test-buyer (CZ-18 §5.3d): its receipts produce `observations` rows and health facts; they never produce ratings (controlled users). Its selection rule "fewer than `selection.nMin` accepted receipts" becomes "fewer than `selection.testBuyer.minReceipts` (5) settled rows".

## 11. Earned autonomy (CZ-24): unchanged (F4-06)

- No new input, hook or table. Recorded gap for a later SCR: CZ-24 counts acceptance `pass` + settled as positive with no human signal, and a `bad` rating does not lower a limit.

## 12. Configuration (`@czar/config`, each with default and reason)

| Key | Type | Default | Reason |
|---|---|---|---|
| `rating.windowDays` | integer | 14 | F4-07; Airbnb's 14-day transaction-bound review window (x402 Market Unfairness Report §5.2.2) |
| `health.consecutiveFailures` | integer | 3 | F4-05; three unsettled failures in a row put a supplier behind approval (each costs gas on Arc) |
| `selection.confidenceZ` | number | 1.959964 | 95% two-sided normal quantile for the Wilson lower bound; a convention, not a weight |
| `selection.ratingRefreshDebounceSeconds` | integer | 30 | coalesces refreshes after a burst of ratings |
| `selection.testBuyer.minReceipts` | integer | 5 | replaces `selection.nMin` in the test-buyer's selection rule |
| `selection.snapshotRefreshSeconds` | integer | 300 (kept) | CZ-18 |
| `selection.snapshotStaleMinutes` | integer | 30 (kept) | CZ-18 |
| `selection.unverifiedWithApproval` | boolean | `true` (kept; a config test asserts it) | invariant 6 |

- **Removed:** `selection.wCost`, `selection.wLatency`, `selection.riskQuantile`, `selection.halfLifeDays`, `selection.nMin`, `selection.policyVersion` (computed, §9.5). A config test asserts they are absent from the registry.
- **Not added:** `evidence.signReceipts`, any `verdict.*`, `planner.expectedKeysByCapability`, `planner.lookupCapabilities`.

## 13. Privacy, logging, security

- Privacy classes: `observations`, `ratings`, `rating_receipts`, `supplier_health`, `supplier_counts` are `server-only`. `payment_ref_hash`, `payment_id`, `dedup_key`, `vault` never leave the server through any public or social route (I-F-7 cards carry opaque `obs_` ids only).
- Logging allowlist (cross-cutting §4) gains the id prefixes `rtg_` and `obs_`, the enum `fact`, the enum `value`, and the numbers `good`, `bad`, `lower_bound`. `merchantLabel` is never logged.
- `czarCode` additions (cross-cutting §5.1): `unknown-objective`, `controlled-user`, `not-producing`, `nothing-settled`, `window-closed`, `supersedes-required`, `bad-supersedes`, `not-your-payment`.
- Threats handled: rating an unpaid supplier (checks 2, 5); counting one objective many times (one record per `(objective_id, step_index)`; receipts write-once; records counted); a competitor flooding negatives (must pay the target per objective; with I-F-7, incidents count distinct owners); merchant injection (ratings come from the CLI or the app, never from merchant text; P-02 never writes ratings); rewriting history (append-only; one correction inside the window); Czar's outage blamed on a merchant ("never a fact" list); controlled users (`403`); crash-resume duplicates (`obs_id` from the dedup key; NULL→value only); `report_outcome` misread as a rating (never creates one).

## 14. Acceptance tests (all must pass before Flow 4A is called done)

1. A settled paid call → one `observations` row with `settled_at` from the indexer fact; unsettled → `settled_at IS NULL`; a released index → `released_at` set; an unpaid call → no row.
2. `obs_id` is identical across a kill-and-resume of the same payment (vault-direct, pocket, job) and differs across payments; the receipt leaf carries it.
3. A `good` on a producing step with 20 settled calls → one `ratings` row, 20 `rating_receipts` rows, `supplier_counts.good` increases by exactly 1.
4. A non-producing step → `422 not-producing`; no settled call → `409 nothing-settled`; another user's objective → `404 unknown-objective`; a controlled user → `403 controlled-user`; another vault's receipts → `403 not-your-payment`.
5. A second rating without `supersedes` → `422 supersedes-required`; with it → accepted, receipts moved, the first row unchanged, `ratings_effective` shows the second; a third → `422 bad-supersedes`.
6. A post at `results.created_at + 14 days + 1 s` → `409 window-closed`.
7. H1: settled and `delivered = 0` after retries → `supplier_health` row; the next plan with that supplier carries `approvalReasons ["health-fact"]`; after approval and a later delivered settlement, `cleared_at` is set.
8. H2: three consecutive released attempts → fact; two → none; a settled row between them resets the run.
9. H3: `Expired` from `Funded` → fact; `Expired` from `Submitted` → none; evaluator reject → fact; `czar:undecided` → none.
10. H4: `injection-suspect` with the screen available → `excluded[]` `health-blocked`; `screen-unavailable` → nothing; a new `service_versions` row → candidate again.
11. The §9.7 fixture reproduces every stated order and bound; the §9.4 vectors within `1e-4`.
12. An unrated supplier is never in `ranked[]`; a plan using one carries `approvalReasons ["unrated"]` and is never opened under earned allowance; the config test asserts `selection.unverifiedWithApproval = true`.
13. `czar result` on a TTY prints one prompt per producing step; `g` posts `good`; enter posts nothing and leaves no row; no TTY → no prompt; a rerun inside the window offers `change` only while `canCorrect`.
14. The web result card round-trip (Playwright against the local server fixture): Good posts, the card shows it, Change posts the correction, a third attempt is refused.
15. The I-F-7 fixture DDL equals the `observations`, `ratings`, `rating_receipts` and `supplier_health` DDL (string comparison after whitespace normalisation).
16. Removed config keys are absent from the registry snapshot; `pnpm -r typecheck` and `pnpm lint` pass; `python3 -I check-schemas.py` and the Draft 2020-12 validator pass on every schema and example.
17. No log line in the server or daemon test output contains a result body, a file path or a merchant label.

## 15. Build packages (one PR each against `build-v1`, in this order; tests first)

| Package | Contents | Depends on |
|---|---|---|
| 4A-1 Foundations | `obsId`, `dedupKey`, `serviceId` in `@czar/hashing`; `main.ts` obs_id change; `@czar/schemas` regenerated for `rating.schema.json`, `step-result` 1.1, `plan` 1.3, `ranking-decision` 1.2; `@czar/api-contract` for the four routes; config keys added and removed (§12) | this SCR merged |
| 4A-2 Observations + payer | migration (§5.1, §6.1, §7.2, §9.2 tables); `evidence/observations.ts`; CZ-15 write/settle/release points for the three rails; kill-and-resume tests | 4A-1 |
| 4A-3 Health facts | `evidence/health.ts`; CZ-15 evaluation points; clearing; CZ-13 `approvalReasons`; CZ-15 "never under earned allowance" check | 4A-2 |
| 4A-4 Rating intake | `evidence/ratings.ts`; `ratings-routes.ts` (device); `app/results.ts` (`submitAppRating`, `listAppResults`); `getRatingPrompt`; outbox event | 4A-2 |
| 4A-5 CLI prompt | `apps/daemon/src/results/rating-prompt.ts`; `objective-command.ts` hook; `audit_local` kind | 4A-4 |
| 4A-6 Ranking | `selection/ranking/{lower-bound,counts,order,explain,decision}.ts`; `registered/index.ts` returns the §9 decision instead of `ranked: "none"`; snapshot refresh; policy version; worked example; lab expectations; test-buyer rule | 4A-3, 4A-4 |
| 4A-7 Web cards | Receipts and Home cards, "This week", round-trip test | 4A-4 |

- I-F-7's substrate packages may start after 4A-1 (they need the DDL and `obs_id` only); its selection routes need 4A-4 and 4A-6.
- Every package's PR body is the task report required by `CLAUDE.md`.

## 16. Files amended by this PR (the normative text is above; the files carry the shapes)

- `02/schemas/common.schema.json`: `RatingId`.
- `02/schemas/rating.schema.json` (new) and `02/examples/rating.example.json` (new).
- `02/schemas/step-result.schema.json` → 1.1; `02/examples/step-result.example.json`.
- `02/schemas/ranking-decision.schema.json` → 1.2 (`unverified[].reason` enum gains `unrated`; descriptions).
- `02/schemas/plan.schema.json` → 1.3 (`approvalReasons`; `why.alternativesLost[].reason` gains `unrated`, `health-blocked`); `02/examples/plan.example.json`.
- `02/api/openapi.yaml`: `RatingRequest`, `RatingAccepted`, `RatingPrompt`, `AppResultCard`; the four routes.
- `02/data-and-protocol.md`: §4.15 rows, new §4.28, §7.1 rows, §9.2 route rows, change log.
- `02/schemas/README.md`: file list.
- `04/server/server-acceptance-evidence-selection.md`: CZ-18 §5.2 and §5.5 superseded-by notes; CZ-16 §5.4 and CZ-17 §5.1 `obs_id` value note.
- `04/shared/cross-cutting.md`: §4 allowlist and metrics; §5.1 codes.
- `05-build-plan/phase-1-tasks.md`: T-091 note and the 4A packages.

## Decision

- Architect specification under Zaryab's decisions F4-01 to F4-07. Recorded by his merge.
