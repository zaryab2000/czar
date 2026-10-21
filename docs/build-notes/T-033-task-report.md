# T-033 task report: alerts and halt flags

## Status

Complete locally. The draft PR is #38 into `build-v1`. All T-033 alert, query,
and replay acceptance checks pass. No GitHub CI or testnet was used.

## Changes

- Added `dependency_state`, `halt_flags`, and minute-bucket reserve-rate tables
  to `apps/indexer/ponder.schema.ts`.
- Registered proxy `Upgraded` events and ERC-8183 `RoleGranted`,
  `HookWhitelistUpdated`, `PlatformFeeUpdated`, and `EvaluatorFeeUpdated` in
  `apps/indexer/src/external-abis.ts`, `ponder.config.ts`, and the replay config.
- Added event-derived dependency projections and path halts in
  `apps/indexer/src/register-external-events.ts`. Path mapping follows the
  requested USDC, Gateway, and ERC-8183 mapping.
- Added lag and per-vault/global reserve-rate alert checks in
  `apps/indexer/src/handlers.ts`, using the existing config thresholds and
  `@czar/logging` allowlist through an injectable reporter.
- Added `dependencyState()` SQL selection and `GET /dependency-state` in
  `apps/indexer/src/api/store.ts` and `src/api/router.ts`.
- Added rule, log-sink, PGlite store/route, and arc-anvil replay coverage;
  extended `MockExternalEventEmitter.sol` to emit `Upgraded`.

## Verification

| Command | Result |
|---|---|
| `PATH="$HOME/.local/bin:$PATH" arc-forge --version` | `1.7.1-dev`, Arc Foundry v0.8.0-2, commit `d497beea7096ff2a8e583c8b307941f24a61b06b` |
| `FOUNDRY_PROFILE=arc PATH="$HOME/.local/bin:$PATH" arc-forge build --offline` (from `contracts/`) | Pass: 117 files compiled with Solc 0.8.30 |
| `PATH="$HOME/.local/bin:$PATH" fnm exec --using 22 pnpm --filter @czar/indexer exec vitest run test/replay-anvil.test.ts` | Pass: 1 replay test; local arc-anvil checked both dependency upgrades via HTTP and captured the alert line |
| `PATH="$HOME/.local/bin:$PATH" fnm exec --using 22 pnpm --filter @czar/indexer test` | Pass: 10 files, 46 tests |
| `fnm exec --using 22 pnpm --filter @czar/config test` | Pass: 2 files, 24 tests |
| `fnm exec --using 22 pnpm lint` | Pass |
| `fnm exec --using 22 pnpm -r typecheck` | Pass: all 14 workspace projects |

The replay initially exposed strict config parsing of `CZAR_TEST_*` variables
in the new handler. The handler now passes only registered config variables to
`loadConfig`; the replay and full suite pass. Replay-generated
`contracts/broadcast/` files were removed after the run.

## SCRs

- None filed. `indexer.reserveRateAlertPerMin` already has `perVault: 60` and
  `global: 600`, matching the specification.

## Open issues

- ERC-8004 has no pinned address in code and no Phase 1 payment path; no address
  or halt mapping was invented.
- The specification does not define an operator action for clearing halt flags.
  No clear route or write path was added; flags remain event-derived and are
  recomputed by re-indexing.
