# Flow 4A completion report

## Summary

- **What Flow 4A delivers:** the owner's good/bad rating is the only quality signal. Health facts H1–H4 put a supplier behind approval or block it. Ranking uses the Wilson lower bound per service version. Unrated suppliers always need owner approval. Rulings: SCR-160, SCR-162 and SCR-163.
- **Merged:** all seven build packages (4A-1 to 4A-7) are on `build-v1`, together with their spec rulings and follow-ups. The merged head under test is `ca106fd`.
- **Evidence:** on `ca106fd`, the following pass:
  - every acceptance test that applies to Flow 4A
  - the full package suites, typecheck and lint
  - pinned `arc-anvil` runs 2, 4 and 5
  - Arc Forge
  - the two-objective local-chain slice
- **Review:** an independent review of the combined diff found one critical defect and one major defect. Both are fixed tests first. Three minor findings stay open and are listed below; none moves or risks funds.

## Environment

| Item | Value |
|---|---|
| `build-v1` SHA under test | `ca106fd` (merge of #187). Its tree equals `816fee2`, the #187 head. |
| Slice test | `apps/server/test/local-pocket/flow-4a-slice-arc.test.ts` at `7fd1b8a` (this PR). It differs from `ca106fd` only in this test file. |
| `arc-anvil` | 1.7.1-dev, commit `d497bee` (linux-amd64 build of the pinned arc-foundry release). sha256 `f46abcf89a367e7d433604b5f274464464ac8ea0767ca01cc03cf71d455413d1` |
| `arc-forge` | commit `d497bee`, sha256 `8f27a76e834be2abbe870d782489fb0e1e21d8c2c56866202cb3bc5202d75226` |
| solc | 0.8.30, sha256 `f3e987dc…c428f7`. Verified byte-identical to the official `v0.8.30/solc-static-linux` release asset. |
| Postgres | 16, local test instance |
| Where it ran | Linux cloud workspace. Runs 2/4/5, Forge and the slice used throwaway keys on a throwaway local chain, approved by Zaryab (2026-10-31). No testnet, no funds, no Circle, no model calls. |
| CI | Not running (GitHub Actions billing). All validation is local. |

## Pull requests

| PR | Content | Head | Merge | Merged |
|---|---|---|---|---|
| #170 | SCR-160 spec: ratings, health facts, lower-bound ranking | `b11e77e` | `71f119c` | 2026-10-30 |
| #174 | Schema regeneration for SCR-160 (Plan 1.3) | `4f96434` | `5e3ede0` | 2026-10-30 |
| #177 | 4A-1 Foundations: identifiers, config, contracts | `7bd6ac8` | `77e0226` | 2026-10-31 |
| #178 | 4A-2 Observations and payer write points | `03fdbf0` | `d7ac171` | 2026-10-31 |
| #180 | 4A-3 Health facts | `d51ddc1` | `08c74ac` | 2026-10-31 |
| #179 | 4A-4 Rating intake and result cards API | `aa14c4b` | `915faa6` | 2026-10-31 |
| #181 | 4A-5 CLI rating prompt | `b38a843` | `7573cde` | 2026-10-31 |
| #182 | SCR-162 alpha rulings | `66fb449` | `ca362bf` | 2026-10-31 |
| #183 | 4A-7 Web result rating cards | `bbff83f` | `c8d823e` | 2026-10-31 |
| #185 | SCR-162 rating ownership via the historical envelope | `8ea567f` | `5644510` | 2026-10-31 |
| #184 | SCR-163 spec: version producer, drift guards, exact-transfer query; RankingDecision 1.3 | `a13dd18` | `57e344b` | 2026-10-31 |
| #186 | SCR-162/163 no-response proof and recording (indexer exact-transfer route) | `db236d4` | `8abf21a` | 2026-10-31 |
| #187 | 4A-6 Ranking, service versions, drift guards, review fixes | `816fee2` | `ca106fd` | 2026-10-31 |
| this PR | Slice test fix and this report | `7fd1b8a` + report | — | — |

## Test results on `ca106fd`

### Static checks

- `pnpm -r typecheck`: clean (exit 0)
- `pnpm lint` (oxlint `--deny-warnings` plus oxfmt check): clean (exit 0). Before running it, `contracts/snapshots/routing.json` was restored: `arc-forge test` rewrites that gas snapshot.
- `python3 -I check-schemas.py`: 29 files, 0 problems

### Package suites

| Package | Result |
|---|---|
| `@czar/server` (arc-anvil suites run separately, below) | 82 files, 606 passed, 0 failed |
| `@czar/hashing` | 54 passed |
| `@czar/x402` | 93 passed |
| `@czar/config` | 66 passed |
| `@czar/schemas` | 33 passed |
| `@czar/api-contract` | 15 passed |
| `@czar/vault-client` | 92 passed, 2 skipped |
| `@czar/web` (unit) | 70 passed |
| `@czar/daemon` | 104 passed, 1 skipped |
| `@czar/signer` | 168 passed, 20 skipped (local-chain cases, run as run 2) |
| `@czar/merchants` | 31 passed |
| `@czar/indexer` | 108 passed, 3 skipped. The first run failed `replay-anvil.test.ts` with `spawn arc-anvil ENOENT` because `arc-anvil` was not on `PATH`. It passed on the rerun with `arc-anvil` on `PATH`. |

### Local chain (pinned `arc-anvil`, `CZAR_LOCAL_CHAIN=1`)

| Run | Command | Result |
|---|---|---|
| Slice | `pnpm --filter @czar/server exec vitest run test/local-pocket/flow-4a-slice-arc.test.ts` | **PASS** 1/1 |
| 2 | `pnpm --filter @czar/signer exec vitest run test/local-chain.test.ts` | **PASS** 20/20 |
| 4 | `pnpm --filter @czar/server exec vitest run test/local-pocket/pocket-arc.test.ts` | **PASS** 13/13 |
| 5 | `pnpm --filter @czar/server exec vitest run test/local-pocket/crash-restart-arc.test.ts` | **PASS** 15/15 |
| Forge | `FOUNDRY_PROFILE=arc arc-forge test` | **PASS** 440 passed, 0 failed, 0 skipped (27 suites) |

### Web result-card round trip (Playwright, `playwright.results.config.ts`)

- **Result:** 5/5 pass, including "Receipts rates Good, changes to Bad, then offers no third rating".
- **First run:** 4 passed and 1 timed out. The timeout was on the first page load, while `next dev` compiled `/home` cold during the chain runs. A rerun of that test alone passed.
- **Browser:** the pinned Playwright 1.64.1 expects headless shell build 1248, which the workspace cannot download. The tests ran on the installed build 1243, one Chromium minor version older.
- **Note for item 14:** the spec stubs the `/v1` routes. It does not run against the local server fixture.

## Two-objective slice (local chain)

### What it ran

- The real CZ-15 payer, the CZ-27 signer, the vault contracts on `arc-anvil`, and the D92 stand-ins.
- Ratings go through `submitRating`, the service behind `POST /v1/ratings` that the `czar result` prompt calls.
- The CLI keystroke handling is covered separately, by `apps/daemon/test/rating-prompt.test.ts`.

### Steps, all passing

1. Two objectives pay two suppliers: steady at 2000 atomic, flaky at 1000. Each observation settles from chain facts and carries a `ver_…` version.
2. Both suppliers start unrated, with `ranked[]` empty. `unverified[]` lists them in price order, flaky then steady, each with reason `unrated`.
3. The owner rates steady `good` and flaky `bad`. The ranking flips to steady (0.2065, Wilson 1/1 at z = 1.959964), then flaky (0). Ratings now outrank price.
4. A third objective with flaky settles calls whose response body is empty. Delivery is 0, the owner fact `settled-not-delivered` (H1) is written, and flaky carries `health-flagged`.
5. One correction changes steady from `good` to `bad`. Both now score 0 and the order flips back to price (flaky, then steady). `supplier_counts` holds good 0, bad 1 for steady under task class `data-json.search`.
6. A third rating that names the correction is refused with `422 bad-supersedes`.

### Fix found by running it

- **What failed:** the first run on `ca106fd` failed at step 4.
- **Cause:** each plan in the harness opens its own merchant with a fresh `payTo`, so the H1 plan is a new service version (SCR-163 §1), and that version has no ratings.
- **Fix:** the test now reads ranking at the rated version, as selection does for a stored candidate (`7fd1b8a`).
- **Product code:** correct, unchanged.

## SCR-160 §14 acceptance tests

| # | Evidence | Status |
|---|---|---|
| 1 | `evidence/observations.test.ts`; `evidence/receipts.test.ts:152`; vault-direct, pocket and job settle/release tests | Pass |
| 2 | `payer/job.test.ts` kill-resume matrix; `payer/pocket.test.ts` kill-resume matrix; vault-direct resume tests; run 5 | Pass |
| 3 | `ratings.test.ts:159` (20 calls bound to one rating, one correction); `selection/ranking/counts.test.ts` (counted once across 20 receipts) | Pass |
| 4 | `ratings.test.ts:255`, `:273` (not-producing, unknown-objective, nothing-settled, not-your-payment, controlled-user) | Pass |
| 5 | `ratings.test.ts:159`; the slice (third rating `bad-supersedes`) | Pass |
| 6 | `ratings.test.ts:273` (window closed) | Pass |
| 7 | `evidence/health-db.test.ts:127`; `planner/planner.test.ts:359`; `vault-direct-partial.test.ts`; the slice | Pass |
| 8 | `evidence/health-db.test.ts:141`, `:164` | Pass |
| 9 | `payer/job.test.ts` evaluator-reject and Expired cases; `evidence/health.test.ts` | Pass |
| 10 | `evidence/health-db.test.ts:213`; `planner/planner.test.ts:359`; `boundary.test.ts` | Pass |
| 11 | `selection/ranking/order.test.ts:63` (worked order, correction, H1, H4); `lower-bound.test.ts` (vectors, `toBeCloseTo(…, 4)`) | Pass |
| 12 | `planner/planner.test.ts:347`; `planner/service.test.ts:186`; config loader snapshot | Pass |
| 13 | `apps/daemon/test/rating-prompt.test.ts`, `rating-key.test.ts` | Pass |
| 14 | `apps/web/e2e-results/result-rating.spec.ts` (5/5) | Pass. The spec uses stubbed routes, not the local server fixture (see Open items) |
| 15 | The I-F-7 fixture DDL comparison | Not in Flow 4A. The I-F-7 substrate is a Flow 4B package (SCR-160 §15) |
| 16 | Config loader snapshot; `pnpm -r typecheck`; `pnpm lint`; `check-schemas.py` 29/0 | Pass |
| 17 | `ratings.test.ts:391`: rating events are structured enums and counts only, with no objective id or merchant label | Pass |

## Decisions recorded

- **SCR-160:** Zaryab's decisions F4-01 to F4-07: the rating is the only quality signal, H1–H4, Wilson lower bound, unrated means approval required.
- **SCR-161:** the observation row is written at `auth.signed`.
- **SCR-162:**
  - ownership through `objectives.envelope_ref`
  - no alternates
  - the payee attribution guard
  - structured rating log events
  - the no-response sentinel `NO_RESPONSE_COMMIT`
  - H1 only on evidenced seller failure
- **SCR-163:**
  - `versionId` producer and `service_versions`
  - H4 clears on a new version
  - drift guards within a step, on resume (§5) and between selection and live (§6, error `service-version-drift`)
  - the internal exact-transfer query (§7)
  - RankingDecision 1.3 with `unverified[].version_id`
- **Architect rulings during closure (2026-10-31):**
  - Observations, ratings and `supplier_counts` use `taskClassFor(capability)`, the key selection reads (SCR-160 §9.1, invariant 6).
  - An indexer `409` is recorded as `settlement-unproven` and the step moves on (SCR-163 §7 fail-closed). A `400` or a malformed proof still stops the step, because it means a configuration or contract bug.

## Defects

### Fixed during closure

| Defect | Severity | Fix |
|---|---|---|
| Ratings filed under the capability, but ranking reads the task class. Ratings never reached ranking. | Critical | Red `6ceb200`, green `9e58c15` (#187). `selection/task-class.ts` is shared by the planner and all three payer write points. The slice asserts the counts' task class. |
| An indexer `409` left a no-response step stuck forever | Major | Red `6ceb200`, green `9e58c15` (#187): `AmbiguousTransferError` and `settlement-unproven` |
| §6 text mismatch: `unverified[]` lacked `version_id` | Spec | #184 (`a13dd18`): RankingDecision 1.3 |
| Slice read ranking at the newest version, not the rated one | Test | `7fd1b8a` (this PR) |

### Open (no funds at risk)

| Defect | Severity | Where | Owner |
|---|---|---|---|
| `observations.settlement_tx` holds the vault `settle()` booking hash, not the USDC transfer | Minor | `vault-direct.ts` `markSettled` call | Flow 4B, before I-F-7 exposes the column |
| Hard-coded `3` for `health.consecutiveFailures` in `evidence/observations.ts` (H1 path, `markReleased` default) and as the `order.ts` default | Minor. No effect today: H1 evaluates one row, and every H2 caller passes the config value | `evidence/observations.ts`, `selection/ranking/order.ts` | Track B backlog |
| A step that mixes `ver_unknown` (rows from before SCR-163) and `ver_…` returns 500 on rating | Minor. Phase 1 has no production rows from before SCR-163 | `evidence/ratings.ts` `assertOneSupplier` | Track B backlog |

## Independent review

- **Reviewer:** a fresh agent that had not seen the work.
- **Scope:** `9632f0a..c52f532`, covering apps and packages.
- **Findings:** 1 critical (fixed), 1 major (fixed), 3 minor (open, above). The full table is on #187.
- **Checked and found correct:**
  - rating authorisation and the payee guard
  - `FOR UPDATE` serialisation
  - correction and third-rating refusal
  - window and idempotency
  - the drift guards
  - settle gating
  - no-response receipt proof (indexer `200` plus the on-chain re-check)
  - asset-only log matching
  - H4 clearing
- **Vendor agent instructions:**
  - The reviewer saw none.
  - During closure, `next dev` generated an untracked `apps/web/AGENTS.md` (Next.js "agent rules"). It was not followed and not committed.

## Alpha limits (SCR-162/163 deferrals)

- **Gateway and job receipts:** no-response proof and the version producer cover `x402-exact` only. Gateway and job observations write `ver_unknown`.
- **`amountDisplay`:** not shipped.
- **Plan 1.4 `alternateServices`:** not shipped. Plans have no alternates (SCR-162).

## Open items

### Operator (Zaryab)

- **Ponder rebuild:** #186 changed the indexer Ponder schema. The operator-managed rebuild and backfill have not been run.

### Flow 4B

- The I-F-7 substrate and its fixture DDL test (acceptance item 15).
- `settlement_tx` as the USDC transfer hash.
- Gateway and job receipts and version ids.

### M8 (testnet)

- The thin slice on testnet (T-050b).
- The real-passkey owner flow (`apps/web/e2e/passkey.spec.ts`, SCR-155 §5).
- Item 14 against a live local server instead of stubbed routes.

### Track B backlog

- The two minor defects above (hard-coded `3`, mixed-version 500).
- Wiring `playwright.results.config.ts` to the local-server fixture.

## Architect review

- **Reviewer:** chief architect, 2026-10-31.
- **Result:** passed, subject to Zaryab's merge of this PR.
- **Checked:**
  - Every Flow 4A package is merged.
  - Every applicable acceptance test passes on `ca106fd`.
  - The local-chain slice demonstrates ratings, the ranking flip, H1, one correction and a refused third rating.
  - The independent review's critical and major findings are fixed tests first.
  - The open minors move no funds.
- **Flow 4A is complete when Zaryab merges this report.**
