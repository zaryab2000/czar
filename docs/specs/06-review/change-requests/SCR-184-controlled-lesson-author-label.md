# SCR-184: Identify controlled authors in approval lessons

| Field | Value |
|---|---|
| ID | SCR-184 |
| Filed by | GPT Lane C, 2026-11-05 |
| Spec and section | SCR-183 §2 and §Tests 6; `docs/specs/02-data-and-protocol/schemas/plan.schema.json` `steps[].why.lessons[]` |
| Status | Open |

## Problem
- SCR-183 requires the approval screen to label a lesson's controlled author "Czar test agent", but the plan lesson object does not identify whether its author is controlled.
- The handle is an ordinary `Rep-XXXX` value. Guessing from it could label an ordinary representative as a Czar test agent.

## Evidence
- SCR-183 lines 53–60 requires the badge on approval lessons and permits existing valid handles.
- `plan.schema.json` lines 631–680 allows only `lessonId`, `handle`, `proposition`, `serviceId` and `taskClass` in each lesson; `additionalProperties` is false.
- `apps/web/app/approve/[planId]/page.tsx` lines 304–310 renders the lesson's `handle` but has no controlled-author fact.
- `apps/server/src/social/lessons.ts` already joins `social_representatives` when reading lessons, so the authoritative flag is available without inferring it from a handle.

## Proposed change
- Add a **required boolean `controlled`** to `steps[].why.lessons[]` in `plan.schema.json`, described as the author representative's `social_representatives.controlled` value, with `x-privacyClass: server-only`. Keep plan version 1.4 and the existing rule that `why` is outside `planHash`.
- Propagate that boolean from the author representative through the lesson producer and generated plan types. The approval screen renders the "Czar test agent" badge next to the lesson handle only when `controlled` is true.
- Amend SCR-183 §2 to state that the approval lesson badge uses this field. Add acceptance tests for both controlled and ordinary lesson authors.

## Affected tasks
- UX-07; SCR-183 acceptance test 6.

## Decision
- <filled in by Zaryab: accepted or rejected, and why>
