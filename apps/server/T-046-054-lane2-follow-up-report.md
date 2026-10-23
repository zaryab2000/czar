# Lane 2 remaining implementation follow-up

## Scope and baseline

- Tasks reviewed: T-046, T-048, T-049, T-050, T-052, T-053 and T-054.
- P1 prerequisite: PR #60 is merged into `build-v1`; the existing
  `codex/lane2-job-followup` worktree was inspected and preserved.
- This follow-up is based on the latest `origin/build-v1` at start. No canonical
  specs, product decisions, architecture docs, contracts, signer implementation,
  Lane 3 implementation, Lane 4 implementation, or Lane 5 route/UI files were
  changed.
- Development and code inspection are reported separately from deferred
  acceptance and release validation.

## Implemented in this follow-up

### Reservation sizing

The vault is authoritative for existing step and envelope exposure. Before a
new reservation, the payer reads `stepUsed(envelopeId, stepIndex)` and
`getEnvelope(envelopeId)`. It computes:

- remaining step cap = `max(stepCap - stepUsed, 0)`;
- envelope exposure = `spent + reserved + pocketOutstanding + jobEscrowed + shortfall`;
- remaining envelope cap = `max(cap - exposure, 0)`;
- reservation count = the minimum affordable call count across both remaining
  caps, prepared calls, expected calls, and the 128-authorization contract cap.

The vault still enforces both limits atomically when the signed reservation is
submitted. Its `reserved` field includes active reservations; `spent` retains
settled consumption; the contract releases unused step usage only through its
existing finalization paths. A zero remaining allowance returns the stable
`step-cap-exhausted` result without signing or submitting a reservation. Existing
`reserve.sent` recovery continues to reuse its persisted arguments and
transaction.

Files: `apps/server/src/payer/vault-direct.ts`,
`apps/server/src/payer/viem-chain.ts`, and payer test adapters in
`apps/server/test/`.

## Item-by-item development status

| Item | Status | Evidence / remaining work |
|---|---|---|
| Reconciliation | Complete | T-046/048/049 and T-052/053/054 implementations and their historical reports were read. P1 fixes are integrated by PR #60. This report does not repeat prior acceptance claims as current test runs. |
| Reservation sizing | Implemented | New on-chain step/envelope reads are used by the actual `executeVaultDirectStep` path; focused regression tests cover prior step use and envelope exposure. |
| Default automatic halt draining | Partial; blocked | Database event source discovers linked vaults and reconciles frozen/paused state, but `main.ts` only starts it when `pocketHalt` is injected. There is no safe production producer for a complete pullback input: authoritative Gateway available balance, outstanding/pending values, and durable context are not all available to reconstruct a pullback. Do not enable a watcher that invents these values. G0-05/Gateway integration remains a dependency. |
| Manual return | Partial; public contract handoff required | The slow-return path persists `manual-return-required`, amount, transaction evidence, pocket, vault and failure state internally. Owner-only `recordManualReturn` is not called by K3/K4. No existing generic owner-action HTTP/UI path was found. Lane 5 needs an approved owner action presentation/submission contract exposing the vault, pocket, amount and return evidence, and must submit owner action code 10. Reconcile completion from the canonical `ManualReturnRecorded` projection/event. No route or payload was invented. |
| Deliverable cleanup | Partial; Lane 3 producer required | `purgeUnmatchedJobDeliverables` already preserves the matched content hash and shared references, and uses decision time + configured retention. No production scheduler can call it safely: no durable evaluator decision producer currently supplies the authoritative matched content hash and decision timestamp. Lane 3/T-055 must expose that decision; Lane 2 can then schedule the existing cleanup idempotently. No duplicate decision store was added. |
| T-050 thin slice | Partial; startup integration blocked | The canonical `createSearchRoute` factory exists, but `apps/merchants/src/local-main.ts` still serves only health and 404. It has no approved source for the `czar-search` K10 payout address. `SignerClient` exposes signing and pocket-key creation, not merchant key address lookup, and no accepted config/manifest key provides that address. The server's `createServerMain` composes boundary, payer, settlement and receipts as injectable functions, but `local-main.ts` does not use it and no worker/route connects approved steps to those functions. Completing this requires the approved K10 public-address source plus Lane 5/server startup ownership to wire objective planning/execution; no key, config key, hosted call, or substitute production mock was introduced. |
| Remaining Bundle B implementation | Partial | Existing payer modules, chain adapters, routes, stores and fixture tests are present. Production halt draining, manual-return UI/API, evaluator-driven cleanup scheduling, and closed-pocket late Gateway balance recovery remain unconnected for the dependencies above. The previous T-052–T-054 report lists the detailed state-machine gaps and historical fixture coverage. |

