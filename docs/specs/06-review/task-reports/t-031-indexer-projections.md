# T-031 indexer projections — implementation report

**Date:** 2026-10-21
**Base:** `origin/build-v1` at `6572592`
**Worktree:** `czar_v0.t031-indexer-projections`
**Status:** Complete for T-031 acceptance. SCR-114 decisions have been applied.

## Implemented

- Ponder discovers vaults from the generated `CzarVaultFactory.VaultCreated` ABI and decodes vault events with the generated `CzarVault` ABI.
- Every vault and factory event declared in the interfaces has a handler. Vault/factory administration events are recorded in `indexed_events`; entity events update the four mirror tables. `StepUsed` updates `step_usage`.
- Envelope, Reservation, PocketRecord, and JobRecord transforms use contract views at the event block. The transforms include `shortfall`, `Closing` when an event observes expiry or a pullback request, `Released`, pullback `recovery`, and `PullbackConfirmed.creditedToEnvelope`. The `JobSynced` handler applies the event's state value through the specified 1–6 mapping.
- A deterministic local `arc-anvil` replay uses this T-021 handler action subset in order: create vault, open envelope, reserve, register and fund pocket, request and confirm pullback, grant pocket gas, open and cancel job, write off pocket, finalize reservation, and close envelope. The test header records the sequence. Ponder backfills the real vault/factory logs. The test compares event-sourced mirrors with contract views; for the envelope it uses the recorded `lastEventBlock`, preserving the event-driven rule when no later indexed event updates its derived state. It also checks step usage.
- Envelope, Reservation, and JobRecord validate with their checked-in S02 JSON schemas. PocketRecord's event-sourced fields validate against a test-local projection schema derived from the unchanged canonical schema with `keyRef` removed from `required`. The indexer does not store `keyRef`; T-034 joins it from the signer key registry.
- `JobRecord.expiredAt` is enriched using `getJob(jobKey)` at the event block. `DelegateReady` transformation support is retained, while its event source and acceptance assertion remain in T-032.
- Expiry is event-driven: no clock-based transition occurs until a later event observes expiry. T-031 uses checked-in schemas directly; T-006 integration and T-027 production-manifest integration remain with their respective tasks.

## Commands and results

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` under Node 22.22.0 | Passed |
| `CZAR_INDEXER_DEPLOYMENT_PATH=<temporary local manifest> pnpm --filter @czar/indexer exec ponder codegen` | Passed; generated Ponder environment types |
| `pnpm --filter @czar/indexer exec vitest run test/mirrors.test.ts` | Passed: 4 schema and projection tests |
| `pnpm --filter @czar/indexer exec vitest run test/replay-anvil.test.ts` | Passed: deterministic real-contract replay on local `arc-anvil`; mirror/schema assertions passed |
| `pnpm --filter @czar/indexer test` | Passed: 5 files, 15 tests, including T-030 restart/resume and the T-031 replay |
| `pnpm --filter @czar/indexer typecheck` | Passed, including resume and replay fixtures |
| `pnpm exec oxlint --deny-warnings apps/indexer/src apps/indexer/test` | Passed |
| `arc-forge inspect MockGatewayWallet deployedBytecode` | Passed without compiler configuration warning after replacing deprecated `deny_warnings` |
| `pnpm --filter @czar/vault-client exec vitest run test/integration/anvil.test.ts` | Passed: 2 existing real-contract integration tests |

The initial `pnpm install` attempt used Node 25 and failed the repository's Node 22 engine check; rerunning under Node 22.22.0 passed. The first replay fixture used a mixed-case address with an invalid checksum; the corrected fixture passed. A later replay check sampled Ponder before its final blocks were indexed; the fixture now mines extra blocks and waits for final states before comparing views.

## Acceptance scope

SCR-114's seven decisions are reflected in the implementation. T-006 schema-package adoption and
T-027 deployment-manifest integration are separate tasks and do not block T-031 acceptance.
