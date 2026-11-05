# Agent social network completion report (draft)

## Status and scope

**SN-6 / SCR-164. This report is a draft. Flow 4A's social network is not yet signed off.**
The final evidence must come from one merged `build-v1` head after SN-1 through SN-6. A test
file, a passing package branch, or a mocked browser route does not establish that final result.

The feature lets an owner's representative publish structured purchase experience, questions,
replies and leads. Public posts supply context; only the paying owner's Good or Bad rating enters
supplier quality. Incidents and bounded personal lessons affect the planner under SCR-164 §3.13.
No post, reply count, handle, or model-written note is itself a supplier score.

| Package | Current evidence | Final state |
|---|---|---|
| SN-1 foundation | PR #195 merged at `4c9195d`; public and owner routes, migration and role. | Recheck on final merged head. |
| SN-2 events and worker | Worker, local seed/replay scripts and controlled fixture merchants are on the integration branch through `9938e49`; key-free tests passed. | Final PR/head review, authorized demo and merge pending. |
| SN-3 questions and replies | Implementation and focused tests are on the integration branch. | Final PR/head review and merge pending. |
| SN-4 buying routes | Incident, lesson and lead changes, plus payer version and unpaid lead rejection regressions, are on the integration branch through `9938e49`. | Final PR/head review and merge pending. |
| SN-5 web | UI, direct template parity and the real-server case-18 browser test are on the integration branch through `f3c6884`. | Final PR/head review and merge pending. |
| SN-6 controlled demo and report | Controlled fixture, local seed/replay support and this draft report are on the integration branch. | Authorized local-chain demo, final report and merge pending. |

The combined integration branch is draft PR #208 into `build-v1`; Zaryab has not merged it.
Record its final reviewed head, merge commit, and review status here before sign-off.
Hosted Actions are unavailable due to billing;
missing, skipped or zero-step hosted jobs are not passing checks.

### Current checkpoint on draft PR #208

The branch is rebased on SCR-165 (`c8f7af1`), with the incident copy, lesson supplier ID,
duplicate-origin lead behavior and independent-review fixes pushed through `b6a0941`.
The 22-file focused server slice passed 175/175 at `da569bb`. Serial full server, signer,
daemon, indexer and vault-client suites passed at that head, with skips recorded below.
The pinned local Arc slice passed 1/1, run 4 passed 13/13 and run 5 passed 15/15.
`FOUNDRY_PROFILE=arc arc-forge test` exited 0 on `b6a0941`; its generated gas snapshot
was restored and its untracked lock file removed. The captured output has not been read
because the suite can handle generated keys, so this records the exit code only.
Run 2 passed 20/20 at both exact SCR-165 base `c8f7af1` (133.22s) and integration
`da569bb` (133.65s). The chief brief had identified four base failures from an earlier
environment; neither run reproduced them here. No regression was observed in this pair.

The controlled local stack has not reached readiness. The installed Process Compose 1.122.0
rejected the old YAML shape; `b6a0941` fixes it and its dry run validates 11 processes.
The full stack then exited with unsuccessful Arc Anvil/Postgres process states. Direct
`arc-anvil --network arc` answered chain ID 5042002 and direct Docker Postgres started,
but the local deploy exited before writing a manifest. Those services were stopped and no
seed/replay or screenshots were claimed. The raw process/deploy logs were not read because
they may contain key material; automatic approval review rejected the proposed log read.
The fixture-origin lead source also awaits an architect ruling under the brief's §6.

## Key-free evidence already collected

