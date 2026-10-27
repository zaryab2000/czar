# SCR-114: Define sources for non-event indexer mirror fields

| Field | Value |
|---|---|
| ID | SCR-114 |
| Filed by | Codex, 2026-10-21 |
| Spec and section | `docs/specs/05-build-plan/phase-1-tasks.md` T-031; `docs/specs/02-data-and-protocol/data-and-protocol.md` §4.8–§4.11 |
| Status | Accepted (2026-10-21; implementation decisions recorded below) |

## Problem

- T-031 requires all four complete, schema-valid mirrors from vault and factory events, but `PocketRecord.keyRef` is required by the schema and is absent from those events and on-chain views. It is a server-side KMS identifier.
- `JobRecord.expiredAt` is required but is absent from `JobOpened`; it is available from `getJob`. The task does not say whether handlers may enrich event projections with historical contract view calls.
- `Envelope.Closing` can depend on a server `finalize` intent, and `PocketRecord.DelegateReady` depends on GatewayWallet `DelegateAdded`, whose handler belongs to T-032. The required source and timing of these inputs for T-031 replay are unclear.
- T-021 uses Foundry cheatcodes and randomized handler calls; it does not publish one fixed sequence that can be broadcast to `arc-anvil` and replayed by Ponder.

## Evidence

- `pocket-record.schema.json` requires `keyRef`; §4.10 calls it a KMS key id.
- `job-record.schema.json` requires `expiredAt`; `ICzarVault.JobOpened` omits it, while `ICzarVault.getJob` returns it.
- `czar-vault.md` §8.2 and §8.3 define the derived states; T-032 separately owns external event handlers.
- `contracts/test/invariant/InvariantVault.t.sol` defines the fuzzed `VaultHandler`; T-031 does not identify a seed, action list, or export format for its required replay.

## Proposed change

- Specify that the indexer receives `keyRef` from the server key registry through a durable, replayable binding keyed by `(vault, pocket)`, including how a replay behaves if the binding has not arrived.
- Specify whether T-031 may use `getJob(jobKey)` at the event block to populate `expiredAt`, and whether replay requires an archival RPC or a separate server-side job-open record.
- Specify the replayable source of `finalize` intent and whether T-031 must process GatewayWallet `DelegateAdded` directly or treat `DelegateReady` as an integration completed in T-032. Clarify whether T-031 acceptance tests should include that external event.
- Specify a deterministic T-021 action trace (seed and action arguments, including setup), or accept a documented deterministic subset of the handler's action types broadcast against local `arc-anvil` as the T-031 replay fixture.

## Affected tasks

- T-031, T-032, T-034

## Decision

Zaryab's decisions on 2026-10-21:

1. `PocketRecord.keyRef` is server-only. The indexer omits it; T-034 joins it from the
   signer's key registry at read time. Keep the canonical JSON schema unchanged. The indexer's
   projection and replay validate the event-sourced subset, with `keyRef` optional in the local
   projection schema. The indexer must not have a `keyRef` column.
2. T-031 may populate `JobRecord.expiredAt` by reading `getJob(jobKey)` at the event block.
   Keep historical view enrichment.
3. Keep the `DelegateReady` transform, but T-031 acceptance does not assert that state. T-032
   owns GatewayWallet `DelegateAdded` indexing and acceptance.
4. Expiry is event-driven: an idle envelope remains in its previous state until a later event
   observes expiry. The server's finalize call emits the event that advances the projection.
5. A documented deterministic subset of T-021 handler action types broadcast to local
   `arc-anvil` is an accepted T-031 replay fixture.
6. T-031 validates against checked-in S02 schemas directly; T-006 integration remains separate.
7. The local factory address is valid for T-031 replay; T-034 owns integration with the
   T-027 deployment manifest.

Applied to T-031 implementation and report. No canonical schema change is required.
