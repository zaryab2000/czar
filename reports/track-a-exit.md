# Track A exit report (SCR-146 §3)

**Status:** OPEN. Code is merged and runs 1–6 PASS on merged bases. The FORK browser flow is NOT RUN. Track B stays held until Zaryab merges the final version of this report.

## Bases
| Item | Value |
|---|---|
| `build-v1` SHA under test | `dcd4bc1` (runs 2–6) |
| `local-v1` SHA under test | `e813aa2` (sync #156 of `build-v1` `dcd4bc1`; run 1, FORK) |
| `arc-anvil` version / sha256 | 1.7.1-dev, commit `d497bee`; `arc-anvil` sha256 `fcf7b6a597b3e6544f0246fb4b447966113b6adf3d2446e63d1deaaa018b8166`; `arc-forge` sha256 `cf249c875addb8c9568dba6d47f1805ba13df4da28c36c9e6c946d3126fe5f50` |
| Fork pin (FORK mode only) | `forkBlock` 69431743, `indexerStartBlock` 69431752 (pin from 2026-10-28, reused) |

## 3.1 Code
| Item | Status |
|---|---|
| All Track A task PRs merged (TA-01…TA-22c, SCR-142…SCR-149 follow-ups, T-126) | Merged into `build-v1` |
| 2026-10-28/29 follow-ups | Merged: #132, #134, #137, #139, #142, #143, #144, #145, #146, #150, #151, #152, #153, #154 (`build-v1`); #136, #138, #140, #147, #148, #149, #156 (`local-v1`) |
| `routing.gatewayEnabled` / `routing.jobEnabled` default `false` | Confirmed in `packages/config/src/registry.ts` |
| Open, not blocking | #155 (draft): gateway double `testInitialize` rename, waits for SCR-155 |

## 3.2 Operator steps
| Step | Status |
|---|---|
| Approval of local runs and stack startup | Granted 2026-10-27 |
| Local key creation (T-105 local, K10 `czar-search`) | Key manifest holds K3, K5, K6, K7, K20, relayer and K10 `czar-search`; Zaryab to confirm |

## 3.3 Local runs (CLEAN mode)
Logs are in `.czar-run-logs/` in the main checkout (git-excluded). All 0 skipped.

| # | Run | Command | Status | Log | Base | Date |
|---|---|---|---|---|---|---|
| 1 | T-050a thin slice | `CZAR_T050A_DATABASE_URL=postgres://postgres@127.0.0.1:15433/czar_clean_275c1c5c node --experimental-strip-types apps/server/test/local-thin-slice/process-level.ts` | **PASS**: `failed`/`result-quarantined`, 6 events, `AuthorizationUsed` once, receipt verified | `2026-10-30-e813aa2-run1b.log` | `local-v1` `e813aa2`, CLEAN `275c1c5c` | 2026-10-30 |
| 2 | Signer local-chain suite | `CZAR_LOCAL_CHAIN=1 pnpm --filter @czar/signer exec vitest run test/local-chain.test.ts` | **PASS** 20/20 | `2026-10-29-dcd4bc1-run2.log` | `build-v1` `dcd4bc1` | 2026-10-29 |
| 3 | T-124 Gateway balance projection | `CZAR_LOCAL_CHAIN=1 pnpm --filter @czar/indexer exec vitest run test/pocket-balances-anvil.test.ts` | **PASS** 3/3 | `2026-10-29-dcd4bc1-run3.log` | `build-v1` `dcd4bc1` | 2026-10-29 |
| 4 | Pocket path | `CZAR_LOCAL_CHAIN=1 pnpm --filter @czar/server exec vitest run test/local-pocket/pocket-arc.test.ts` | **PASS** 13/13 | `2026-10-29-dcd4bc1-run4.log` | `build-v1` `dcd4bc1` | 2026-10-29 |
| 5 | Crash/restart matrix | `CZAR_LOCAL_CHAIN=1 pnpm --filter @czar/server exec vitest run test/local-pocket/crash-restart-arc.test.ts` | **PASS** 10/10 | `2026-10-29-dcd4bc1-run5.log` | `build-v1` `dcd4bc1` | 2026-10-29 |
| 6 | Manual-return UI | `pnpm --filter @czar/web e2e:local-server` | **PASS** 4/4 | `2026-10-29-dcd4bc1-run6.log` | `build-v1` `dcd4bc1` | 2026-10-29 |

**Run 1, first attempt (`2026-10-30-e813aa2-run1.log`): timed out.** On a freshly started stack, K3 had no gas until the signer's first refill, which runs only after the five-minute interval (`startGasRefillJob` uses `setInterval` with no run at start). The saved reserve was mined after its TTL and reverted `BadTtl()`. #144's path then opened attempt 1, which paid, settled and closed the envelope, but after the runner's timeout. The rerun on the same stack passed.

## Browser flow (FORK mode)
| Item | Status |
|---|---|
| `docs-internal/demo_tests/track-a-exit-flow.md` Parts A–G, P1–P10 → `reports/local-flow-<date>.md` | NOT RUN. FORK session `ad7d0d66` started on `e813aa2`; `ops/local/health.sh` all OK; service keys funded on the fork |

## Defects and open items (for the architect)
1. **First gas refill waits five minutes** (`apps/signer/src/gas-refill.ts`, `startGasRefillJob`). A fresh deployment's K3/K7/K8 have no gas until then. Needs a ruling on running the refill at start.
2. **Refill post-check races spending** (`gas-refill.ts:66-68`). If K3 spends gas between the refill receipt and the balance read, the check alerts "outside its target and max bounds" and `break` skips the remaining keys. Seen on 2026-10-30 CLEAN.
3. **#144 retry bound:** if chain time runs ahead of the server clock by more than about 270 s, every fresh reserve meets the BadTtl condition and CZ-15 retries without limit ("no counter" in SCR-153 §2).
4. **#144 classification:** other vault reverts that also meet the TTL condition are treated as BadTtl; an expired envelope ends `reserve-failed` with message `BadTtl`.
5. **SCR-155 / #155:** forge fuzzes `MockGatewayMinter.testInitialize(address)`; one known forge failure on `build-v1` until the rename is approved.
6. **Non-Arc dust units:** CZ-27 §5.3 compares native wei with `signer.pocketDustAtomic` off Arc. No Phase 1 effect.

## 3.4 Outside Track A: M8 (D92)
These do not block this report:
- T-050b
- T-043 (c)
- G0-05 live Gateway behaviour
- the TA-12 testnet check
- a real passkey UserOp on testnet
- any live Circle or model call
- any real device

## 3.5 Sign-off
| Step | Status |
|---|---|
| Designated senior reviewer verified the evidence | — |
| Architect check against SCR-146 and the flow document | — |
| Zaryab merged this report (Track A closed) | — |
