# Agent social network completion report

## Status and scope

**SN-6 / SCR-164. Flow 4A's social network is awaiting PR review and merge.**
The final evidence must come from one merged `build-v1` head after SN-1 through SN-6. A test
file, a passing package branch, or a mocked browser route does not establish that final result.

The feature lets an owner's representative publish structured purchase experience, questions,
replies and leads. Public posts supply context; only the paying owner's Good or Bad rating enters
supplier quality. Incidents and bounded personal lessons affect the planner under SCR-164 §3.13.
No post, reply count, handle, or model-written note is itself a supplier score.

| Package | Current evidence | Final state |
|---|---|---|
| SN-1 foundation | PR #195 merged at `4c9195d`; public and owner routes, migration and role. | Recheck on final merged head. |
| SN-2 events and worker | Worker, local seed/replay scripts and controlled fixture merchants are integrated and validated. | Final PR/head review and merge pending. |
| SN-3 questions and replies | Implementation and focused tests are on the integration branch. | Final PR/head review and merge pending. |
| SN-4 buying routes | Incident, lesson and lead changes, plus payer version and unpaid lead rejection regressions, are integrated and validated. | Final PR/head review and merge pending. |
| SN-5 web | UI, template parity, web build and real-server Chromium case 18 passed. | Final PR/head review and merge pending. |
| SN-6 controlled demo and report | Controlled local seed/replay, 18 Playwright screenshots, virtual-device pairing, live incident and lesson plans, 100 duplicate replays and this report are integrated. | Final PR-head review and merge pending. |

The combined integration branch is PR #208 into `build-v1`; Zaryab has not merged it.
The source and local evidence were pushed at `cef6358`; review status and the eventual merge
commit require separate verification before sign-off.
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

The authorized local stack is now ready with all 11 Process Compose processes. The first
attempt failed because Process Compose treated `{{.CZAR_ROOT}}` literally, the local deploy
needed an external Foundry configuration allowing a read-only signer reference, the server
needed its local public Circle and Arc URLs, and root-run K10 readiness needed workspace
links. The fixes are committed through `3f523de`. The architect authorized inspection of
error lines only through a redaction filter; raw logs were not read. Before the successful
local deploy retry, `contracts/broadcast/Deploy.s.sol/5042002/run-latest.json` was backed up
to `/private/tmp/czar-social-broadcast-run-latest-pre-retry.json` and its hash checked.
After deployment, the local overwrite was restored from that backup; both files matched
SHA-256 `f42b6462fa42afb51d4b1814a0fc25b66957f09de9b81deb20d2848f4d03e8b7`.
The controlled seed created three representatives; replay emitted nine outcomes and nine
ratings. Restarting the worker opened one incident. A controlled lead was added to the
already-seeded demo database using a temporary task script after the seed code gained the
same lead insertion. The local merchant's bare `GET /v1/search` returned 400, so the unpaid
lead probe correctly reached `rejected/not-402`, SCR-164 §3.19's documented fallback.
The captured demo and its live/fixture limits are recorded below.

SCR-166's binding ruling forbids a representative from inventing a lead origin. In this
iteration leads come only from the owner's `POST /v1/social/leads` or the controlled-fixture
seed; a representative run without a vetted origin ends `abstain-no-rule`.

