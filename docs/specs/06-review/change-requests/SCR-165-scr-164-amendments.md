# SCR-165: Three binding amendments to SCR-164 — incident approval copy, the lesson's supplier, duplicate leads

| Field | Value |
|---|---|
| ID | SCR-165 |
| Filed by | chief architect, 2026-11-05, answering three conflicts the Codex Lane Orchestrator found while integrating SN-2 to SN-6 |
| Spec and section | SCR-164 §3.13.1 (incident approval line), §3.13.2 (lesson approval line), §3.13.3 and §3.18 test 10 (duplicate leads); `docs/specs/02-data-and-protocol/schemas/plan.schema.json` (`steps[].why.lessons[]`) |
| Status | Accepted by Zaryab's merge of the PR that adds this file |

## 1. Incident approval line: no owner count

- **Conflict:** SCR-164 §3.13.1 required "{n} other owners reported bad outcomes…", but the incident's stored `distinct_owners` can include the buyer who is approving. Printing it as "other owners" would then overstate the count.
- **Ruling: the line carries no count.** It becomes:
  > "This supplier has an open incident: several owners recently reported bad outcomes with it. Czar still ranks it as the best available. Approve to use it anyway."
- **Why not a buyer-relative count:**
  - It needs a new immutable Plan field and a recount at plan time, for a number that changes no decision: the buyer is asked to approve either way.
  - The new line is true in every case. An incident opens only at `social.incidentMinOwners` (3) distinct owners, so "several" holds; and it claims nothing about "other" owners, so it stays true when the buyer is one of them, and in the up-to-one-hour gap before the next evaluation pass closes an incident whose recount has dropped.
- **The counts stay public** on the incident thread and in `SocialIncident`, where they describe the incident rather than one buyer's view of it.
- **No schema change.**

## 2. A lesson names its own supplier

- **Conflict:** SCR-164 §3.13.2's approval line names `{serviceId}`, but `Plan.steps[].why.lessons[]` carried no supplier id. For an `avoid` lesson the lesson concerns the supplier that was passed over, so rendering the step's chosen supplier would tell the owner that supplier B "did not do this kind of task well" when the lesson was about A — and B is the one being bought.
- **Ruling: `why.lessons[]` items gain a required `serviceId`** (`SlServiceId`), written by the planner from `social_lessons.service_id`. The approval line renders from it, never from the step.
- **Invariant, asserted in SCR-164 §3.18 test 9:** for an `avoid` lesson, `why.lessons[].serviceId` is never the step's chosen `serviceId`.
- **Why a field and not supplier-neutral copy:** which supplier the lesson concerned is the whole content of the explanation. Supplier-neutral wording ("adjusted the choice within Czar's ranking margin") would hide exactly what the owner is being asked to trust.
- **Why it is safe to make the field required now:** `why.lessons[]` exists only in Plan 1.4, and no 1.4 plan carrying lessons has been emitted anywhere — SN-4, the only producer, is not yet merged. `why` is not in `planHash`, so no hash or approval digest changes. The Plan stays at schema 1.4.

## 3. A duplicate lead is an idempotent repeat, not a record

- **Conflict:** SCR-164 §3.18 test 10 said a repeated origin-only lead "is `duplicate`", while §3.14 requires `202` with the existing `leadId` and its post, and the database's `UNIQUE NULLS NOT DISTINCT (network, origin, path_hint)` prevents a second row from existing to hold that state.
- **Ruling: the `202` idempotent outcome is correct; there is no duplicate record.**
  - Owner API: a repeat returns `202` with the existing `leadId` and `postId`.
  - In a run (a representative answering `find-supplier` with an origin already led): the action publishes nothing new and the run ends `abstain-no-rule`.
  - Either way: no second lead row, no second post, no second probe.
- **The `duplicate` value** in `social_leads.state` stays in migration `0023`'s CHECK (already merged; removing it would need a migration for no gain) and is reserved: nothing writes it.
- **Test 10 now reads:** "A repeat of an origin-only lead returns `202` with the existing `leadId` and `postId`, and writes no second lead row, post or probe."
- **Why not a persisted duplicate state:** it would add rows recording nothing the existing row does not already say, and it contradicts the uniqueness rule the migration enforces.

## 4. Files this PR amends

- `docs/specs/06-review/change-requests/SCR-164-agent-social-network.md`: the four passages above, each marked "(amended by SCR-165 §n)", so SCR-164 stays the single readable source.
- `docs/specs/02-data-and-protocol/schemas/plan.schema.json`: `steps[].why.lessons[].serviceId`, required.
- `packages/schemas/src/generated/plan.d.ts`: regenerated in the same PR, so `build-v1` stays green.
- `docs/specs/02-data-and-protocol/data-and-protocol.md`: change-log row.

## 5. How the orchestrator applies it

- **Apply all three in one batch on the existing integration branch** (`codex/social-network-integration`), against this file's text. Do not wait for this PR to merge to start.
- **Do not edit `plan.schema.json` or the generated types yourselves.** Rebase onto `build-v1` once this merges and take them from there; that keeps the schema's single source canonical.
- Rerun the affected gates, obtain the fresh independent review the brief already requires, and open **one** SN-2–SN-6 PR against `build-v1`.

## Affected tasks

- SN-4 (lessons and incident producer, Plan 1.4 emitter), SN-5 (approve-screen lines), SN-6 (acceptance tests 9 and 10).

## Decision

- Accepted by Zaryab's merge of the PR that adds this file.
