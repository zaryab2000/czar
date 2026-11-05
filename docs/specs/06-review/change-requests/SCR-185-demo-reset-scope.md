# SCR-185: Bound the Demo v1 reset and preserve the social cursor

| Field | Value |
|---|---|
| ID | SCR-185 |
| Filed by | GPT Lane C, 2026-11-05 |
| Spec and section | `docs/specs/06-review/change-requests/SCR-183-demo-seeding-timing-reset.md` §6 |
| Status | Open |

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

Replace §6's deletion rule with a bounded reset:

1. Identify the three seed owners by their controlled flag and reserved demo handles. Delete their fixture objectives, ratings, observations, representatives and dependent social rows. Delete A/B `smart-contract-audit` social state and selection projections created for the rehearsal, including Bob's demo rating, only after specifying how to distinguish that rating from any unrelated real A/B payment history. Preserve other services' social rows.
2. Keep the global `social_consumer_cursor`, retained outbox events and `event_deliveries`. Quiesce the social worker during reset. Define which retained Bob/Alice audit events may be replayed for a new rehearsal, or explicitly say they must not replay. Do not rewind the global cursor.
3. Clarify whether a settled, non-controlled A/B observation may be deleted. Recommended: preserve the chain-derived observation and payment evidence; remove only the demo's rating and social projection, and specify how the starting ranking excludes that retained observation without changing production ranking semantics. If that cannot be done with current schema, permit reset only on a dedicated disposable demo database and state that boundary explicitly.

## Affected tasks

- SOC-06, DEMO-03; SOC-02 and SEL-01 repeatability checks.

## Decision

- Pending Zaryab and architect ruling.