Local demo commits through `00aaa11` add the virtual-device pairing and the two live
planner-built approval captures. This report records their exact input boundaries. The
source and demo are pushed to PR #208. Its final reviewed SHA must be checked after this
report edit; the eventual merged SHA remains pending.

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
| Draft PR #208 at `19d5ef1` | Serial package suites: config, api-contract, schemas, logging, redaction, hashing, x402, web, merchants, server, signer, daemon, indexer, vault-client | 67, 20, 38, 14, 473, 54, 93, 81, 31, 703, 168, 104, 108, 94 passed respectively | Server 29, signer 20, daemon 1, indexer 3 skipped; final Arc and merged-head gates pending. |
| Same head | `pnpm typecheck`, `pnpm lint`, schemas-directory `python3 -I check-schemas.py`, gitleaks diff scan, `scripts/check-no-secret-files.mjs` | Passed; schema metadata 34 files, 0 problems; no diff leaks or tracked secret filenames | Code head before final report/screenshots; no hosted result implied. |
| Draft PR #208 at `e6b48de` | Local Arc slice, runs 2/4/5, run alone in that order | 1/1, 20/20, 13/13, 15/15 passed | Same code as the prior base run-2 comparison; no new failure. |
| Same head | Web production build; real-server Chromium case 18 with `NO_COLOR` unset | Build passed; browser 1/1 passed without warnings | Browser's ancillary `/v1/me` read uses a fixture; social API uses the real server. |
| Same head | Focused `social/run.test.ts` after 100-replay harness joined; then full server suite serially | 14/14 focused; full server 101 files passed, 3 skipped, 703 tests passed, 29 skipped | Other package suites ran on `19d5ef1`, whose production source is identical. |
| Same head | `FOUNDRY_PROFILE=arc arc-forge test` | Exit 0 | Generated gas snapshot restored; chain-ID-colliding broadcast record restored from pre-deploy backup and hash-checked again. |
| Local final-gate head `7962c5a` | Root lint/typecheck, schemas-directory checker, web build, real-server Chromium case 18 | Passed; 34 schema files, 0 problems; Chromium 1/1 | Report-only amendment after these checks does not change production source. |
| Same local head | All 14 package suites, one package at a time | Config 67, API contract 20, schemas 38, logging 14, redaction 473, hashing 54, x402 93, web 81, merchants 31, server 703, signer 168, daemon 104, indexer 108, vault-client 94 passed | Server 29, signer 20, daemon 1, indexer 3 skipped. Redaction, x402 and merchants needed local socket/loopback permission after sandbox EPERM. The default full server run first had three failures; both affected files passed alone, and the full suite passed 703/703 with `--maxWorkers=1`. |
| Same local head | Pinned Arc slice; SCR-146 runs 2, 4 and 5; Arc Forge | 1/1, 20/20, 13/13, 15/15; Forge exit 0 | Run 2 first failed from an ignored worktree Ponder dependency path, then passed after lockfile-frozen dependency restoration. Forge output was kept private. Generated gas snapshot was restored, and the chain-ID-colliding broadcast record was restored with SHA-256 matching its pre-deploy backup. |

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
package suites and local-chain gates have a final serial pass on the draft source head; the
newer demo commit adds a test and artifacts, so the complete server suite was rerun there.
Merged-head acceptance remains after Zaryab's merge.

The fixture contains three controlled owners and three supplier descriptors. The authorized
local stack started; three controlled owners were seeded, and nine outcomes and nine ratings
were replayed. The seed used unpaid 402 preflight for all supplier descriptors. The worker
published posts and opened one incident. A controlled lead added to this pre-existing demo
seed was probed and rejected `not-402`: the merchant requires a `q` query, while LeadCard's
path-only hint permits only a bare GET. SCR-164 §3.19 explicitly permits this fallback.

### Local demo stack and results

| Dependency | Observed result | Remaining action |
|---|---|---|
| Local stack | All 11 processes running or completed on pinned Arc Anvil, chain ID 5042002; deployment wrote a manifest. The protected broadcast record was restored and hash-checked. | Stop stack after demo. |
| Social worker | Replayed controlled events, opened an initial incident, processed duplicate and pause cases, and routed the later prefer lessons. The evaluator reopened an incident from three new controlled bad observations; it did not receive a direct incident-row write. | Final evidence and cleanup checks. |
| Controlled seed/replay | Three controlled owners seeded; nine outcomes and nine ratings replayed. Later synthetic controlled evidence and four more outcomes/ratings supported the live plan captures. | None for the recorded demo. |
| Supplier set | Three local supplier descriptors passed unpaid 402 seed preflight; the lead bare GET returned 400 and was rejected `not-402`. | None; rejection is the specified fallback. |
| Browser | The key-free real-server case 18 passed; 18 controlled-demo screenshots now cover the eight local scenes, with deterministic planner inputs identified. | Final PR-head review. |
| Money and model boundaries | No real payment or runtime model call is needed for the controlled fixture. | Keep the demo on the local stack and check `model_usage` remains unchanged. |

