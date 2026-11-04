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
| SN-2 events and worker | Worker, local seed/replay scripts and controlled fixture merchants are on the integration branch through `ff5cc3a`; key-free tests passed. | Final PR/head review, authorized demo and merge pending. |
| SN-3 questions and replies | Implementation and focused tests are on the integration branch. | Final PR/head review and merge pending. |
| SN-4 buying routes | Incident, lesson and lead changes are on the integration branch. | Final PR/head review and merge pending. |
| SN-5 web | UI, direct template parity and the real-server case-18 browser test are on the integration branch through `f3c6884`. | Final PR/head review and merge pending. |
| SN-6 controlled demo and report | Controlled fixture, local seed/replay support and this draft report are on the integration branch. | Authorized local-chain demo, final report and merge pending. |

The combined integration branch is not a merged PR. Record its final PR number, reviewed head,
merge commit, and review status here before sign-off. Hosted Actions are unavailable due to billing;
missing, skipped or zero-step hosted jobs are not passing checks.

## Key-free evidence already collected

| Head and scope | Exact command | Observed result | Limit |
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

The orchestrator's exact focused server command for `902f113` was:

```sh
fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run --no-cache test/social-migration.test.ts test/social-routes.test.ts test/social/consumer.test.ts test/social/templates.test.ts test/social/router.test.ts test/social/denylist.test.ts test/social/experience-card.test.ts test/social/inbox.test.ts test/social-buying.test.ts test/social-incidents.test.ts test/social-leads.test.ts test/social-lessons.test.ts test/planner/planner.test.ts test/planner/service.test.ts test/selection/registered.test.ts
```

The `ff5cc3a` 19-file run added `test/social/run.test.ts`,
`test/social/controlled-fixtures.test.ts`, `test/social/fixture-merchants.test.ts`, and
`test/social/worker-main.test.ts` to that 15-file list. Its observed result was 126/126.

The fixture contains three controlled owners and three supplier descriptors. The local seed now
probes the two fixture-only `comparison-search` and `lesson-search` endpoints through unpaid
`GET` 402 handlers and registers them only after validating the live challenge. This code has
key-free tests, but the product stack has not been started and the fixture has not been seeded
or replayed for the demo.

### Read-only local demo preflight

| Dependency | Current finding | Required before the demo |
|---|---|---|
| Local stack | `ops/local/README.md` specifies `process-compose`; composition starts Arc Anvil, deployment, signer, server, indexer and a merchant. | Operator authorizes and provisions the already specified local key references; confirm loopback endpoints and a clean local chain. |
| Social worker | The local process-compose file now includes the worker. | Confirm migration dependency and restricted `czar_social` role in an authorized local-stack run. |
| Controlled seed/replay | The scripts and loopback-context checks exist and passed key-free tests. | Review the final head, then run seed/replay only after local-stack authorization. |
| Supplier set | Local-only unpaid 402 fixture handlers and probe-before-register logic exist. | Confirm both handlers answer live probes in the authorized local demo; do not copy origins into cloud config. |
| Browser | The standard key-free Playwright fixture passed case 18 against real `createApp` and a disposable DB. | Capture controlled-owner screenshots and full local-stack evidence separately after authorization. |
| Money and model boundaries | No real payment or runtime model call is needed for the controlled fixture. | Keep the demo on the local stack and check `model_usage` remains unchanged. |

## SCR-164 §3.18 acceptance matrix

Each row requires an executable check on the final merged head. “Partial” identifies a useful
test or earlier run, not a pass for the full case.

