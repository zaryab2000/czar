# SCR-143: Who builds a job step's `StepResult`, the durable order from job completion to `done`, and the Track A job-route guard

| Field | Value |
|---|---|
| ID | SCR-143 |
| Filed by | chief architect, 2026-10-26, from the PR #86 (TA-09 / T-122) review relayed by the Lane Orchestrator |
| Spec and section | CZ-14 §5 step 1; CZ-15 §5.1, §5.4 step 5, §5.6 (`server-planning-and-payment.md`); CZ-16 §5.5, §5.7 (`server-acceptance-evidence-selection.md`); `@czar/config` |
| Status | Accepted (Zaryab's delegation for Track A integration rulings; recorded by his merge) |

## Problem
- PR #86 maps an escrow `Completed` job to step `done` without persisting a `StepResult`. Dependent steps and objective completion read `step.result`, so a paid, accepted job can end "No content was delivered." That is a P1.
- CZ-15 §5.4 step 5 says "deliverable body → §5.6", but doesn't say who runs it, from what record, or in what order relative to `done`.
- CZ-16 §5.5 records the evaluator's decision in `acceptance_decisions` without naming which upload it matched.
- The evaluator (T-055, Lane 3) is held for Track B. Track A is vault-direct `x402-exact` only (Track A payment-path map). Unlike Gateway (SCR-141), nothing stops the router from choosing `erc8183-job` today.

## Proposed change

### 1. Ownership: the evaluator decides; the payer builds the result
- **Lane 3 (CZ-16, T-055)** owns the decision and the matched deliverable. It never writes `StepResult` or step state.
  - Rationale: the evaluator is a separate service under its own key, K7 (CZ-16 §5.6, conflict of interest).
- **Lane 2 (CZ-15)** owns the `StepResult`, exactly as on the x402 path.
  - It runs the §5.6 boundary on the matched bytes: store (already stored), P-01, then P-02. It validates against `step-result.schema.json` and persists.
  - It does **not** re-run the CZ-16 checks. The step's acceptance report is the evaluator's `reportHash`.
- One producer of `StepResult` for every rail.

### 2. Durable record (amends CZ-16 §5.7)
- `acceptance_decisions` gains `deliverableHash` (`Hash32`): the `contentHash` of the upload the evaluator matched (CZ-16 §5.5 step 2).
  - It is required when `decision = complete`.
  - It may be null on `reject` (for example `deliverable-missing`).
- The row is written in state `Pending` **before** the `complete`/`reject` transaction (unchanged). Its `reportHash` names an `acceptance_reports` row with this `jobKey`.
- **Retention:** the `payer_job_deliverables` row `(jobKey, deliverableHash)` and its object-store body are not purged until that step's `StepResult` is persisted.

### 3. Order and retry (amends CZ-15 §5.4 step 5)
Each stage is idempotent by `jobKey` and resumes from durable state.

**Evaluator (Lane 3):**
1. Match the upload by `contentHash`.
2. Persist the `AcceptanceReport`.
3. Insert `acceptance_decisions` (`Pending`, with `deliverableHash`).
4. Send K7 `complete`/`reject` and record `txHash` (`Sent`).
5. On the mined event → `Confirmed`. If someone else decided first → `Observed` (unchanged rule).

**Payer (Lane 2):**
1. The escrow reaches `Completed` → `syncJob` → `spent` (unchanged).
2. Read the `acceptance_decisions` row for `jobKey`.
   - It must have `decision = complete`, state `Confirmed` or `Observed`, and a non-null `deliverableHash`.
   - Otherwise the step stays `pending` and is retried on the next dispatcher pass. **Never `done`.**
3. Load the body through `payer_job_deliverables(jobKey, deliverableHash).body_ref`. Check that `keccak256(body) = deliverableHash`.
   - A mismatch, or a missing body, keeps the step `pending` and raises alert `job-result-missing`. Never `done`.
4. Run P-01 and P-02, then build and schema-validate the `StepResult` (quarantine rules as on x402, D76).
5. In **one database transaction**: persist `step.result`, append the execution phase, and set the step `done`.

- `Rejected`, `Expired` and refunded jobs end `failed` with their `StepError` (unchanged). No `StepResult` is needed.

### 4. Invariant for every rail (amends CZ-15 §5.1)
- A paid step (`x402-exact`, `gateway-nano`, `erc8183-job`) becomes `done` only in the same transaction that persists its schema-valid `StepResult`.
- An unpaid step follows its own D82 hand-off states.

### 5. Job route off in Track A (amends CZ-14 §5 step 1)
- New key `routing.jobEnabled`, boolean, default `false`.
- While it's `false`, a step that matches CZ-14 §5 step 1 (specialist agent supplier, acceptance before payment, or `unitAmount ≥ routing.jobThresholdAtomic`) is not routed to `erc8183-job`. It ends `unsupported-offer`.
- The planner (TA-08 code) must respect the key.
- The default changes to `true` only by a later SCR, after the T-055 integration and the Lane 2 job-result builder (§3 payer side) both merge.

## PR #86 may merge with the job path failing closed
- **Guard A, before money moves:**
  - In the dispatcher's `erc8183-job` branch, if `routing.jobEnabled` is `false`, the step ends `failed` with `StepError` `unsupported-offer` **before** `openJob`.
  - No job is opened, nothing is reserved, the envelope's cap is released at close.
- **Guard B, whatever the key says:**
  - Escrow `Completed` maps to `done` only through §3 payer steps 2–5.
  - Until those exist, `Completed` maps to `pending` with alert `job-result-missing`.
  - The mapping `Completed → done` is removed.
- **Invariant test (§4):** the dispatcher refuses to mark any paid step `done` without a persisted, schema-valid `StepResult`.
- **Required tests in #86:**
  - Guard A: no `openJob` call while the key is `false`.
  - Guard B: `Completed` without a decision row stays `pending`.
  - The §4 invariant on the x402 path.

## Affected tasks
- **T-122 / TA-09 (Lane 2, PR #86):** Guards A and B, the §4 invariant, and their tests. Merge dependency: none beyond this SCR.
- **TA-08 follow-up (Lane 2, already merged as #80):** the planner respects `routing.jobEnabled`. A small follow-up PR, before T-050a.
- **T-055 (Lane 3, Track B):** the `deliverableHash` column, the §3 evaluator order and retention.
- **New Lane 2 Track B item:** the job-result builder (§3 payer steps 2–5), after T-055. Then a later SCR sets `routing.jobEnabled = true`.
- **`@czar/config` (architect, this change):** `routing.jobEnabled`.

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.

## Applied
- CZ-14 §5 step 1 job-route switch; CZ-15 §5.1 invariant and §5.4 step 5 (`server-planning-and-payment.md`)
- CZ-16 §5.7 `acceptance_decisions.deliverableHash` and retention (`server-acceptance-evidence-selection.md`)
- `@czar/config`: `routing.jobEnabled`
- Task notes on T-122, T-055 (`phase-1-tasks.md`)
