# Track A exit report (SCR-146 §3, amended by SCR-155 §5)

**Status:** READY FOR REVIEW. Runs 1–6 PASS on merged bases. SCR-155 §1–§3 are merged (#155, #163, #164). The SCR-157 PRs (#166, #167, approved with SCR-158 changes) are open with their tests passing; they must merge before sign-off. Track B stays held until Zaryab merges the final version of this report.

## Gate (SCR-155 §5)
| # | Item | Status |
|---|---|---|
| 1 | SCR-155 §2 (BadTtl: chain time, one new attempt) merged with tests passing | Merged: #163 |
| 2 | SCR-155 §3 (signer refill at start, per key) merged with tests passing | Merged: #164 |
| 3 | #155 (SCR-155 §1, `initializeDouble`) merged | Merged: #155 |
| 3a | SCR-157 §1 (chain time for every on-chain deadline) merged with tests passing | Open: #166 |
| 3b | SCR-157 §2–§3 (gas-low signal; vault onboarding from wallet-config) merged with tests passing | Open: #167 |
| 4 | This report updated to the SCR-155 §5 gate | This PR |
| 5 | Senior reviewer | — |
| 6 | Architect check | — |
| 7 | Zaryab's merge | — |

The FORK browser flow is not part of the gate (SCR-155 §5). `local-v1` is frozen.

## Bases
| Item | Value |
|---|---|
| `build-v1` SHA under test | `dcd4bc1` (runs 2–6) |
| `local-v1` SHA under test | `e813aa2` (sync #156 of `build-v1` `dcd4bc1`; run 1) |
| `arc-anvil` version / sha256 | 1.7.1-dev, commit `d497bee`; `arc-anvil` sha256 `fcf7b6a597b3e6544f0246fb4b447966113b6adf3d2446e63d1deaaa018b8166`; `arc-forge` sha256 `cf249c875addb8c9568dba6d47f1805ba13df4da28c36c9e6c946d3126fe5f50` |

## 3.1 Code
| Item | Status |
|---|---|
| All Track A task PRs merged (TA-01…TA-22c, SCR-142…SCR-149 follow-ups, T-126) | Merged into `build-v1` |
| 2026-10-28/29 follow-ups | Merged: #132, #134, #137, #139, #142, #143, #144, #145, #146, #150, #151, #152, #153, #154 (`build-v1`); #136, #138, #140, #147, #148, #149, #156 (`local-v1`) |
| SCR-156 `app.origin` | Merged: #159 (SCR), #161 (`build-v1`), #160 (`local-v1`). Sync #162 left open: `local-v1` is frozen (SCR-155 §5) |
| SCR-155 §1: Gateway doubles' `initializeDouble` | #155, merged |
| SCR-155 §2: BadTtl uses chain time; at most one new attempt | #163 (`a4764f4`), merged. Tests first (`43bb169`: 6 red). `pnpm lint`, `pnpm typecheck` clean; `@czar/server` 449 passed, 24 skipped, 0 failed; run 5 11/11 (new case: server clock 400 s behind chain → one new attempt from chain time, paid once); run 4 13/13 |
| SCR-155 §3: signer gas refill at start; each key on its own | #164 (`e3b45ac`), merged. Tests first (`b204222`: 5 of 10 red; arc-anvil K8 case red). `pnpm lint`, `pnpm typecheck` clean; `@czar/signer` 149 passed, 20 skipped, 0 failed; run 2 20/20 with a new at-start refill case (K3 at 0 reaches target in the first pass). The post-send balance check is removed: CZ-27 §5.5 does not define it and its balance read raced the key's own spending |
| SCR-157 §1: chain time for every on-chain deadline | #166 (`c92136e`), open. Tests first (vault-direct 5 red, job 6 red; run 5 chain-behind case reverted `NotExpired` before the fix). Finalize waits for a block with `timestamp > validBefore` (the vault reverts `NotExpired` at `<=`, `ReservationLogic.sol:149`); reconcile, call retries, and the job escrow refund, `openJob` lead and decision cutoff use chain time; wait loops sleep `payer.reconcileSeconds` and re-read the block. `pnpm lint`, `pnpm typecheck` clean; `@czar/server` 461 passed, 26 skipped, 0 failed; job 28/28; run 4 13/13; run 5 13/13 (2 new cases). The job path is off by default and covered by unit tests only |
| SCR-157 §2–§3: gas-low signal; vault onboarding from wallet-config | #167 (`14a5310`), open. SCR-158 §8: `reads.ts` takes the factory from the manifest, not `process.env` (test `8bd4978`, 2 red; server suite 457 passed, 0 failed on the second full run, the first failed only the known intermittent `receipt-arc`). Tests first (signer, server 12 red, vault-client 6 red, web). Signer: counter `czar_signer_gas_low{key}` (`apps/signer/src/metrics.ts`) plus a text alert on a below-min balance read at the refill's receipt block, a failed attempt, or the relayer below the sum of targets; alert-channel failures log `alert-failed` and the pass continues; `signer.gasRefillIntervalSeconds` (300). Server: `AppWalletConfig` gains `vaultFactory` (manifest) and `webauthnRpId` (host of `app.origin`); startup fails without a factory. Web: no literal factory, env variable or `"localhost"`; skips `createVault` when `vaultOf` is set and `setPasskey` when the key matches; `VaultExists` by selector is success; "Create vault" disabled at a zero MSCA balance. Spec commit `b7bbcc7` edits `openapi.yaml` as SCR-157 §3 orders. Lint, typecheck clean; signer 162, server 455 (0 failed), vault-client 94 (arc-anvil), web unit 55, `e2e:local-server` 4, run 2 20/20, web e2e 27 passed, 1 failed (`passkey.spec`: needs an external chain on `127.0.0.1:8549`, which only a manual fork provides; ended under SCR-155 §5) |
| `routing.gatewayEnabled` / `routing.jobEnabled` default `false` | Confirmed in `packages/config/src/registry.ts` |

## Rulings applied
| SCR | Ruling | PRs |
|---|---|---|
| SCR-154 | G4–G7 accepted as built | #152 |
| SCR-155 §1 | `testInitialize` → `initializeDouble` on both Gateway doubles | #155 |
| SCR-155 §2 | "now" for `validBefore` and the BadTtl trigger is the latest block timestamp; at most one new attempt per step, then `reserve-failed` / `BadTtl` / not retryable; the mislabelled-revert case is accepted | #163 |
| SCR-155 §3 | Signer refill pass at start, then on its interval; one key's fault never skips the others | #164 |
| SCR-155 §4 | Non-Arc dust units accepted for Phase 1; stage 2 item | — |
| SCR-155 §5 | Manual local-chain testing ends; FORK browser flow leaves the gate; runs 1–6 stand; `local-v1` frozen | — |
| SCR-156 | WebAuthn origin from config key `app.origin` | #159, #161, #160 |
| SCR-157 §1 | Every CZ-15 comparison against a chain-enforced deadline uses the latest block timestamp; waits poll `payer.reconcileSeconds` | #166 |
| SCR-157 §2 | Gas-low counter and alert; receipt-block balance; alert failures never stop a pass; `signer.gasRefillIntervalSeconds` | #167 |
| SCR-157 §3 | `AppWalletConfig.vaultFactory` and `webauthnRpId`; idempotent vault creation; no gas, no button | #167 |
| SCR-157 §4 | #164's removal of the after-refill check and #163's bound accepted | — |
| SCR-158 §1 | Intermittent `BadTtl()` in `receipt-arc.test.ts`: not a defect in the SCR-155 §2 rule; no fix now (deferred by Zaryab); M8 preflight on block freshness | — |
| SCR-158 §2–§3 | SCR-157 §1 wording (finalize waits for `timestamp > validBefore`); a resumed call's first send stays ungated | #166 |
| SCR-158 §4 | #166's job deadlines on chain time accepted; CZ-16 decision cutoff and an arc-anvil job suite are preconditions for `routing.jobEnabled` | #166 |
| SCR-158 §5–§6 | Signer metrics collection and a public-origin RP ID are stage 2 | — |
| SCR-158 §7 | Gas-low reason codes | #167 |
| SCR-158 §8 | `reads.ts` takes the vault factory from the deployment manifest, never `process.env` | #167 (`14a5310`) |
| SCR-158 §9 | #167's `openapi.yaml` commit (`b7bbcc7`) adopted as the SCR-157 §3 spec edit | #167 |

## 3.2 Operator steps
| Step | Status |
|---|---|
| Approval of local runs and stack startup | Granted 2026-10-27 |
| Local key creation (T-105 local, K10 `czar-search`) | Key manifest holds K3, K5, K6, K7, K20, relayer and K10 `czar-search`; Zaryab to confirm |

## 3.3 Local runs (CLEAN mode)
Logs are in `.czar-run-logs/` in the main checkout (git-excluded). All 0 skipped. These runs stand as the run evidence (SCR-155 §5).

| # | Run | Command | Status | Log | Base | Date |
|---|---|---|---|---|---|---|
| 1 | T-050a thin slice | `CZAR_T050A_DATABASE_URL=postgres://postgres@127.0.0.1:15433/czar_clean_275c1c5c node --experimental-strip-types apps/server/test/local-thin-slice/process-level.ts` | **PASS**: `failed`/`result-quarantined`, 6 events, `AuthorizationUsed` once, receipt verified | `2026-10-30-e813aa2-run1b.log` | `local-v1` `e813aa2`, CLEAN `275c1c5c` | 2026-10-30 |
| 2 | Signer local-chain suite | `CZAR_LOCAL_CHAIN=1 pnpm --filter @czar/signer exec vitest run test/local-chain.test.ts` | **PASS** 20/20 | `2026-10-29-dcd4bc1-run2.log` | `build-v1` `dcd4bc1` | 2026-10-29 |
| 3 | T-124 Gateway balance projection | `CZAR_LOCAL_CHAIN=1 pnpm --filter @czar/indexer exec vitest run test/pocket-balances-anvil.test.ts` | **PASS** 3/3 | `2026-10-29-dcd4bc1-run3.log` | `build-v1` `dcd4bc1` | 2026-10-29 |
| 4 | Pocket path | `CZAR_LOCAL_CHAIN=1 pnpm --filter @czar/server exec vitest run test/local-pocket/pocket-arc.test.ts` | **PASS** 13/13 | `2026-10-29-dcd4bc1-run4.log` | `build-v1` `dcd4bc1` | 2026-10-29 |
| 5 | Crash/restart matrix | `CZAR_LOCAL_CHAIN=1 pnpm --filter @czar/server exec vitest run test/local-pocket/crash-restart-arc.test.ts` | **PASS** 10/10 | `2026-10-29-dcd4bc1-run5.log` | `build-v1` `dcd4bc1` | 2026-10-29 |
| 6 | Manual-return UI | `pnpm --filter @czar/web e2e:local-server` | **PASS** 4/4 | `2026-10-29-dcd4bc1-run6.log` | `build-v1` `dcd4bc1` | 2026-10-29 |

**Run 1, first attempt (`2026-10-30-e813aa2-run1.log`): timed out.** On a freshly started stack, K3 had no gas until the signer's first refill, which ran only after the five-minute interval. The saved reserve was mined after its TTL and reverted `BadTtl()`. #144's path opened attempt 1, which paid, settled and closed the envelope, but after the runner's timeout. The rerun on the same stack passed. SCR-155 §3 fixes the cause.

## Defects found during the local browser attempt (2026-10-30)
| # | Defect | Fix | Status |
|---|---|---|---|
| BF-1 | Passkey registration rejected with `422 validation`: the server checked `clientDataJSON.origin` against a literal `http://localhost` while the web app runs at `http://localhost:3001` | SCR-156: `app.origin` (#159, #161, #160) | Fixed; verified 2026-10-30 with a Playwright virtual authenticator (`POST /v1/auth/passkey` 201, `POST /v1/auth/session` 201) |
| BF-2 | Start URL `/onboarding` has no page | `/onboarding/passkey` in `ops/local/README.md` (#160) | Fixed |
| BF-3 | "Create vault" sent `createVault` to the literal fallback factory `0xA624047E961D13bF49711e1383e7A3EBD3E25ef4` (`apps/web/app/onboarding/vault/page.tsx:10-12`) because the FORK overlay never set `NEXT_PUBLIC_CZAR_VAULT_FACTORY_ADDRESS`; the UserOps succeeded as calls to an address with no code | SCR-157 §3: factory from `GET /v1/app/wallet-config` | **Fixed in #167** (open) |
| BF-4 | Onboarding lets "Create vault" run while the MSCA has no gas, then shows the predicted vault on Step 3 as if it existed; a repeat click reports `VaultExists` as "The network is busy" | SCR-157 §3: `vaultOf` / passkey pre-checks, `VaultExists` by selector, button disabled at a zero MSCA balance | **Fixed in #167** (open) |

## Known intermittent test
- `apps/server/test/evidence/receipt-arc.test.ts` fails intermittently with `BadTtl()` on the new-reserve path. Cause: on-demand mining on the local test chain. No effect on testnet. No fix now (SCR-158 §1). Seen in 3 of 8 full server-suite runs between #166 and #167; it passes when run alone.

## Before `routing.jobEnabled` is turned on
- The CZ-16 evaluator decision cutoff on chain time (SCR-158 §4).
- An arc-anvil job suite (no arc-anvil test runs `executeJobStep` or the job chain adapter today).

## 3.4 Outside Track A: M8 (D92) — first Arc testnet run
These do not block this report:
- **M8 preflight:** the latest Arc block must be under 5 s old before the first testnet payment (SCR-158 §1).
- **`apps/web/e2e/passkey.spec.ts`:** it needs a real chain, so it runs against testnet.
- **The real-passkey owner flow** (SCR-155 §5): passkey, vault, funding, limits, pairing, objective, approval, payment, receipt, freeze. It moves from the FORK browser flow to the first Arc testnet run.
- **The five-minute first-refill finding:** confirm on testnet that a freshly started signer funds K3/K7/K8 in its first pass (SCR-155 §3) before the first objective.
- T-050b
- T-043 (c)
- G0-05 live Gateway behaviour
- the TA-12 testnet check
- a real passkey UserOp on testnet
- any live Circle or model call
- any real device

## Stage 2
- **Signer metrics collection** (SCR-158 §5): `czar_signer_gas_low{key}` is in-process only; the signer listens only on its Unix socket.
- **RP ID for a public origin** (SCR-158 §6): an SCR so the server derives the RP ID from `app.origin` and changes the `rp_id` CHECK (migration 0007).
- **Non-Arc dust units** (SCR-155 §4): CZ-27 §5.3 compares native wei with `signer.pocketDustAtomic` off Arc. A new SCR must define dust in that chain's native units before any non-Arc network is enabled.

## 3.5 Sign-off
| Step | Status |
|---|---|
| Designated senior reviewer verified the evidence | |
| Architect check against SCR-146 and SCR-155 §5 | |
| Zaryab merged this report (Track A closed) | |
