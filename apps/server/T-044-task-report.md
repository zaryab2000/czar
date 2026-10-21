# T-044 task report

## Result

Implemented the CZ-14 payment router as a pure function. It applies the job,
offer, and cost-routing decisions in order; retains planner-selected `local` and
`agent-assist` steps unchanged; caps reservation calls using the contract limits;
and exposes the requested cost and pocket-cap helpers. Router amounts are
`bigint` Amount6 values. Gas-price costs convert from wei to Amount6 and round
up at the final division. Gateway routing pauses above `routing.maxGasPriceWei`.

The router accepts parsed `@czar/x402` offers and loads routing parameters from
`@czar/config`. `Step` is now re-exported from `@czar/schemas`; its generated
declaration existed but was not part of the package's public exports.

## Changed files

- `apps/server/src/router/index.ts` — route policy, BigInt cost model,
  reservation-call limits, and config-to-parameter mapping.
- `apps/server/test/router.test.ts` — worked defaults, cost and cap boundaries,
  routing branches, offer rejection, Solidity constant checks, measured gas
  table outputs, and the seeded 10,000-case D37 property test.
- `apps/server/package.json`, `pnpm-lock.yaml` — direct workspace dependencies
  on the parsed x402 offer types and the existing vault gas-price floor.
- `packages/schemas/src/index.ts` — public `Step` type export.

## Local verification

Postgres ran locally from `apps/server/test/compose.yaml` using
`postgres:16.15@sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d`.
Commands ran with Node `v22.22.0` and pnpm `10.28.0`.

| Command | Result |
| --- | --- |
| `fnm exec --using=22 pnpm --filter @czar/server exec vitest run test/router.test.ts` before implementation | Expected red: router module missing; 0 tests ran. |
| `fnm exec --using=22 pnpm --filter @czar/server test` | Passed: 12 files, 73 passed, 0 failed. |
| `fnm exec --using=22 pnpm --filter @czar/config test` | Passed: 2 files, 24 passed, 0 failed. |
| `fnm exec --using=22 pnpm lint` | Passed: oxlint with zero warnings; oxfmt clean across 262 files. |
| `fnm exec --using=22 pnpm -r typecheck` | Passed: all 14 workspace projects. |
| `git diff --check` | Passed. |

## Measured gas table

At the 20 Gwei floor with `packages/config/gas-table.json`, the router computes:

- `pocketThreshold(1) = 84,980` Amount6 atomic.
- `pocketThreshold(10) = 9,955` Amount6 atomic.
- `pocketThreshold(100) = 3,056` Amount6 atomic.
- `cPocket = 22,433` Amount6 atomic.

## SCRs and open items

- SCRs filed: none.
- Open items: none identified for T-044.
- No files under `docs/specs/` were changed. No testnet or GitHub CI was used.
