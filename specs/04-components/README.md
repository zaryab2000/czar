# 04 — Component specifications

- **Status:** draft written 2026-10-18 on top of specs 01–03. Full specs for every Phase 1 component; outlines for Phase 2 and 3 components. Amendments AM-01 to AM-20 applied to specs 02/03 and decisions D45–D62 reflected (see `amendments-and-open-decisions.md`).
- **Rule:** no data shape, route, tool or contract call is defined here. Everything is referenced by its exact name in specs 02 and 03; anything new goes through a spec change request.

## Reading order

1. `cross-cutting.md` (monorepo, config registry, logging, error codes, models, pins, mainnet differences)
2. `server-planning-and-payment.md` (the critical path: API, planner, router, paying agent, injection boundary)
3. `ai-prompts.md` (P-01 to P-06)
4. `server-acceptance-evidence-selection.md`
5. `local-observers-and-daemon.md`, `local-soul-and-drives.md`, `local-agent-surfaces.md`
6. `app-and-notifications.md`, `server-supply-side.md`, `server-autonomy-roi-keys.md`
7. `phase-1-acceptance-scenario.md`
8. `amendments-and-open-decisions.md`

## Component index

| CZ | Name | File | Phase | Runs on |
|---|---|---|---|---|
| CZ-01 | Observers (Claude Code; Codex, Cursor, Chrome outlines) | `local-observers-and-daemon.md` | 1 / 2 | user machine (plugin) |
| CZ-02 | Local daemon `czard` | `local-observers-and-daemon.md` | 1 | user machine |
| CZ-03 | Shared memory | `local-observers-and-daemon.md` | 1 | user machine |
| CZ-04 | Soul compiler | `local-soul-and-drives.md` | 1 | user machine (+ hosted model via proxy, D31) |
| CZ-05 | Soul store and viewer | `local-soul-and-drives.md` | 1 (desktop, D34) | user machine |
| CZ-06 | Drives engine | `local-soul-and-drives.md` | 1 | user machine |
| CZ-07 | Objective publisher | `local-soul-and-drives.md` | 1 | user machine |
| CZ-08 | Shadow mode | `local-soul-and-drives.md` | 1 | user machine |
| CZ-09 | Czar MCP server | `local-agent-surfaces.md` | 1 | user machine (stdio child) |
| CZ-10 | Soul injection writer | `local-agent-surfaces.md` | 2 | user machine |
| CZ-11 | Write-back adapter | `local-agent-surfaces.md` | 1 | user machine |
| CZ-12 | Server API and objective store | `server-planning-and-payment.md` | 1 | Czar server |
| CZ-13 | Planner | `server-planning-and-payment.md` | 1 | Czar server |
| CZ-14 | Payment router | `server-planning-and-payment.md` | 1 | Czar server |
| CZ-15 | Paying agent | `server-planning-and-payment.md` | 1 | Czar server |
| CZ-16 | Acceptance checker and ERC-8183 evaluator | `server-acceptance-evidence-selection.md` | 1 | Czar server |
| CZ-17 | Evidence producer and publisher | `server-acceptance-evidence-selection.md` | 1 | Czar server |
| CZ-18 | Selection Layer services | `server-acceptance-evidence-selection.md` | 1 lite / 2 / 3 | Czar server |
| CZ-19 | Indexer | `server-acceptance-evidence-selection.md` | 1 | Czar server |
| CZ-20 | Czar x402 merchants | `server-supply-side.md` | 1 | Czar server |
| CZ-21 | Claim server and relayer | `server-supply-side.md` | 2 | Czar server |
| CZ-22 | Czar web app | `app-and-notifications.md` | 1 | desktop browser (Safari or Chrome on macOS, D69) |
| CZ-23 | Notifications (web push) | `app-and-notifications.md` | stage 2 (D69; outline only) | Czar server → phone |
| CZ-24 | Earned autonomy | `server-autonomy-roi-keys.md` | 1 | Czar server |
| CZ-25 | ROI ledger | `server-autonomy-roi-keys.md` | 1 | Czar server |
| CZ-26 | Redaction library | `local-observers-and-daemon.md` | 1 | user machine |
| CZ-27 | Key management | `server-autonomy-roi-keys.md` | 1 | Czar server (KMS + signer service) |

## Summary

- The injection boundary is explicit: P-01 screens every untrusted text, CZ-16 runs code checks, P-02 turns bodies into `StepResult`, and the planner and paying agent only ever see `StepResult` objects. The vault remains the money boundary.
- Every money step is written to an append-only execution log before and after its external call, so the paying agent recovers from a crash at any point on all three payment paths.
- Routing applies the D37/D38 formula from spec 03 with live gas and the measured gas table; it is policy only, the vault enforces caps.
- The soul compiler sends only redacted excerpts to a hosted model through a proxy that stores nothing (D31); raw data stays local. The three Phase 1 detectors, their thresholds and the shadow report are fully defined.
- The Phase 1 acceptance scenario runs all three payment paths, an injection test, a freeze drill, a guardian drill and a third-party verification of the anchored proof, with a pass/fail check per step.

## Change log

| Date | ID | Change |
|---|---|---|
| 2026-10-18 | AM-01–AM-20, D45–D62 | status updated: amendments applied, decisions reflected |
| 2026-10-19 | D69 | CZ-22 runs in a desktop browser in Phase 1; CZ-23 moved to stage 2. |