| Head and scope | Command or tested scope | Observed result | Limit |
|---|---|---|---|
| SN-5 `7ec5f93` with SN-2 template dependency `6e4953a` | `fnm exec --using=22.22.0 pnpm --filter @czar/web exec vitest run packages/social-templates.test.ts packages/social-api.test.ts` | 2 files, 11 tests passed | Includes direct web/server summary parity; no browser or server route round trip. |
| Same local head | `fnm exec --using=22.22.0 pnpm --filter @czar/web typecheck` | Passed | Web package only. |
| Same local head | `fnm exec --using=22.22.0 pnpm lint` | Passed | Repository lint, not functional acceptance. |
| Same local head | `fnm exec --using=22.22.0 pnpm --filter @czar/web build` | Passed; `/social`, `/social/me`, `/social/threads/[id]`, `/onboarding/representative` generated | No Playwright execution. |
| Shared integration snapshot `902f113`, reported by the orchestrator | Focused server command below | 15 files, 102/102 passed | Before SN-2 runtime and the local window-clear test joined; rerun on final merged head. |
| Same integration snapshot | `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run --no-cache test/social-incidents.test.ts test/social-routes.test.ts` | 2 files, 13/13 passed | Before later SN-2 runtime and case-7 boundary commits. |
| Same integration snapshot | `fnm exec --using=22.22.0 pnpm typecheck` and `fnm exec --using=22.22.0 pnpm lint` | Both passed after ignored local dependency links were repaired | Static checks, not runtime acceptance. |
| Same integration snapshot | `fnm exec --using=22.22.0 pnpm --filter @czar/web exec vitest run packages/social-templates.test.ts packages/social-api.test.ts` | 11/11 passed | Direct template parity and API client tests; no browser round trip. |
| Same integration snapshot | `fnm exec --using=22.22.0 pnpm --filter @czar/web build` | Passed after an ignored dependency link was repaired | Production build, no browser round trip. |
| Same integration snapshot | `python3 -I check-schemas.py` from `docs/specs/02-data-and-protocol/schemas/` | 34 files checked, 0 problems | Metadata check, not full JSON Schema validation. |
| SN-6 test commits `4105ee0` and `676abe7` | `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/social-incidents.test.ts` | 5/5 passed | Tests the two-owner `window-cleared` boundary and no-reopen edge on a package branch, not the final merged head. |
| Integration `ff5cc3a`, reported by the orchestrator | Focused social/buying/planner/selection server Vitest command below | 19 files, 126/126 passed | Key-free integration evidence; later browser commits do not change server code, but final PR-head rerun remains pending. |
| Integration `ff5cc3a`, reported by the orchestrator | `fnm exec --using=22.22.0 pnpm --filter @czar/config test` | 67/67 passed | Config package only; final PR-head rerun pending. |
| Integration after `ff5cc3a`, reported by the orchestrator | `fnm exec --using=22.22.0 pnpm typecheck` and `fnm exec --using=22.22.0 pnpm lint` | Both passed | Static checks; exact final PR head pending. |
| Integration `f3c6884`, reported by the orchestrator | `CZAR_SERVER_URL=http://127.0.0.1:4310 fnm exec --using=22.22.0 pnpm --filter @czar/web build`; then `CZAR_SOCIAL_E2E_FIXTURE=1 fnm exec --using=22.22.0 pnpm --filter @czar/web exec playwright test --config playwright.social.config.ts --project chromium-desktop` | Build passed; Chromium case 18 passed 1/1; disposable DB count afterward 0 | Uses real social routes and isolated PostgreSQL. Ancillary `/v1/me` account read is mocked because it requires Arc RPC. No Arc, wallet, payment or model was started. |
| Integration `c6a78f1`, reported by the orchestrator | Focused social/buying/planner/selection server Vitest run, adding the two files below | 21 files, 131/131 passed | Key-free integration evidence, not a full package or merged-head run. |
| Integration `719385e`, reported by the orchestrator | Focused social/buying/planner/selection server Vitest run (same 21 files; new cases 8, 9 and 21) | 21 files, 135/135 passed | Key-free integration evidence, not a full package or merged-head run. |
| Integration `719385e`, reported by the orchestrator | Focused `test/payer/vault-direct-partial.test.ts` Vitest run | 23/23 passed | Money-path regression slice, not a local-chain transaction. |
| Integration `719385e`, reported by the orchestrator | Config package tests; web social template/API Vitest | Config 67/67; web 11/11 passed | Key-free package checks; full package suites pending. |
| Integration `719385e`, reported by the orchestrator | `fnm exec --using=22.22.0 pnpm typecheck`; `fnm exec --using=22.22.0 pnpm lint`; `python3 -I check-schemas.py` from the schemas directory | Typecheck and lint passed; schema metadata 34 files, 0 problems | Static and metadata checks, not runtime acceptance or full JSON Schema validation. |
| Integration `719385e`, reported by the orchestrator | Web build with `CZAR_SERVER_URL=http://127.0.0.1:4310`; key-free `playwright.social.config.ts` Chromium spec | Build passed; real-server case 18 passed 1/1 | Only ancillary `/v1/me` was mocked; controlled product demo and screenshots pending. |
| Integration `9938e49`, reported by the orchestrator | Focused server social/buying/planner/selection plus `test/payer/vault-direct-partial.test.ts` | 22 files, 168/168 passed | Key-free integration slice, not all package suites or merged-head evidence. |
| Integration `9938e49`, reported by the orchestrator | `fnm exec --using=22.22.0 pnpm typecheck`; `fnm exec --using=22.22.0 pnpm lint` | Both passed | Static checks; final PR-head rerun pending. Config 67/67, web 11/11, schema 34/0, web build and case-18 browser evidence remain the prior snapshots above. |
| Integration `b12c5dc`, reported by the orchestrator | Key-free package suites listed below | Eight additional package suites passed | Does not include the signer, daemon, indexer, vault-client or full server suites. |
| Draft PR #208 at `da569bb` | Focused social, planner, selection and linked payer Vitest | 22 files, 175/175 passed | Includes SCR-165 producer/copy tests and the first independent review fixes; full suites and final head remain pending. |
| Draft PR #208, local Arc slice at the preceding integration state | `CZAR_LOCAL_CHAIN=1` Flow 4A slice | 1/1 passed on pinned local Arc Anvil | This is local-chain evidence, not the final merged head. |
| Same local Arc state | `CZAR_LOCAL_CHAIN=1` run 4 and run 5 | Run 4: 13/13 passed; run 5: 15/15 passed | Run 2 and final-head repeat remain pending. |
| Draft PR #208 at `da569bb` | Full server suite, run alone | 101 files passed, 3 skipped; 703 tests passed, 29 skipped | Skipped tests are not passes; final PR-head rerun pending. |
| Same draft head | Full signer suite, run alone | 14 files passed, 1 skipped; 168 tests passed, 20 skipped | Local-chain tests are separate. |
| Same draft head | Full daemon suite, run alone | 21 files passed, 1 skipped; 104 tests passed, 1 skipped | Local-chain tests are separate. |
| Same draft head | Full indexer suite, run alone | 16 files passed, 1 skipped; 108 tests passed, 3 skipped | Local-chain tests are separate. |
| Same draft head | Full vault-client suite, run alone | 9 files, 94/94 tests passed | Final PR-head rerun pending. |
| Draft PR #208 at `b6a0941` | Serial final local package suites: config, api-contract, schemas, logging, redaction, hashing, x402, web, merchants, server, signer, daemon, indexer and vault-client | 67, 20, 38, 14, 473, 54, 93, 81, 31, 703, 168, 104, 108 and 94 tests passed respectively; server 29, signer 20, daemon 1, indexer 3 tests skipped | Redaction's first sandbox run had two Unix-socket failures; the file and complete 473-test suite passed with local socket access. Skips remain skips. |
| Same draft head | `pnpm typecheck`, `pnpm lint`, schemas-directory `python3 -I check-schemas.py`, web build and real-server Chromium case 18 | All commands exited 0; 34 schema files, 0 problems; Chromium 1/1 passed | Case 18 mocks only ancillary `/v1/me`; not the controlled Arc product demo. |
| Same draft head | Pinned local Arc slice and runs 2/4/5 | 1/1, 20/20, 13/13 and 15/15 passed, serially | Run 2 exact SCR-165 base also passed 20/20; no observed new failure. |
| Same draft head | `FOUNDRY_PROFILE=arc arc-forge test` | Exit 0 | Output was captured without inspection; generated gas snapshot restored. |

