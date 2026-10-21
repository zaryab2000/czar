# T-036 and T-037 task report

## Result

Implemented signer policies and signer-scoped rate limits, per-service K10 keys, a bounded
five-minute gas-refill worker, PostgreSQL audit-table adapter, and the K4 pocket-key retirement
guard. The local Arc replay deploys with `contracts/script/deploy.sh`, sends the K8 OEL commit,
and runs gas-refill success and relayer-failure cases.

## Files changed

- `.gitignore`: ignore the generated `deployments/arc-local.json`.
- `apps/signer/src/`: merchant-scoped key lookup, K4 retirement denial, gas-refill worker, and
  PostgreSQL audit adapter.
- `apps/signer/scripts/create-merchant-keys.ts`: create service-scoped K10 keys in the guarded
  local keystore; prints addresses only. The script was not run against the user's T-105 keystore.
- `apps/signer/test/`: refill bounds, K10 isolation, audit adapter, K4 retirement, and local
  arc-anvil deployment/replay tests.
- `apps/signer/package.json`: `test:local` command.
- `packages/config/`: appended `signer.maxSignaturesPerMin.*` keys with the CZ-27 defaults and
  reasons; retained the existing `kms.*` entries because registry keys are append-only.

## Commands and results

- `pnpm install --frozen-lockfile` — passed; installed the frozen workspace lockfile.
- `git submodule update --init --recursive` — passed; initialized the pinned Arc Foundry contract
  dependencies in this worktree.
- `pnpm --filter @czar/signer typecheck` — passed.
- `pnpm --filter @czar/signer test` — passed: 9 files, 81 tests; the opt-in local-chain test is
  skipped by this command.
- `pnpm --filter @czar/config test` — passed: 2 files, 24 tests.
- `pnpm --filter @czar/signer test:local` — passed: 1 local arc-anvil test. It verified deployment
  chain ID 31337, a successful `OpenEvidenceLog.commit` from K8, K8 balance reduction, K3/K7/K8
  refills using `anvil_setBalance`, and the empty-relayer alert.
- `pnpm -r typecheck` — passed across all 14 workspace projects selected by pnpm.
- `pnpm lint` — passed: oxlint has no warnings and oxfmt reports all 285 files formatted.
- `pnpm exec oxfmt` on changed signer TypeScript files — passed; formatted before lint.
- `prek run` — unavailable: this repository has neither `prek.toml` nor
  `.pre-commit-config.yaml`; no hook configuration was added for this task.
- `arc-anvil --network arc --quiet --mnemonic-random` — started the pinned local Arc chain on
  `127.0.0.1:8545` for replay. The initial default banner printed built-in test credentials; that
  node was stopped, the output is omitted here, and replay used quiet mode with a random mnemonic.
  No repository keystore or `.env` file was read.
- `pnpm exec oxfmt <changed signer TypeScript files>` — passed; formatting applied before lint.

## SCRs recorded here only

### SCR-L1-01 — Pocket plan association

CZ-27 §4 specifies `createPocketKey(planId)`, while the T-035 signer interface is
`createPocketKey(caller)` and the checked-in server schema does not define where a plan-to-key
association is persisted or how it is recovered after signer restart. T-037's safe behavior is
implemented: the caller creates a K4 at planning time, receives the address, and retirement checks
all pocket balances. I did not invent plan-key persistence. Specify the plan identifier's owner,
storage, and recovery contract before changing this interface.

### SCR-L1-02 — Signer process wiring

`apps/signer` currently exposes a signer library but no process entrypoint or startup composition.
This change provides `postgresAudit` for the existing `audit` table and `startGasRefillJob` at a
five-minute interval, but no owned runtime currently constructs the PostgreSQL pool, signer RPC
dependencies, and job startup together. Define the runtime owner and startup wiring before claiming
  these adapters are active in a deployed signer process. The PostgreSQL adapter is verified with a
  recording SQL executor; the local chain test exercises the refill job independently.

## Open items

- T-121: repeat the local-chain policy and refill acceptance on Arc testnet after its approval gate.
- Run `apps/signer/scripts/create-merchant-keys.ts` with the approved merchant service ids when the
  T-105 local keystore is provisioned. It was not opened or changed during this task.
- Resolve SCR-L1-01 and SCR-L1-02 with the spec authority.

## Commits

- `db49b14` — `Add signer-scoped signature rate limits`
- `08eab95` — `Build signer policies, gas refill, and pocket keys`
