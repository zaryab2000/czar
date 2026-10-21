# T-061 task report — device pairing and token storage

**Branch:** `codex/t061-device-pairing`

**Base:** `origin/build-v1` at `c628a33` (T-041, PR #29)

**Worktree:** `/private/tmp/czar-t061-device-pairing`

## Result

Implemented daemon `pairDevice` and `czar pair <8-digit-code>`. The daemon sends one request to the T-041 `pairDevice` route with a fresh UUID idempotency key, validates the recorded exchange, and stores the returned K15 token through the existing OS keychain adapter. The command prompts for a device label and prints only the device ID. Tokens are not added to argv, request bodies, or logs.

A same-key `replay-not-stored` response tells the user to request a new code; the client does not retry automatically. Integration tests run the server app in-process against the T-041 test PostgreSQL, seed codes through exported `issuePairingCode`, and verify one-time use and expiry after five minutes. No public code-issuing route was added.

Tests were written before the implementation. The initial daemon test run failed because `@czar/daemon/pairing` did not exist; after implementation, acceptance tests pass.

## Files changed

- `apps/daemon/package.json` — pairing export, API-contract runtime dependency, test-only server/Postgres dependencies and source import mapping.
- `apps/daemon/src/cli.ts` — interactive pair command and existing OS keychain wiring.
- `apps/daemon/src/index.ts` — pairing API exports.
- `apps/daemon/src/pairing/pair-device.ts` — request validation, response validation, one-shot request, replay handling and K15 storage.
- `apps/daemon/test/pairing.test.ts` — in-process server/Postgres acceptance tests.
- `pnpm-lock.yaml`
- `apps/daemon/T-061-task-report.md`

No `docs/specs/` or workflow files were changed. No SCR was filed; no spec gap was encountered.

## Local verification

Runtime: Node `22.22.0`, pnpm `10.28.0`; Docker Compose ran through the local OrbStack daemon.

| Command | Result |
|---|---|
| `fnm exec --using=22.22.0 pnpm install --frozen-lockfile` | PASS |
| `docker compose -f apps/server/test/compose.yaml up -d --wait` | PASS, PostgreSQL healthy |
| `fnm exec --using=22.22.0 pnpm --filter @czar/daemon test` | PASS, 7 files passed / 1 skipped; 37 tests passed / 1 skipped |
| `fnm exec --using=22.22.0 pnpm --filter @czar/daemon typecheck` | PASS |
| `fnm exec --using=22.22.0 pnpm typecheck` | PASS, all 14 included workspace projects |
| `fnm exec --using=22.22.0 pnpm lint` | PASS, oxlint and oxfmt, zero warnings |
| `git diff --check` | PASS |
| `docker compose -f apps/server/test/compose.yaml down` | PASS |

PostgreSQL test image: `postgres:16.15@sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d`.

The token storage test uses the daemon's `Keychain` interface with an in-memory test implementation and confirms the returned token is stored under K15 and absent from process argv, the request body and server logs. The CLI wires this interface to the existing `osKeychain` adapter. Automated tests did not write to the host user's real macOS keychain.

## Dependency audit

`fnm exec --using=22.22.0 pnpm audit --audit-level=moderate` exits 1: **10 findings (5 moderate, 5 high)**. The findings are on existing paths: `@hono/node-server` (3), `drizzle-orm` (1), `@graphql-tools/utils` (2), and `vite` (3) through `apps__indexer > ponder`; `ajv` (1) through `packages__x402`. None come from dependencies added by T-061. The nine advisory IDs are `GHSA-wc8c-qw6v-h7f6`, `GHSA-gpj5-g38j-94v9`, `GHSA-7mx3-vvmw-hjmv`, `GHSA-587h-7wmj-h5pm`, `GHSA-2g4f-4pwh-qvx6`, `GHSA-92pp-h63x-v22m`, `GHSA-frvp-7c67-39w9`, `GHSA-698v-4r3x-3vcv`, and `GHSA-r825-w8mm-5pxw`.

## Acceptance record

- [x] An 8-digit code pairs once; reuse fails.
- [x] A code older than five minutes fails.
- [x] Returned token is stored at K15 through the keychain interface, and is absent from argv, request body and logs.
- [x] Same-key replay returns the user-facing new-code instruction without automatic retries.
- [x] No public pairing-code issuance route was added.
- [x] No SCRs filed; no open implementation issues.