## Cross-lane handoffs

1. **Lane 1 / signer:** provide an approved, public runtime lookup for the
   `K10:czar-search` payout address (or an already-approved deployment/config
   source) without exposing key material. Existing `SignerClient` does not
   expose this address.
2. **Lane 3 / evaluator:** provide a durable authoritative job decision record
   with `jobKey`, terminal decision, `decisionAt`, and the on-chain-matched
   `contentHash`; Lane 2 will connect `purgeUnmatchedJobDeliverables` to its
   production lifecycle.
3. **Lane 5 / app and server startup:** define and implement the owner-authenticated
   presentation/submission flow for owner action code 10, and connect the actual
   local server entry point to the approved planner → payer → boundary → receipt
   path. Required manual-return state includes vault, pocket, amount, and return
   transaction/evidence references.
4. **Gateway integration / G0-05:** provide the approved Gateway data and API
   behavior needed to reconstruct/pull back every funded pocket with authoritative
   balances and pending-transfer state. Until then automatic drain and closed
   pocket late-balance recovery remain disabled/unclaimed.

## Focused validation performed for this follow-up

- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/payer/acceptance.test.ts test/payer/vault-direct.test.ts`
  — passed: 2 files, 5 tests.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server typecheck`
  — passed.
- `fnm exec --using=22.22.0 pnpm -r typecheck`
  — passed: 14 of 15 workspace projects (all projects with typecheck scripts).
- `fnm exec --using=22.22.0 pnpm lint`
  — passed: oxlint with warnings denied; oxfmt clean.
- `git diff --check` — passed.
- Baseline regression evidence: the first reservation test failed before the
  fix because `stepUsed` was never consulted. The focused tests now prove a
  prior 2,000 atomic step use limits a 5-call request to 3 calls, and 2,000
  atomic envelope capacity limits it to 2 calls.
- Full server test suite, full workspace typecheck, Arc Anvil, crash/restart
  matrices, live Gateway/model calls, testnet and deployment were not run in
  this development phase.

## Deferred validation checklist

| Scenario | Prerequisites | Intended command / evidence | Status |
|---|---|---|---|
| Reservation accounting against deployed vault, including parallel reservations and settled/finalized/released usage | Local Arc Anvil deployment with current vault contracts and DB fixture | `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/evidence/receipt-arc.test.ts` plus a focused local-chain reservation scenario | NOT RUN / DEFERRED |
| T-052 pocket, T-053 pullback, T-054 job acceptance and crash/resume matrices | Arc Anvil contracts, Circle/ Gateway fixtures, composed production adapters | Add/run the required local Arc Anvil payer acceptance tests under `apps/server/test/payer/` | NOT RUN / DEFERRED |
| Halt drain, including already halted vault discovery, future vault discovery, pending pullbacks and late funds | Approved Gateway balances/transfer integration and concrete production `PocketHaltDependencies` | Payer runtime integration test plus local Arc Anvil freeze/pause scenario | BLOCKED on Gateway integration |
| Manual owner return | Approved Lane 5 owner-action UI/API contract and owner authentication flow | Authenticated owner-action test followed by event/projection reconciliation test | BLOCKED on public contract/UI handoff |
| Deliverable cleanup | Lane 3/T-055 authoritative durable decision producer | Scheduler restart/retry tests with matched and unmatched versions and shared object refs | BLOCKED on evaluator producer |
| T-050 merchant and server thin slice | Approved K10 address source, signer integration, configured facilitator, complete server execution lifecycle | Merchant process HTTP 402/verify/settle test and server process end-to-end with recorded/offline fixtures | BLOCKED on K10 address and startup wiring |
| Full server regression suite | Required local Postgres/RPC fixtures available | `fnm exec --using=22.22.0 pnpm --filter @czar/server test` | NOT RUN / DEFERRED |
| Live model, Gateway/testnet and deployment acceptance | G0-16/K18 approval, T-121 and explicit later-phase authorization | Per the later validation plan | NOT RUN / DEFERRED |

## Open specification and ownership gaps

- No specification edits or SCR files were created. Required owner-action
  presentation/submission details are handed to Lane 5 instead of being
  invented.
- No local Arc Anvil, testnet, deployment, funds, account, secret, hosted model,
  or live Gateway activity was used.
- The internal `docs-internal/lane-tracker/` directory was unavailable in this
  worktree; task-by-task status is recorded here for the reviewer.