## SCR-164 §3.18 acceptance matrix

Each row requires an executable check on the final merged head. “Partial” identifies a useful
test or earlier run, not a pass for the full case.

| # | Required behavior | Test mapping / current evidence | Final merged-head result |
|---|---|---|---|
| 1 | Posts have zero scoring weight; 100 duplicates leave counts, health and decision unchanged | `apps/server/test/selection/registered.test.ts` has the 100-post DB and full stable-decision comparison | Mapped test passed at draft `b6a0941`; merged head pending |
| 2 | Five `objective.delivered` replays publish one experience per paid step | Integrated `apps/server/test/social/run.test.ts` now checks 100 delivery replays and one final experience | Mapped test passed at draft `e6b48de`; merged head pending |
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
| 18 | Onboarding, public feed, owner tombstone and lesson dismiss in Playwright against local server | `apps/web/e2e/social-real.spec.ts` passed 1/1 with real social API and disposable DB; `/v1/me` was the only mocked ancillary read; DB cleanup verified 0 leftovers. The separate controlled demo captured 18 Playwright screenshots. | Browser and controlled demo complete; merged head pending |
| 19 | All package suites, typecheck, lint, schema checker, Arc slice/runs 2/4/5 and Forge | All 14 suites passed serially on integration source head, as did the static gates, local Arc slice 1/1, run 2 20/20, run 4 13/13, run 5 15/15 and Arc Forge; exact SCR-165 base run 2 passed 20/20 | All named local gates passed; merged head pending |
| 20 | A lower-id event that commits late is delivered once | `apps/server/test/social/consumer.test.ts` | Mapped test passed at draft `b6a0941`; merged head pending |
| 21 | Sharing-off receives a lesson without publishing; publishing run skips | `social/run.test.ts` checks private lesson creation with no public post and, at `22825d6`, a would-publish inbox item ending `skipped-sharing-off` with unchanged post count and a recorded run | Mapped test passed at draft `b6a0941`; merged head pending |

### Acceptance evidence status

The exact test-name map for the 21 cases is below. "Prior pass" means the named check was
observed on a prior PR head; final-head validation remains separate.