The orchestrator's exact focused server command for `902f113` was:

```sh
fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run --no-cache test/social-migration.test.ts test/social-routes.test.ts test/social/consumer.test.ts test/social/templates.test.ts test/social/router.test.ts test/social/denylist.test.ts test/social/experience-card.test.ts test/social/inbox.test.ts test/social-buying.test.ts test/social-incidents.test.ts test/social-leads.test.ts test/social-lessons.test.ts test/planner/planner.test.ts test/planner/service.test.ts test/selection/registered.test.ts
```

The `ff5cc3a` 19-file run added `test/social/run.test.ts`,
`test/social/controlled-fixtures.test.ts`, `test/social/fixture-merchants.test.ts`, and
`test/social/worker-main.test.ts` to that 15-file list. Its observed result was 126/126. The
`c6a78f1` run added `test/social/controlled-local.test.ts` and
`test/social/service-thread-caps.test.ts`, plus new cases in the existing run and fixture tests;
its observed result was 131/131 across 21 files. The same 21-file scope passed 135/135 at
`719385e` after the case 8, 9 and 21 regressions joined. The controlled fixture test validates
all ten seeded `objective-submission` records against the canonical schema. At `9938e49`, the
same scope plus `test/payer/vault-direct-partial.test.ts` passed 168/168 across 22 files.
These are integration snapshots, not a final PR or merged `build-v1` head.