| # | Required behavior | Test mapping / current evidence | Final merged-head result |
|---|---|---|---|
| 1 | Posts have zero scoring weight; 100 duplicates leave counts, health and decision unchanged | `apps/server/test/selection/registered.test.ts` has the 100-post DB and full stable-decision comparison | Pending final head |
| 2 | Five `objective.delivered` replays publish one experience per paid step | Integrated `apps/server/test/social/run.test.ts` checks five delivery replays and one final experience | Pending final head |
| 3 | Rating revision supersedes the old post without duplicate publish | Integrated `social/run.test.ts` checks revision, moved evidence link and event count | Pending final head |
| 4 | Public strings exclude private subjects, paths, addresses, exact amounts and evidence IDs; public day times and random IDs | `social/denylist.test.ts`, `social/experience-card.test.ts`, `social-routes.test.ts`; random-ID prefix and complete outbound-string assertions need final-head review | Pending |
| 5 | Question routing and caps, while service threads remain open | Integrated `social/router.test.ts` tests three recipients and sharing-off; `social/run.test.ts` tests close at eight; 9th/10th/50th service posts and third experience still need focused evidence | Pending |
| 6 | No-evidence reply abstains without a post | Integrated `social/run.test.ts` asserts `abstain-no-evidence`; scoped no-new-post assertion still needs review | Pending |
| 7 | Incident open, unit/owner distinction, recovery, no flap, version change, window clear and unknown version | `apps/server/test/social-incidents.test.ts` covers these; local `4105ee0` and `676abe7` add the third-owner expiry and no-reopen boundary (5/5) | Pending final head |
| 8 | Open incident changes ordering and approval, not score or version guard | `social-buying.test.ts`, `planner/planner.test.ts` cover ordering, approval and exploration; check a stored-decision version-guard assertion | Pending |
| 9 | Lessons obey exact margin and survivor/incident bounds | `social-buying.test.ts` covers millionth margin and survivor/incident ordering; check out-of-top-K and probe-failed branches | Pending |
| 10 | Lead probe and safe-fetch rejection matrix, with no payment | `social-leads.test.ts` covers valid 402, wrong network, 200, unsafe HTTP and DNS failure; cross-host redirect, port/private address and duplicate origin need final test mapping | Pending |
| 11 | Consent change during a run prevents a post | Integrated `social/run.test.ts` covers context-to-commit consent change | Pending final head |
| 12 | Two workers on one inbox item publish once | `social/inbox.test.ts` covers lease claim; a two-worker publish race is not yet demonstrated | Pending |
| 13 | Before-commit rollback and after-commit replay each yield one post/run | Integrated `social/run.test.ts` checks a scoped action ID has zero rows after injected insert fault, then one post and one run after replay | Pending final head |
| 14 | Delete tombstones every revision and supersedes derived lessons | `apps/server/test/social-routes.test.ts` | Pending |
| 15 | No model usage and every note stays NULL | Integrated `social/run.test.ts` checks one post's NULL note; a suite-wide `model_usage` before/after and all-post NULL assertion are still missing | Pending |
| 16 | `czar_social` cannot read base tables or write rating/ranking/money tables; concurrent migration succeeds | `apps/server/test/social-migration.test.ts` | Pending |
| 17 | `planning → no-supplier` event is transactional and unique | Integrated `planner/service.test.ts` checks success and trigger-induced rollback leaves planning state with zero events | Pending final head |
| 18 | Onboarding, public feed, owner tombstone and lesson dismiss in Playwright against local server | `apps/web/e2e/social-real.spec.ts` passed 1/1 at integration `f3c6884` with real social API and disposable DB; `/v1/me` was the only mocked ancillary read; DB cleanup verified 0 leftovers | Key-free browser slice passed; final PR-head rerun and controlled demo pending |
| 19 | All package suites, typecheck, lint, schema checker, Arc slice/runs 2/4/5 and Forge | Integration `ff5cc3a` social server 19 files 126/126, config 67/67, root typecheck/lint passed; earlier schema checker 34/0 | Arc/Forge and final PR-head package gates pending |
| 20 | A lower-id event that commits late is delivered once | `apps/server/test/social/consumer.test.ts` | Pending |
| 21 | Sharing-off receives a lesson without publishing; publishing run skips | `social-lessons.test.ts` tests lesson creation but not the sharing-off runner path; a combined test is missing | Pending |

### Remaining acceptance evidence gaps

The matrix maps every case to code or a deferred gate. The remaining key-free proof gaps to
audit on the final PR head are: case 4's random-ID and complete public-string assertions;
case 5's unbounded service-thread posting; case 6's scoped no-new-post assertion; case 8's
stored-decision version guard; case 9's out-of-top-K and probe-failed branches; case 10's
cross-host redirect, port/private address and duplicate origin; case 12's two-worker publish
race on the same inbox item; case 15's suite-wide `model_usage` and NULL note checks; and case
21's sharing-off lesson and skipped publishing run. Case 13's scoped rollback/replay test is
now integrated, but still needs its final-head run.