| Case | Test file and exact test name | Status |
|---|---|---|
| 1 | `selection/registered.test.ts`: "keeps evidence counts, health and every decision field stable after 100 social posts" | Prior pass |
| 2 | `social/run.test.ts`: "keeps posts, evidence, health facts, and plans unchanged across 100 duplicate replays" | Passed at `e6b48de` |
| 3 | `social/run.test.ts`: "revises a paid-step experience after a rating without routing it again" | Prior pass |
| 4 | `social/experience-card.test.ts`: "publishes only day-truncated, private-id-free strings to the public card"; `social/denylist.test.ts`: "rejects a private or injected string before publication" and "does not order %s public identifiers by creation time"; `social-routes.test.ts`: "serves public incident and thread views without private evidence" | Prior pass |
| 5 | `social/router.test.ts`: "routes at most three question recipients and excludes sharing-off subscribers"; `social/run.test.ts`: "answers a routed question only with its own settled evidence"; `social/service-thread-caps.test.ts`: "accepts the ninth, tenth, and fiftieth experience from different owners" | Prior pass |
| 6 | `social/run.test.ts`: "answers a routed question only with its own settled evidence" (separate corroboration no-evidence assertion) | Passed at `19d5ef1` |
| 7 | `social-incidents.test.ts`: "opens at three owners, updates units, recovers, and does not flap"; "closes when the incident window loses its third owner and does not reopen"; "closes a known version on use of a new one but keeps ver_unknown open"; `social-buying.test.ts`: "badges every ranked version of a supplier with an unknown-version incident" | Prior pass |
| 8 | `social-buying.test.ts`: "moves an incident below all incident-free rated suppliers without changing scores" and "matches an exploration pick against its stored verified version"; `planner/planner.test.ts`: "holds earned allowance for a ranked supplier with an open incident" and "holds an exploration supplier on its stored unverified version"; `payer/vault-direct-partial.test.ts`: "pays a ranked incident-badged selection only at its stored version" and "blocks a ranked incident-badged selection if the live version changed" | Prior pass |
| 9 | `social-buying.test.ts`: "applies lessons only within the exact millionth margin and after incident ordering" and "does not let a preference override the incident ordering band"; `planner/planner.test.ts`: "does not let a lesson promote a probed unverified exploration supplier", "does not promote a preferred supplier outside the top three probes", "does not promote a preferred supplier whose live probe failed" | Prior pass |
| 10 | `social-leads.test.ts`: valid 402; wrong network and 200; unsafe HTTP and DNS; cross-host redirect; forbidden port and private address; redirect loop, oversize, malformed 402; `social-routes.test.ts`: "returns the original lead for a repeated origin-only suggestion" and "rejects unsafe lead origins and a different owner's deletion" | Passed at `3f523de` |
| 11 | `social/run.test.ts`: "rejects publication when consent changes after context load" | Prior pass |
| 12 | `social/run.test.ts`: "creates one post when two workers race to claim the same inbox row" | Prior pass |
| 13 | `social/run.test.ts`: "rolls back before commit and keeps one post after a commit crash" | Passed at `19d5ef1`; after-commit failure is an injected hook, not an OS kill |
| 14 | `social-routes.test.ts`: "tombstones every revision and supersedes lessons from the chain" | Prior pass |
| 15 | `social/run.test.ts`: "leaves model usage unchanged and every post note empty across all representative runs" | Passed within its test database; the live controlled demo also began and ended at zero model-usage rows and zero non-NULL post notes |
| 16 | `social-migration.test.ts`: "allows its projections and rejects base-table reads and money writes" and "applies concurrently in separate databases on one cluster" | Prior pass |
| 17 | `planner/service.test.ts`: "moves objectives without a candidate to no-supplier" and "rolls back the no-supplier transition when its event insert fails" | Prior pass |
| 18 | `apps/web/e2e/social-real.spec.ts`: "controlled social round trip uses the real local server" | Passed at `e6b48de`; demo captured with limits below |
| 19 | No single test: serial package suites, lint, typecheck, schema checker, local Arc slice and runs 2/4/5, Forge | Passed on draft source head through `e6b48de`; merged-head gate pending |
| 20 | `social/consumer.test.ts`: "does not skip an earlier transaction that commits after a later event" | Prior pass |
| 21 | `social/run.test.ts`: "creates a private lesson while sharing is off without publishing" and "skips a would-publish item when the representative turns sharing off" | Prior pass |

The matrix maps every case to code or a deferred gate. New `9938e49` tests close the prior
key-free case 4, 6, 8 and 15 mapping gaps. SCR-165's origin-only duplicate-lead outcome
has a passing focused regression. SCR-166 now binds the representative lead origin rule:
without a vetted origin, the routed `find-supplier` run records `abstain-no-rule`. A focused
test passed at `19d5ef1`; the fixture seed includes a controlled lead. Every case still needs
final PR-head evidence after the report commit. Case 19's serial pass and demo screenshots
are recorded above.

Case 18's focused browser round trip used the standard key-free server fixture, real social
routes and isolated PostgreSQL. It did not create keys, deploy contracts, seed the product
stack, or make a payment. Its only browser route mock was the unrelated `/v1/me` account read,
which needs Arc RPC. The separate `e2e-local` browser harness writes a temporary key file and
deploys contracts; it remains unrun. Case 19's Arc slice and runs 2/4/5 have passed on the
draft branch, with the exact base run-2 comparison above. Forge exited 0 again at `e6b48de`;
the merged-head pass remains after Zaryab's merge.

## Controlled local demo plan and evidence

Zaryab authorized the pinned local Arc stack, ephemeral local keys and transactions, controlled
seed/replay and Playwright screenshots. The stack, seed and replay completed. All 18 screenshots
were captured by Playwright and are indexed in
[`social-network-demo/readme.md`](social-network-demo/readme.md). No testnet, real funds,
runtime model call or real device was used.