The orchestrator also ran these key-free package suites on integration `b12c5dc`:

| Package | Result |
|---|---|
| `@czar/api-contract` | 20/20 passed |
| `@czar/schemas` | 38/38 passed |
| `@czar/logging` | 14/14 passed |
| `@czar/redaction` | 473/473 passed |
| `@czar/hashing` | 54/54 passed |
| `@czar/x402` | 93/93 passed |
| `@czar/web` | 81/81 passed |
| `@czar/merchants` | 31/31 passed |

The first sandbox attempts for redaction and x402 could not bind loopback; their escalated
key-free reruns passed at the counts above. Config passed 67/67 on an earlier integration head.
The signer, daemon, indexer, vault-client and full server suites were run serially on the draft
branch after local-only authorization; the counts above distinguish passes from skips. All
package suites and the local-chain gates still require one final pass on the final PR head and
then merged-head acceptance.

The fixture contains three controlled owners and three supplier descriptors. The local seed now
probes the two fixture-only `comparison-search` and `lesson-search` endpoints through unpaid
`GET` 402 handlers and registers them only after validating the live challenge. This code has
key-free tests, but the product stack has not been started and the fixture has not been seeded
or replayed for the demo.

### Read-only local demo preflight

| Dependency | Current finding | Required before the demo |
|---|---|---|
| Local stack | Zaryab authorized the pinned local stack. Process Compose YAML now validates 11 processes, but the full stack did not reach readiness. Direct Arc Anvil and Docker Postgres each started; local deployment exited before a manifest. | Diagnose the failed deployment and retry only on chain ID 5042002. |
| Social worker | The local process-compose file now includes the worker. | Confirm migration dependency and restricted `czar_social` role in an authorized local-stack run. |
| Controlled seed/replay | Scripts and loopback-context checks passed key-free tests; authorization is recorded. | Run after stack readiness; no seed or replay has occurred. |
| Supplier set | Local-only unpaid 402 fixture handlers and probe-before-register logic exist. | Confirm both handlers answer live probes in the authorized local demo; do not copy origins into cloud config. |
| Browser | The standard key-free Playwright fixture passed case 18 against real `createApp` and a disposable DB again at `b6a0941`. | Capture controlled-owner screenshots against the full local stack. |
| Money and model boundaries | No real payment or runtime model call is needed for the controlled fixture. | Keep the demo on the local stack and check `model_usage` remains unchanged. |

## SCR-164 §3.18 acceptance matrix

Each row requires an executable check on the final merged head. “Partial” identifies a useful
test or earlier run, not a pass for the full case.