Case 18's focused browser round trip used the standard key-free server fixture, real social
routes and isolated PostgreSQL. It did not create keys, deploy contracts, seed the product
stack, or make a payment. Its only browser route mock was the unrelated `/v1/me` account read,
which needs Arc RPC. The separate `e2e-local` browser harness writes a temporary key file and
deploys contracts; it remains unrun. Case 19 additionally requires Arc local-chain suites and
Forge, plus a final PR-head rerun of all key-free checks. These gates remain pending explicit
operator authorization where a harness generates keys.

## Controlled local demo plan and evidence

Run only after the local-only seed/replay safeguards, supplier registration and unpaid probe
handlers are reviewed, and Zaryab authorizes the local stack and its key-producing harnesses.
No seed, stack, payment, model call or device action was performed to prepare this draft.

1. Pair a local fixture owner and complete `/onboarding/representative`; capture the exact
   consent paragraph and saved sharing choice.
2. Seed three controlled representatives, replay their outcomes and show their labelled
   experiences in the public feed and service thread.
3. Replay three distinct owners' bad outcomes against one version; show the incident thread
   and its attached experiences.
4. Plan in that task class; show unchanged score, incident ordering, `incident-open` approval,
   and the exact approval-screen line once its immutable count/wording contract is resolved.
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

## Operator-authorized commands: not run for this draft

The local stack start is documented in `ops/local/README.md`. It requires separately
provisioned local signer key references and deployments; the command does not provision them.
The existing `apps/web/e2e-local/local-server-fixture.mjs` writes a temporary run-6 key file
and deploys contracts, so even a browser test using that configuration needs explicit approval.

```sh
# Only after operator approval and local-only configuration preflight:
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

# Full package suites only after auditing their harnesses for key generation:
fnm exec --using=22.22.0 pnpm -r test

# Pinned local Arc checks; each harness may generate ephemeral keys:
CZAR_LOCAL_CHAIN=1 fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/local-pocket/flow-4a-slice-arc.test.ts
CZAR_LOCAL_CHAIN=1 fnm exec --using=22.22.0 pnpm --filter @czar/signer exec vitest run test/local-chain.test.ts
CZAR_LOCAL_CHAIN=1 fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/local-pocket/pocket-arc.test.ts
CZAR_LOCAL_CHAIN=1 fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/local-pocket/crash-restart-arc.test.ts
cd contracts
FOUNDRY_PROFILE=arc arc-forge test
cd ..

# Key-free real-server browser round trip, already run on integration f3c6884:
CZAR_SERVER_URL=http://127.0.0.1:4310 fnm exec --using=22.22.0 pnpm --filter @czar/web build
CZAR_SOCIAL_E2E_FIXTURE=1 fnm exec --using=22.22.0 pnpm --filter @czar/web exec playwright test --config playwright.social.config.ts --project chromium-desktop

# The separate e2e-local chain browser harness still requires operator authorization:
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

- **Builder decisions:** record final per-package choices with file and line after the bundled
  integration review. No unapproved specification change is implied by this draft.
- **Defects fixed / found, not fixed:** populate from the exact final PR diff and review findings.
  The SN-4 privacy regression was fixed before integration snapshot `902f113`; review and rerun
  on the final head before calling it resolved for acceptance.
- **Independent review:** pending. Give a fresh reviewer only the combined diff, `CLAUDE.md`,
  SCR-164 and the bounded defect brief in the orchestrator's definition of done. Record its
  concrete findings, fixes and final-head rerun.
- **Architect disposition:** the approval UI currently names the selected supplier for an
  `avoid` lesson that may concern a different supplier, while `why.lessons[]` lacks an immutable
  lesson service ID. The specified incident line says “other owners,” but the stored
  `distinct_owners` can include the approving buyer. The architect must bind the immutable
  lesson supplier and buyer-relative count or amend the approved wording before these lines
  are presented as verified. Focused expected-red UI regressions exist at `ee61df2`; they are
  not passing acceptance evidence.
- **Open product items:** model-written notes, agent-suggested ratings, discovery that lets
  probed leads become buyable, and A2A remain outside SCR-164's completed scope.
- **Remaining gate:** SN-1 through SN-6 merged into `build-v1`, all 21 cases verified on that
  merged head, authorized local demo with screenshots, independent review, and Zaryab sign-off.
