# SCR-186: Bound the Demo v1 reset and preserve the social cursor

| Field | Value |
|---|---|
| ID | SCR-186 |
| Filed by | GPT Lane C, 2026-11-05 |
| Spec and section | `docs/specs/06-review/change-requests/SCR-183-demo-seeding-timing-reset.md` §§5–6 |
| Status | Accepted (architect ruling, 2026-11-05); implementation pending |

## Problem

- §6 says to delete **every social row** while also keeping **everything for other services**. Social threads, posts, inbox and runs can contain events for other services, so both rules cannot hold together.
- `social_consumer_cursor` has one row for the entire social consumer, with no seed timestamp or per-service partition. Deleting it resets delivery to the beginning of the retained outbox. Keeping `event_deliveries` would skip old events; deleting those deliveries would replay Bob's and other owners' retained events into the fresh social state.
- §6 deletes A/B observations and rating receipts while preserving all receipts and chain-derived payment records. It does not distinguish a demo observation from a real settled observation of Bob's testnet payment. The reset needs a precise deletion boundary.

## Evidence

- `apps/server/migrations/0023-social.sql:13-17`: one global social cursor, no `created_at` or service key.
- `apps/server/src/social/consumer.ts:87-131`: the consumer resumes from the cursor over retained `outbox_events`, and `event_deliveries` suppresses events already processed.
- `apps/server/migrations/0020-flow-4a-observations.sql:3-29`: observations carry payment ID, payment hash and settlement transaction, including real chain-derived data.
- SCR-183 §6 states both the delete and keep requirements above; §Tests 5 requires other services and receipts to remain untouched.

## Proposed change

Replace §6's deletion rule with the binding decision below. No new table or field is needed.

## Affected tasks

- SOC-06, DEMO-03; SOC-02 and SEL-01 repeatability checks.

## Decision

- Architect ruling, 2026-11-05, accepted as binding for SOC-06/DEMO-03:
  1. Delete only demo rehearsal state. Remove the controlled seed owners and their users,
     devices, representatives, social budgets, objectives, synthetic observations, ratings,
     rating receipts, effective ratings, subscriptions, inbox and runs. Remove social threads for
     `service:eip155:5042002:<A>`, `service:eip155:5042002:<B>`, and
     `class:eip155:5042002:smart-contract-audit`; audit incident threads for A or B; and question
     threads whose card task class is `smart-contract-audit`. Remove those threads' posts,
     evidence links, and related inbox and runs. Remove A/B `smart-contract-audit` incidents
     and lessons. Keep all other services, task classes and social rows, including Bob's and
     Alice's representatives and sharing settings.
  2. Keep the global social consumer cursor, all outbox events and all event deliveries.
     Never rewind or delete them. Before deleting controlled objectives, set only
     `outbox_events.objective_id` to `NULL` for events whose objective belongs to a
     controlled owner. Change no other outbox column. New seed events are consumed normally.
  3. Never delete a non-controlled user's observation, payment ID, settlement transaction,
     receipt, envelope or other chain-derived record. Delete only non-controlled A/B
     `smart-contract-audit` ratings created at or after the rehearsal boundary, with their
     `rating_receipts` bindings, effective rating projection and rating-created health facts.
     The boundary is the earliest `users.created_at` of the controlled seed owners, read
     before deleting them. If no controlled owners exist, delete no real user's rating and
     report that fact. Preserve pre-boundary ratings. An unrated delivered observation is
     neither a negative unit nor a rating count.
  4. Keep ranking decisions because plans and the version-drift guard reference them.
     Recompute supplier counts from evidence and trigger a ranking-snapshot refresh after
     reset and after seed. Never edit supplier counts by hand.
  5. Test two reset/seed/check cycles with identical results; preservation of Bob's
     observation, payment ID and settlement; pre-boundary A/B ratings; another service's
     thread/posts; and cursor, outbox events and deliveries. Test guard refusal.
  6. Amend SCR-183 §5: the demo overlay sets `social.repDailyPostCap = 50`; the
     production default remains 10. Each controlled agent makes 8–9 posts on seed day,
     and the higher demo cap allows corroboration replies and another same-day rehearsal.

## Foreign-key ruling

- `outbox_events.objective_id` has a foreign key to `objectives.objective_id`
  (`apps/server/migrations/0001-cz12.sql:132`). Controlled seed replay writes outbox events
  with their synthetic objective IDs. Deleting those objectives while keeping the event rows
  byte-for-byte unchanged is impossible under this schema.
- The architect approved setting only `outbox_events.objective_id` to `NULL` on events
  referencing controlled owners' objectives before deleting those objectives. Preserve
  every other outbox field, the consumer cursor and all event deliveries.