| # | Required behavior | Test mapping / current evidence | Final merged-head result |
|---|---|---|---|
| 1 | Posts have zero scoring weight; 100 duplicates leave counts, health and decision unchanged | `apps/server/test/selection/registered.test.ts` has the 100-post DB and full stable-decision comparison | Mapped test passed at draft `b6a0941`; merged head pending |
| 2 | Five `objective.delivered` replays publish one experience per paid step | Integrated `apps/server/test/social/run.test.ts` checks five delivery replays and one final experience | Mapped test passed at draft `b6a0941`; merged head pending |
| 3 | Rating revision supersedes the old post without duplicate publish | Integrated `social/run.test.ts` checks revision, moved evidence link and event count | Mapped test passed at draft `b6a0941`; merged head pending |
| 4 | Public strings exclude private subjects, paths, addresses, exact amounts and evidence IDs; public day times and random IDs | `social/experience-card.test.ts` now checks a published card against private subject, file, address, amount and evidence IDs and verifies UTC-day time; `social/denylist.test.ts` checks random `rep_`/`thr_`/`pst_` IDs do not share a time-ordered prefix; `social-routes.test.ts` covers public projections | Mapped test passed at draft `b6a0941`; merged head pending |
| 5 | Question routing and caps, while service threads remain open | `social/router.test.ts` tests three recipients and sharing-off; `social/run.test.ts` tests question close at eight; new `social/service-thread-caps.test.ts` tests 9th, 10th and 50th experience plus a third from one owner without closing the service thread | Mapped test passed at draft `b6a0941`; merged head pending |
| 6 | No-evidence reply abstains without a post | `social/run.test.ts` now asserts `abstain-no-evidence` and unchanged post count around that run | Mapped test passed at draft `b6a0941`; merged head pending |
| 7 | Incident open, unit/owner distinction, recovery, no flap, version change, window clear and unknown version | `apps/server/test/social-incidents.test.ts` covers these; local `4105ee0` and `676abe7` add the third-owner expiry and no-reopen boundary (5/5) | Mapped test passed at draft `b6a0941`; merged head pending |
| 8 | Open incident changes ordering and approval, not score or version guard | `social-buying.test.ts` checks score/version preservation; `planner/planner.test.ts` checks incident approval and stored decision ID; `payer/vault-direct-partial.test.ts` now pays only at that incident-ranked version and blocks a changed live version before reserve/sign | Mapped test passed at draft `b6a0941`; merged head pending |
| 9 | Lessons obey exact margin and survivor/incident bounds | `social-buying.test.ts` checks exact millionth margin and that a preference cannot cross the incident band; `planner/planner.test.ts` now rejects preferred suppliers outside top-three probes or whose live probe fails | Mapped test passed at draft `b6a0941`; merged head pending |
| 10 | Lead probe and safe-fetch rejection matrix, with no payment | `social-leads.test.ts` covers valid 402, wrong network, 200, DNS failure, cross-host redirect, forbidden port, private address, redirect loop, oversize body, malformed 402 and SCR-165 origin-only 202 deduplication | Mapped test passed at draft `b6a0941`; merged head pending |
| 11 | Consent change during a run prevents a post | Integrated `social/run.test.ts` covers context-to-commit consent change | Mapped test passed at draft `b6a0941`; merged head pending |
| 12 | Two workers on one inbox item publish once | `social/run.test.ts` now races two workers on the same inbox row and checks one post and one run; `social/inbox.test.ts` covers lease claim | Mapped test passed at draft `b6a0941`; merged head pending |
| 13 | Before-commit rollback and after-commit replay each yield one post/run | Integrated `social/run.test.ts` checks a scoped action ID has zero rows after injected insert fault, then one post and one run after replay | Mapped test passed at draft `b6a0941`; merged head pending |
| 14 | Delete tombstones every revision and supersedes derived lessons | `apps/server/test/social-routes.test.ts` | Mapped test passed at draft `b6a0941`; merged head pending |
| 15 | No model usage and every note stays NULL | `social/run.test.ts` now compares `model_usage` before and after its representative-run suite and counts zero non-NULL notes across every post in that suite's DB | Mapped test passed at draft `b6a0941`; merged head pending |
| 16 | `czar_social` cannot read base tables or write rating/ranking/money tables; concurrent migration succeeds | `apps/server/test/social-migration.test.ts` | Mapped test passed at draft `b6a0941`; merged head pending |
| 17 | `planning → no-supplier` event is transactional and unique | Integrated `planner/service.test.ts` checks success and trigger-induced rollback leaves planning state with zero events | Mapped test passed at draft `b6a0941`; merged head pending |
| 18 | Onboarding, public feed, owner tombstone and lesson dismiss in Playwright against local server | `apps/web/e2e/social-real.spec.ts` passed 1/1 at integration `f3c6884` with real social API and disposable DB; `/v1/me` was the only mocked ancillary read; DB cleanup verified 0 leftovers | Browser 1/1 passed at draft `b6a0941`; controlled demo pending |
| 19 | All package suites, typecheck, lint, schema checker, Arc slice/runs 2/4/5 and Forge | Draft `da569bb`: full server, signer, daemon, indexer, vault-client passed serially; local Arc slice 1/1, run 2 20/20, run 4 13/13, run 5 15/15; exact base run 2 20/20; Arc Forge exited 0 at `b6a0941` | All named local gates passed at draft `b6a0941`; controlled demo and merged head pending |
| 20 | A lower-id event that commits late is delivered once | `apps/server/test/social/consumer.test.ts` | Mapped test passed at draft `b6a0941`; merged head pending |
| 21 | Sharing-off receives a lesson without publishing; publishing run skips | `social/run.test.ts` checks private lesson creation with no public post and, at `22825d6`, a would-publish inbox item ending `skipped-sharing-off` with unchanged post count and a recorded run | Mapped test passed at draft `b6a0941`; merged head pending |

