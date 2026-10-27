# T-045 task report

## Delivered

- Added the planner fallback policy, safe local HTTP 402 probe, injected ports,
  plan hashing, payee and pocket leaves, routing, call input rendering, caps,
  approval decision, and schema validation.
- Added objective planning, shadow quotes, typed replanning, persistence,
  `plan.ready` outbox events, and a concurrent-safe received-event worker.
- Updated `@czar/hashing` so `planHash` commits the nested TaskSpec hash and
  per-step call input hashes; exported `callInputsHash`.
- Added an internal job provider address field and filed SCR-121 for its
  canonical source.

## Files

- `apps/server/src/planner/index.ts`
- `apps/server/src/planner/ports.ts`
- `apps/server/src/planner/probe.ts`
- `apps/server/src/planner/service.ts`
- `apps/server/test/planner/planner.test.ts`
- `apps/server/test/planner/service.test.ts`
- `apps/server/package.json`
- `packages/hashing/src/named.ts`
- `packages/hashing/test/named.test.ts`
- `pnpm-lock.yaml`
- `docs/specs/06-review/change-requests/SCR-121-planner-job-provider-address.md`

## Local verification

All commands ran from the T-045 worktree using Node 22. Postgres was started
locally with `docker compose -f apps/server/test/compose.yaml up -d`.

| Command | Result |
|---|---|
| `fnm exec --using=22 pnpm --filter @czar/hashing test` | PASS: 5 files, 40 tests |
| `fnm exec --using=22 pnpm --filter @czar/server test` | PASS: 14 files, 94 tests |
| `fnm exec --using=22 pnpm --filter @czar/config test` | PASS: 2 files, 24 tests |
| `fnm exec --using=22 pnpm lint` | PASS: oxlint and oxfmt, 268 files |
| `fnm exec --using=22 pnpm -r typecheck` | PASS: all 14 workspace projects |

The planner tests include the 10,000-input seeded D37 invariant, 100 seeded
Merkle/proof plans, the five-subject fan-out, local safe-fetch probe,
network-gate and price-drift cases, gateway pocket leaf, job planning with
task-only context notice, exploration approval, and seller-text exclusion.
Postgres tests cover plan persistence/hash recomputation, shadow mode,
no-supplier and opening transitions, superseding on replan, and two concurrent
workers processing two received events exactly once.

## SCRs and open items

- SCR-121 is filed as proposed. CZ-13 requires a trusted ERC-8183 provider
  address, but the §12.2 index item and CapabilityCard do not define its source.
  The planner requires an injected `providerAddress`; it never infers this from
  x402 `payTo`.
- Runtime `RankingSource` and `ServiceDirectory`: T-090/T-115.
- Runtime `ProfileSource`: T-047.
- Runtime `PocketKeys`: T-037.
- Runtime `AgentHosts` from the latest IngestReport: T-040.
- Runtime earned-autonomy `Allowance`: T-081/T-094.
- Gas price and Gateway-eligible volume are caller-supplied in T-045; the
  payment loop integration consumes them in T-048.
- The received-event worker leaves the objective in `planning` if the planner
  process fails after claiming the event. Recovery/lease semantics are not
  specified by this task; an operator or a later recovery task must resolve
  that state before retry. The successful concurrent-worker path is covered.
- Job-provider call inputs preserve subject fan-out but are empty objects until
  a provider-specific input mapping is defined; the task-only context notice is
  present and seller text is not added to ranking inputs.

No testnet, live merchant, model, or GitHub CI calls were made.