| SCR-164 §3.19 step | Captured evidence | Limit |
|---|---|---|
| 1. Onboarding | [`passkey created`](social-network-demo/czar-social-demo-01-passkey-created.png), [`device paired`](social-network-demo/czar-social-demo-01-paired-device.png), [`consent after pairing`](social-network-demo/czar-social-demo-01-consent-after-pairing.png) | Virtual WebAuthn authenticator registered and signed in a new local owner; the live API issued a pairing code, paired the controlled computer and recorded structured consent. The browser shell alone overrode `/v1/me.vaultCreated` to pass the unrelated vault UI gate; no vault or payment was created. |
| 2. Three representatives | [`02-feed`](social-network-demo/czar-social-demo-02-feed.png) | Three controlled owners, nine outcomes, nine ratings. |
| 3. Incident | [`03-incident-thread`](social-network-demo/czar-social-demo-03-incident-thread.png) | Opened with three bad owners, then closed after recovery evidence; captured thread shows both transitions. |
| 4. Buying effect | [`live incident plan`](social-network-demo/czar-social-demo-04-incident-live-plan.png), [`plan evidence`](social-network-demo/czar-social-demo-incident-plan-evidence.json) | Three new synthetic controlled owners supplied settled bad evidence; the production evaluator opened a new incident with three owners and three negatives. The production planner read it and persisted Plan 1.4 with `incident-open`; the live approval API and screen showed the exact line. Ranking candidates, scores, directory entries and probe outcomes were deterministic demo inputs. The clean candidate's probe was unavailable, so the incident supplier remained best available. No approval or payment was submitted. |
| 5. 100 duplicates | [`before`](social-network-demo/czar-social-demo-05-before-100-replays.png), [`after`](social-network-demo/czar-social-demo-05-after-100-replays.png) | 100 live duplicate outcome events ended `abstain-no-evidence`; counts, plan-hash aggregate and feed article hash were unchanged. Separate case-1 test inserts 100 social posts. |
| 6. Controlled lead | [`06-lead-thread`](social-network-demo/czar-social-demo-06-lead-thread.png) | Bare local merchant GET returned 400; unpaid probe reached `rejected/not-402`, SCR-164 §3.19 fallback. |
| 7. Prefer lesson | [`live lesson plan`](social-network-demo/czar-social-demo-07-prefer-live-plan.png), [`dismissed`](social-network-demo/czar-social-demo-07-live-dismissed.png), [`plan evidence`](social-network-demo/czar-social-demo-lesson-plan-evidence.json) | The production router created active prefer lessons; the planner read one and chose its supplier at 0.89 over the first-ranked 0.90 supplier, within the permitted margin. It persisted Plan 1.4; the live approval API and screen explained the lesson before the owner dismissed it. Ranking candidates, scores, directory entries and probe outcomes were deterministic demo inputs. No approval or payment was submitted. |
| 8. Pause | [`paused`](social-network-demo/czar-social-demo-08-paused.png), [`skipped`](social-network-demo/czar-social-demo-08-skipped-paused.png) | Live controlled owner pause; replayed outcome produced `skipped-paused`. |

The social browser requests used the real local server. The unrelated `/v1/me` account summary
was supplied by a static local-network browser route because controlled fixture users have no
vault account. For step 1, only its `vaultCreated` field was overridden in the browser shell;
passkey authentication, pairing and consent used live local API calls. The first approval
screens used browser fixtures; the step 4 and 7 screens linked above used production
planner-built and persisted plans served through the live approval API. The ranking, directory
and probe inputs remained deterministic; no approval, payment or model call was submitted.
The earlier live demo measured zero `model_usage` rows and zero non-NULL post notes before
and after its replay. The later plan capture measured zero for both only after completion;
its scripts did not delete usage rows or change post notes. The latter is a final-state
observation, not a measured before/after pair.

## Operator-authorized commands and results

The local stack start is documented in `ops/local/README.md`. Existing signer key references
were present without reading their contents. Zaryab authorized the local stack and ephemeral
local keys and transactions. The stack, seed and replay succeeded. The Arc suites and key-free
gates listed above ran successfully on prior heads; final-head gates remain.

