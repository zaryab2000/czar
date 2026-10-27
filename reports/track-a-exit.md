# Track A exit report (SCR-146 §3)

**Status:** OPEN. Nothing below is a PASS until it has been run and recorded with evidence. Track B stays held until Zaryab merges the final version of this report.

## Bases
| Item | Value |
|---|---|
| `build-v1` SHA under test | _pending_ |
| `local-v1` SHA under test | _pending_ |
| `arc-anvil` version / sha256 | _pending_ |
| Fork pin (FORK mode only) | _pending: recorded at first bring-up_ |

## 3.1 Code
| Item | Status |
|---|---|
| All Track A task PRs merged (TA-01…TA-22c, SCR-142…SCR-149 follow-ups, T-126) | Merged into `build-v1` (see PR list in `docs-internal/status-update/`) |
| `routing.gatewayEnabled` / `routing.jobEnabled` default `false` | Confirmed in `packages/config/src/registry.ts` |

## 3.2 Operator steps
| Step | Status |
|---|---|
| Approval of local runs and stack startup | Granted 2026-10-27 |
| Local key creation (T-105 local, K10 `czar-search`) | NOT DONE |

## 3.3 Local runs (CLEAN mode)
Record each run as: one-line command · PASS/FAIL · log link · base SHA · arc-anvil version/sha256 · mode · date.

| # | Run | Owner | Status |
|---|---|---|---|
| 1 | T-050a thin slice (`reports/m3-local-thin-slice.md`) | Lane 3 (Lane 2 review) | NOT RUN |
| 2 | Signer local-chain suite (TA-01 + SCR-145/146) | Lane 1 | NOT RUN |
| 3 | T-124 Gateway balance projection on a local chain | Lane 1 | NOT RUN |
| 4 | Pocket path: halt drain, late funds, slow-path restarts, manual return, overdue write-off | Lane 2 | NOT RUN |
| 5 | Crash/restart matrix: no double reserve, payment or mint | Lane 2 | NOT RUN |
| 6 | Manual-return UI against the local server | Lane 5 | NOT RUN |

## Browser flow (FORK mode)
| Item | Status |
|---|---|
| `docs-internal/demo_tests/track-a-exit-flow.md` Parts A–G, P1–P10 → `reports/local-flow-<date>.md` | NOT RUN |

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