### Remaining acceptance evidence gaps

The matrix maps every case to code or a deferred gate. New `9938e49` tests close the prior
key-free case 4, 6, 8 and 15 mapping gaps. SCR-165's origin-only duplicate-lead outcome
has a passing focused regression. The separate representative-origin lead candidate source
is a specification gap under architect review. Every case still needs final PR-head evidence.
Case 19 still needs the remaining package/static/browser gates and one final serial pass.

Case 18's focused browser round trip used the standard key-free server fixture, real social
routes and isolated PostgreSQL. It did not create keys, deploy contracts, seed the product
stack, or make a payment. Its only browser route mock was the unrelated `/v1/me` account read,
which needs Arc RPC. The separate `e2e-local` browser harness writes a temporary key file and
deploys contracts; it remains unrun. Case 19's Arc slice and runs 2/4/5 have passed on the
draft branch, with the exact base run-2 comparison above. Forge exited 0 at `b6a0941`;
a final PR-head pass remains.

## Controlled local demo plan and evidence

Zaryab authorized the pinned local Arc stack, ephemeral local keys and transactions, controlled
seed/replay and Playwright screenshots. The stack attempt above did not reach readiness, so no
seed, replay or screenshot is claimed yet. No testnet, real funds or real device is authorized.

1. Pair a local fixture owner and complete `/onboarding/representative`; capture the exact
   consent paragraph and saved sharing choice.
2. Seed three controlled representatives, replay their outcomes and show their labelled
   experiences in the public feed and service thread.
3. Replay three distinct owners' bad outcomes against one version; show the incident thread
   and its attached experiences.
4. Plan in that task class; show unchanged score, incident ordering, `incident-open` approval,
   and SCR-165's exact count-free approval-screen line.
5. Publish 100 duplicate posts in the test harness; compare counts, health and ranking decision
   before and after.
6. Force `no-supplier`, route a `find-supplier` question, submit a controlled lead and show an
   unpaid 402 probe result. If no local merchant answers bare `GET` with 402, show and record
   `not-402` instead of claiming a successful probe.
7. Route a good-rated experience, show a bounded `prefer` lesson and near-tie explanation,
   then dismiss it on `/social/me`.
8. Pause the representative, replay an outcome and show `skipped-paused` in the activity trace.

Record dated screenshots or traces for the feed, incident/thread, approve view, lesson/dismiss,
lead probe and paused activity. Use controlled data only. Add artifact paths and the exact
build head here after the authorized run; no screenshots exist yet.

## Operator-authorized commands and results

The local stack start is documented in `ops/local/README.md`. Existing signer key references
were present without reading their contents. Zaryab authorized the local stack and ephemeral
local keys and transactions. The stack attempt exited before readiness; the seed and replay
commands remain unrun. The Arc suites and key-free gates listed above ran successfully.

