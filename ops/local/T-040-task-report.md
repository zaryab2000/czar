# T-040 local hosting task report

## Implemented

- Added a Postgres-backed signer `Projection` using the generated vault and factory ABIs for live
  chain reads, indexer tables for event mirrors and Gateway transfer totals, and server tables for
  plans, payment receipts, and acceptance reports.
- Added `apps/signer/src/local-main.ts` and included the signer in the local process manager. It
  checks the local chain and deployment manifest are both chain `5042002`, binds RPC transaction
  preparation and gas refill, and writes signer audit rows through the server Postgres pool.
- Bound the refill target addresses to the signer backend's public addresses after keystore
  unlock. No key material or passphrase is passed through argv or environment variables.
- Added the service-to-caller/key policy: `server` → `cz-15`, `cz-16`, `cz-17`, `cz-24`; `merchants`
  → `cz-20`; `relayer-jobs` → `relayer`.
- Added projection tests for plan/leaf reconstruction, used-call projection, missing plans, and the
  Gateway balance fail-closed path.
- Local Postgres, Arc Anvil deployment, indexer, server, and merchant process configuration remains
  under `ops/local/`; `env/local.toml` contains only parameter overrides.

## SCR-127 — Gateway balance projection required for K4 lifecycle

The local indexer schema does not contain Circle Gateway API balance, Gateway Wallet
`availableBalance` / `withdrawingBalance`, or an authoritative slow-withdrawal state. These inputs
are required by CZ-27 §5.3 to retire K4 safely and to authorize slow withdrawal. The signer projection
therefore refuses `pocketBalances` reads, which also blocks K4 return requests that depend on that
combined view, and reports slow withdrawal as not allowed. It never treats missing Gateway values as
zero. Add an authoritative local/test Gateway projection and define its freshness/outage behavior
before enabling those operations.

The plan approval projection uses the existing server transition: an `offered` plan is
auto-approvable only while its objective is `opening`; `awaiting-approval` and other objective states
are denied. It also refuses a plan hash already present in the indexer envelope mirrors. The
service-to-caller mapping is explicit in the local signer policy as requested by this task.

## Verification

- `fnm exec --using=22.22.0 pnpm -r typecheck` — passed across 14 workspace projects.
- `fnm exec --using=22.22.0 pnpm lint` — passed after formatting the changed TypeScript files.
- `fnm exec --using=22.22.0 pnpm --filter @czar/signer test` — 92 passed, 1 skipped.
- `fnm exec --using=22.22.0 pnpm --filter @czar/config exec vitest run test/toml.test.ts` — 3 passed.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/app.test.ts` — 11 passed.
- `fnm exec --using=22.22.0 pnpm --filter @czar/indexer exec vitest run test/query-api.test.ts` — 12 passed.
- Live local checks — server `/health`, indexer `/health`, indexer `/ready`, and merchant `/health`
  returned HTTP 200. Docker reported local Postgres healthy on `127.0.0.1:15433`.
- `safeFetch` smoke check — configured merchant origin returned HTTP 200; the Postgres URL was
  refused with rule `scheme`.
- `bash ops/local/deploy.sh` — passed; it verified the local deployment was already present on
  Arc Anvil chain `5042002` and skipped redeployment.
- `git diff --check`, `shellcheck ops/local/deploy.sh`, and `shfmt -d ops/local/deploy.sh` — passed.
- Ruby Psych parsed both `ops/local/process-compose.yaml` and `ops/local/compose.yaml` — passed.
- Signer startup was attempted with `pnpm --filter @czar/signer start:local`; it stopped at
  `keychain-missing` for `dev.czar.signer.keystore`. No keychain item or keystore file was read,
  printed, or created.
- `process-compose` is not installed in this environment, so the process manager itself could not
  be executed. Its processes were configured, and the already-running local services were checked
  directly.
- The process argv/environment value scan was not run because it would inspect secret-bearing
  process state. No key material or secret values were read or printed; no tracked keystore, `.env`,
  or `*.key` path was added.

## Open items

- SCR-127: supply authoritative Gateway balances and slow-withdrawal state before K4 return,
  slow-withdrawal, or retirement operations can be enabled.
- Add the local `dev.czar.signer.keystore` keychain item through the established T-105 workflow to
  run the signer process on this Mac. This report does not create or alter credentials.
- Install/use `process-compose` to launch the complete stack through the process manager.
