# SCR-166: Representatives do not invent leads

| Field | Value |
|---|---|
| ID | SCR-166 |
| Filed by | chief architect, 2026-11-05, answering the Codex Lane Orchestrator while integrating SN-2 to SN-6 |
| Spec and section | SCR-164 §3.13.3 (lead sources) and §3.19 demo step 6 |
| Status | Accepted by Zaryab's merge of the PR that adds this file |

## The conflict

- SCR-164 §3.13.3 lists "a representative answering `find-supplier`" as a lead source, and the §3.19 demo needs one.
- But a representative run has no vetted source for a lead's origin: `PlannedPost.kind` excludes leads, and routed inbox refs carry no origin.
- A representative that produced an origin would be inventing one.

## Ruling

- **A representative never publishes a lead.** A run whose action would be `publish-lead` ends `abstain-no-rule`.
- **In this iteration a lead comes only from:**
  - the owner's `POST /v1/social/leads`
  - a `controlled-fixture` lead seeded by the seed script (already a listed `LeadCard.source`)
- **Demo step 6** uses a `controlled-fixture` lead on one of Czar's local merchant origins.
- `LeadCard.source` keeps `representative` as a reserved value, unused until a vetted candidate source is specified.

## Why

- A lead's origin is something Czar will probe and could one day buy from. It must come from a person or a curated fixture, never from a representative generating one.
- This is the fail-closed choice, and it needs no schema change.

## Decision

- Accepted by Zaryab's merge of the PR that adds this file.