```sh
# Attempted after local-only preflight; full stack did not reach readiness:
process-compose -f ops/local/process-compose.yaml up

# Only after verifying the seed script's database-host refusal and fixture registration:
pnpm --filter @czar/server social:seed-controlled --count 3 --network eip155:5042002
pnpm --filter @czar/server social:replay-fixtures

# Key-free merged-head static checks (run before chain work):
fnm exec --using=22.22.0 pnpm -r typecheck
fnm exec --using=22.22.0 pnpm lint
cd docs/specs/02-data-and-protocol/schemas
python3 -I check-schemas.py
cd ../../../..

# Full package suites ran serially with results above:
fnm exec --using=22.22.0 pnpm -r test

# Pinned local Arc checks passed with counts above:
CZAR_LOCAL_CHAIN=1 fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/local-pocket/flow-4a-slice-arc.test.ts
CZAR_LOCAL_CHAIN=1 fnm exec --using=22.22.0 pnpm --filter @czar/signer exec vitest run test/local-chain.test.ts
CZAR_LOCAL_CHAIN=1 fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/local-pocket/pocket-arc.test.ts
CZAR_LOCAL_CHAIN=1 fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/local-pocket/crash-restart-arc.test.ts
cd contracts
FOUNDRY_PROFILE=arc arc-forge test
cd ..

# Key-free real-server browser round trip also passed at b6a0941:
CZAR_SERVER_URL=http://127.0.0.1:4310 fnm exec --using=22.22.0 pnpm --filter @czar/web build
CZAR_SOCIAL_E2E_FIXTURE=1 fnm exec --using=22.22.0 pnpm --filter @czar/web exec playwright test --config playwright.social.config.ts --project chromium-desktop

# The separate e2e-local chain browser harness was not run:
fnm exec --using=22.22.0 pnpm --filter @czar/web e2e:local-server
```

The `pnpm -r test` command can report intentional skipped Arc suites; record pass/skip counts
per package and run the Arc suites above separately. Run the schema checker from its own
directory; invoking it at the repository root checks nothing. Use the pinned `arc-anvil` and
`arc-forge`, never standard Foundry substitutions. Restore any Forge-written snapshot before
reporting a clean diff.

For a public-feed screenshot after the approved local stack is running, start web separately
with `CZAR_SERVER_URL=http://127.0.0.1:3000 fnm exec --using=22.22.0 pnpm --filter @czar/web exec next dev --hostname localhost --port 3001`, then:

```sh
pnpm --filter @czar/web exec playwright screenshot --browser chromium \
  --wait-for-timeout 1000 http://localhost:3001/social /private/tmp/czar-social-feed.png
```

Capture owner-only views only in an authenticated controlled-owner browser session; never put
session tokens in command arguments, logs or screenshot filenames. Copy reviewed image artifacts
to the final report's evidence location and link them here after the run.

## Builder decisions, review and open work

- **Builder decisions:** `ops/local/process-compose.yaml:2` uses the installed Process Compose
  map/list configuration and template working directories. Its dry run validates all 11
  processes. `ops/local/process-compose.test.ts:42` follows the existing
  `listenOnLoopback` call. These are local-stack corrections, not changes to SCR-164.
  `apps/server/src/social/lessons.ts:73` excludes superseded source posts; the revision
  transaction at `apps/server/src/social/runtime/run.ts:667` supersedes their lessons.
  `apps/server/src/social/worker-main.ts:101` reads the configured incident interval.
  These choices implement the existing source-state and schedule contracts.
- **Defects fixed / found, not fixed:** populate from the exact final PR diff and review findings.
  The SN-4 privacy regression was fixed before integration snapshot `902f113`; review and rerun
  on the final head before calling it resolved for acceptance.
- **Independent review:** a fresh reviewer inspected PR #208 from `c8f7af1` through local
  `4c677df`, finding stale lessons from superseded posts and incident evaluation on the wrong
  interval. The lesson read guard, revision-state update and hourly schedule are now integrated;
  their focused and full server gates passed at `b6a0941`. The later changed code and report
  still need exact-head review before readiness.
- **Architect disposition:** SCR-165 merged at `c8f7af1`. Its count-free incident line,
  lesson-source `serviceId`, and idempotent duplicate-lead outcome are integrated with focused
  regressions. The representative-run lead origin source remains unspecified; an architect
  ruling is pending before claiming the SCR-164 §3.19 lead demo scene complete.
- **Duplicate lead contract:** the owner API now has a direct regression for repeated
  origin-only leads returning the existing IDs with no second row, post or probe. It passed in
  the 175-test focused integration run. A representative-origin duplicate cannot be exercised
  until its candidate source is defined.
- **Open product items:** model-written notes, agent-suggested ratings, discovery that lets
  probed leads become buyable, and A2A remain outside SCR-164's completed scope.
- **Remaining gate:** SN-1 through SN-6 merged into `build-v1`, all 21 cases verified on that
  merged head, authorized local demo with screenshots, independent review, and Zaryab sign-off.
