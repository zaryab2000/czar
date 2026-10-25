# TA-04 task report

## Result

- Added a six-key HTTPS/local-only config guard. Loopback values require the exact local overlay,
  loopback Arc RPC, and an `anvil_nodeInfo` response.
- Added the D92 Facilitator and Gateway stand-in process, bound only to `127.0.0.1`, using the
  local unlocked RPC account for `transferWithAuthorization`.
- Wired the indexer Gateway poller to `chain.gatewayApiBaseUrl`, added the D92 local overlay, and
  composed the stand-in with the local server and merchant processes.
- Added the `fetch.localStandinOrigins` safeFetch exception, restricted to configured loopback
  origins.

## Checks

Commands use the repository-pinned Node runtime, 22.22.0.

| Command | Result |
|---|---|
| `fnm exec --using=22.22.0 pnpm --filter @czar/config test` | Passed: 40 tests in 5 files. |
| `fnm exec --using=22.22.0 pnpm --filter @czar/x402 test` | Passed: 86 tests in 4 files. |
| `fnm exec --using=22.22.0 pnpm --filter @czar/indexer test` | Passed: 54 tests in 10 files, including T-021 replay on arc-anvil. |
| `fnm exec --using=22.22.0 pnpm typecheck` | Passed: all 14 typechecked workspace projects. |
| `fnm exec --using=22.22.0 pnpm lint` | Passed: oxlint and oxfmt. |
| `fnm exec --using=22.22.0 pnpm --filter @czar/server test` | 256 passed, 1 failed. `app-reads.test.ts` expects 200 but receives 503 because its RPC at `127.0.0.1:8549` is not running. The other 44 test files passed. |
| `CZAR_LOCAL_CONFIG=env/local.toml CZAR_STANDIN_BIND_ADDRESS=0.0.0.0 fnm exec --using=22.22.0 node --disable-warning=ExperimentalWarning --experimental-strip-types ops/local/circle-standins/server.ts` | Refused startup with exit 1: `stand-in bind address must be 127.0.0.1`. |

The first server test attempt had no PostgreSQL at `127.0.0.1:15432`; the server suite was rerun
with its ephemeral test Postgres. The remaining failure is the test's unavailable RPC dependency.
Pinned `arc-anvil` answered `anvil_nodeInfo` locally. The contract submodules were initialized at
their pinned revisions in this worktree to run the indexer replay test.

## SCR needed

SCR-130 requests a recorded A2 `/v1/transfer` response, but the checked-in A2 material has no
attestation and signature payload for that endpoint. The stand-in currently returns deterministic
local placeholder bytes with the expected response shape. They are not a usable Circle attestation
and must not be treated as evidence of a successful mint. The architect should decide whether to
record a fixture or define a local attestation mock before T-050a exercises this route.

## Deferred

- Per D94, the running-Arc Facilitator/Gateway stand-in round trip is deferred to T-050a.
- No hosted Circle endpoint, testnet, real funds, or private key was used.
