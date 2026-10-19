# 05 — Build plan

- **Status:** written 2026-10-18; D63–D69 applied 2026-10-19 (Phase 1 approvals in a desktop browser; mobile in `stage-2-backlog.md`). Specs 02–04 are amended (AM-01 to AM-20, D45–D62) and verified. **Gate 0 is next.**
- **Scope:** Czar Phase 1 on Arc testnet only. No mainnet steps, except the unexecuted pre-mainnet checklist in `build-plan.md` §10.

## Files

| File | What it is |
|---|---|
| `build-plan.md` | The main plan: layout and pins, environments, Gate 0 summary, milestones M0–M8 with exit gates, dependency graph, test strategy, security gates, definition of done, pre-mainnet checklist, Phase 2–3 outline, risks, open decisions, gaps and flags |
| `phase-1-tasks.md` | Every Phase 1 task, T-001 to T-104 (87 Phase 1 tasks; T-083 moved to stage 2, D69), with spec references, inputs, outputs, steps, acceptance tests, dependencies, size, parallel group and owner; coverage tables for components and scenario stages |
| `gate-0-checks.md` | The Gate 0 checks as runnable procedures (13 in Gate 0; G0-02 and G0-15 moved to stage 2, D69), with owners, funds caps, pass/fail rules and the spec each one updates on failure |
| `builder-agent-rules.md` | Rules for every coding agent; paste as-is into the code repo's `CLAUDE.md` |
| `spec-change-request-template.md` | How to raise a spec problem (SCR); work on the item stops until it is resolved |
| `stage-2-backlog.md` | Everything deferred to stage 2 and later, in priority order |
| `amendment-verification.md` | Part A record: what was applied where, and the verification commands and results |

## How to use the plan

1. Run Gate 0 (`gate-0-checks.md`). Record each result in `gate-0-results/G0-<nn>.md`. File an SCR for any result that changes a spec choice.
2. Copy `builder-agent-rules.md` into the code repo's `CLAUDE.md`.
3. Work milestone by milestone. Start a task only when its dependencies are done and its milestone's entry criteria hold.
4. A milestone is done only when its exit gate commands pass. A failed gate blocks the next milestone.
5. Tasks that need funds, accounts or a manual browser check wait for Zaryab's written approval.
6. M8 runs the Phase 1 acceptance scenario; Zaryab signs the definition of done.

## Summary

- Gate 0 first: independent review, Circle and Arc assumptions, KMS, and the repo security baseline.
- Guardrails first: contracts and their tests (M1), then the indexer and signer (M2), before any code spends money.
- One real vault-direct payment on testnet ends M3; the pocket and job paths and the anchored proof end M4.
- The local side (M5) and the desktop-browser app (M6, D69) build on the working payment server; Selection Layer lite, earned autonomy and the ROI ledger follow (M7).
- M8 runs the full acceptance scenario in CI and once on live testnet. It is the Phase 1 release gate.

## Change log

| Date | ID | Change |
|---|---|---|
| 2026-10-19 | D69 | Task and Gate 0 counts updated; iPhone steps removed; backlog file listed. |
| 2026-10-19 | D69 | Summary says the M6 app runs in a desktop browser. |