```sh
# Started successfully with temporary external Foundry config and local-only preflight:
FOUNDRY_CONFIG=/private/tmp/czar-social-foundry-deploy.toml \
  fnm exec --using=22.22.0 process-compose -f ops/local/process-compose.yaml \
  --disable-dotenv --keep-project -D -p 18080 -L /private/tmp/czar-social-stack.log up

# Completed on the loopback demo database:
CZAR_LOCAL_CONFIG=../../env/local.toml \
  CZAR_DATABASE_URL=postgres://postgres@127.0.0.1:15433/postgres \
  CZAR_ARC_RPC_URL=http://127.0.0.1:8545 \
  fnm exec --using=22.22.0 pnpm --filter @czar/server social:seed-controlled \
  --count 3 --network eip155:5042002
CZAR_LOCAL_CONFIG=../../env/local.toml \
  CZAR_DATABASE_URL=postgres://postgres@127.0.0.1:15433/postgres \
  CZAR_ARC_RPC_URL=http://127.0.0.1:8545 \
  fnm exec --using=22.22.0 pnpm --filter @czar/server social:replay-fixtures

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

Owner-only views were captured in authenticated controlled-owner browser sessions. Session
tokens were not placed in command arguments, logs or screenshot filenames. The reviewed
Playwright images and their controlled input limits are indexed above.

## Builder decisions, review and open work

- **Builder decisions:** `ops/local/process-compose.yaml:2` uses the installed Process Compose
  map/list configuration and repository-root working directories. The local run started all 11
  processes. `ops/local/process-compose.test.ts:42` follows the existing
  `listenOnLoopback` call. These are local-stack corrections, not changes to SCR-164.
  `apps/server/src/social/lessons.ts:73` excludes superseded source posts; the revision
  transaction at `apps/server/src/social/runtime/run.ts:667` supersedes their lessons.
  `apps/server/src/social/worker-main.ts:101` reads the configured incident interval.
  These choices implement the existing source-state and schedule contracts.
- **Defects fixed:** the fresh review found system lead posts incorrectly increasing the
  representative contribution count (`apps/server/src/social/leads.ts:145`), and two system
  post values that differed from SCR-164's exact copy (`leads.ts:125`,
  `apps/server/src/social/incidents.ts:247`). Tests failed first and passed after fixes at
  `3f523de`. The SN-4 privacy regression was fixed before integration snapshot `902f113`.
- **Independent review:** a fresh reviewer inspected PR #208 from `c8f7af1` through local
  `4c677df`, finding stale lessons from superseded posts and incident evaluation on the wrong
  interval. The lesson read guard, revision-state update and hourly schedule are now integrated;
  their focused and full server gates passed at `b6a0941`. The later changed code and report
  still need exact-head review before readiness. A second fresh reviewer inspected PR #208 at
  `e2a1485`; it found the three defects above and no confirmed critical security or buying
  regression in its assigned scope. Its initial database-URL concern was withdrawn after
  checking SCR-164 §3.19's explicit loopback-host rule. Its follow-up through local
  `e6b48de` found the fixes present and no new critical source issue. Its exact pushed-head
  follow-up at `cef6358` reviewed the later demo commits, artifacts and report, finding no
  P0/P1 or new source defect. It requested this report-state cleanup before readiness.
- **Architect disposition:** SCR-165 merged at `c8f7af1`. Its count-free incident line,
  lesson-source `serviceId`, and idempotent duplicate-lead outcome are integrated with focused
  regressions. The architect's binding SCR-166 ruling restricts leads in this iteration to
  owner submissions and the controlled fixture. Routed representatives without a vetted lead
  origin record `abstain-no-rule`, tested at `19d5ef1`. The controlled lead probe reached the
  `not-402` fallback permitted by SCR-164 §3.19.
- **Duplicate lead contract:** the owner API now has a direct regression for repeated
  origin-only leads returning the existing IDs with no second row, post or probe. It passed in
  the 175-test focused integration run. SCR-166 excludes representative-sourced leads in this
  iteration.
- **Open product items:** model-written notes, agent-suggested ratings, discovery that lets
  probed leads become buyable, and A2A remain outside SCR-164's completed scope.
- **Remaining gate:** SN-1 through SN-6 merged into `build-v1`, all 21 cases verified on that
  merged head, authorized local demo with screenshots, independent review, and Zaryab sign-off.
