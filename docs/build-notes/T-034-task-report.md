# T-034 task report: indexer query API

## Status

Partial; blocked on open SCR-119. The implemented routes are tested against seeded projection rows. Three query families return 501 until their response contracts are specified: `receiptsForLedger`, both anchor queries, and `dependencyState`. No spec files were edited.

## Changes

- Added a Hono query API for `envelopeByRef`, `reservationsNeedingSettle`, `reservationsNeedingFinalize`, `pullbacksToConfirm`, `pullbacksToCancel`, `jobsToSync`, and `jobsAwaitingEvaluation`.
- Mirror objects are checked using `@czar/schemas`; settlement matching uses `derivedNonce` from `@czar/hashing`.
- Added opaque, route- and query-bound expiring cursors. Page minimum, default, maximum, cursor lifetime, and pullback cancel delay come from `@czar/config`.
- Added SCR-119 at `docs/build-notes/SCR-119-indexer-query-response-contracts.md` for missing response schemas and settlement projection inputs.

## Validation

| Command | Result |
|---|---|
| `fnm exec --using 22 pnpm --dir apps/indexer exec vitest run test/query-api.test.ts` | Pass: 1 file, 11 tests |
| `fnm exec --using 22 pnpm --dir apps/indexer exec vitest run --exclude test/replay-anvil.test.ts` | Pass: 8 files, 40 tests |
| `fnm exec --using 22 pnpm --filter @czar/indexer typecheck` | Pass |
| `fnm exec --using 22 pnpm --filter @czar/config test` | Pass: 2 files, 24 tests |
| `fnm exec --using 22 pnpm exec oxlint apps/indexer/src/api/index.ts apps/indexer/src/api/router.ts apps/indexer/src/api/types.ts apps/indexer/test/query-api.test.ts packages/config/src/registry.ts` | Pass |
| `fnm exec --using 22 pnpm exec oxfmt --check apps/indexer/src/api/index.ts apps/indexer/src/api/router.ts apps/indexer/src/api/types.ts apps/indexer/test/query-api.test.ts packages/config/src/registry.ts` | Pass |
| `git diff --check` | Pass |
| `fnm exec --using 22 pnpm --filter @czar/indexer test` | Fail: 8 files / 40 tests pass; `test/replay-anvil.test.ts` fails while running `script/deploy.sh` before the query tests. |
| `python3 -I docs/specs/02-data-and-protocol/schemas/check-schemas.py` | Pass: 0 problems (the checker reports 0 schema files in this checkout). |

## Open issues

- SCR-119 must be ruled on before the remaining queries can return data that satisfies the required schema-validation contract.
- The new query tests use an injected seeded projection source; they do not exercise the Ponder/Postgres API process end to end.
- The current production adapter reads whole projection tables before filtering and paging; query-level database filters and limits remain to be added for bounded work on larger indexes.
- The complete indexer suite remains red on the Arc replay deployment test. No deployment script was changed.
- No PR was opened because the acceptance contract is incomplete while SCR-119 is open.
