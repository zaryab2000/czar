# SCR-136: Track A lane ownership, Phase 1 task-plan changes, and the development-phase acceptance boundary

| Field | Value |
|---|---|
| ID | SCR-136 |
| Filed by | chief architect, 2026-10-25 (Track A replan, baseline `ce17dad`) |
| Spec and section | `docs/specs/05-build-plan/phase-1-tasks.md` (T-043, T-045, T-050, T-053, T-071, T-085, T-090, T-091, T-105, T-115, new T-122 to T-125); `docs/builder-coordination.md` lane table (`:30-58`); `docs/product/decisions-log.md` (D92 entry); SCR-126 §2 (Accepted) |
| Status | Accepted (Zaryab, 2026-10-25); Applied (2026-10-25) |

## Problem
- Code the payment path depends on has no lane owner:
  - **Server folders:** `apps/server/src/local-main.ts`, `local-app.ts`, `app.ts`, `planner/`, `objectives/`, `router/`, `db/`, `models/`, `http/`, `devices/`, `object-store.ts`, `index.ts`, `apps/server/migrations/`.
  - **Other apps and folders:** `apps/indexer/`, `apps/merchants/`, `ops/`.
  - **Tasks:** T-043, T-045, T-071, T-090, T-091, T-115, T-070, T-095.
  - Sources: `docs/builder-coordination.md:30-58`; verification reports A §2, B §5, C §6, DE §E9.
  - `apps/server/src/main.ts` is already Lane 2's under SCR-126 §2 (Accepted), but the lane table never recorded it.
- The Lane 2 reports route startup wiring to "Lane 5" (`reports/m3-thin-slice.md:43-47`). Lane 5's folders do not include it.
- Lane 2 owns `apps/server/src/receipts/`, which does not exist; receipts live in `apps/server/src/evidence/receipts.ts`.
- T-050 is a funded testnet run (`phase-1-tasks.md:779-794`), so the local thin slice D92 requires has no task.
- T-043 depends on G0-04 (`phase-1-tasks.md:665,668`), whose record does not exist (`gate-0-results/` holds `G0-08.md`, `G0-09.md`).
- T-105's acceptance requires K10-lab, payee-swap, K21a and K21b entries (`phase-1-tasks.md:491`), which belong to later tasks (T-106, H7). It also names only `deployments/arc-testnet-keys.json`, so there is no specified local key file for the local vault roles (`ops/local/deploy.sh:47-54` binds every role to `eth_accounts[0]`).
- D92 is cited across the docs but has no entry in `docs/product/decisions-log.md` (headings stop at D91, `:554`). Its text lives only in `phase-1-tasks.md:13`.
- Zaryab's instruction of 2026-10-25 defers local Arc Anvil acceptance campaigns, crash/restart matrices, live checks, real devices and testnet until the implementation plan is settled. `CLAUDE.md` says a task is done only when every listed acceptance test passes. Both must hold at once.

## Proposed change

### 1. Lane ownership (`docs/builder-coordination.md`)

| Lane | Owns today | Adds | Removes |
|---|---|---|---|
| 1 Contracts and chain | `contracts/`, `packages/vault-client/`, `apps/signer/`, `deployments/`, `env/` | `apps/indexer/`, `ops/` | — |
| 2 Server payments and runtime | `src/boundary/`, `src/payer/`, `src/receipts/` | `apps/server/src/main.ts` (recording SCR-126 §2), `local-main.ts`, `local-app.ts`, `index.ts`, `planner/`, `objectives/`, `router/`, `db/`, `models/`, `object-store.ts`, `evidence/receipts.ts` (file only) | `src/receipts/` (does not exist) |
| 3 Acceptance, evidence, selection, supply | `src/acceptance/`, `src/evidence/` (except `receipts.ts`) | `apps/server/src/selection/`, `apps/merchants/` | — |
| 4 Daemon and plugins | unchanged | — | — |
| 5 Web app | `apps/web/`, `src/app/` | `apps/server/src/app.ts` (route registration), `apps/server/src/http/`, `apps/server/src/devices/` | — |

- **`apps/server/migrations/`:** each lane adds migrations for its own tables. The existing numbering rule applies (fetch `build-v1`, renumber before PR).
- **`app.ts`:** non-app routes are registered by the lane owning the handler, in a separate small commit Lane 5 reviews.
- **Config keys:** the keys in accepted SCRs are added to `@czar/config` by the architect, in the same spec-application branch that applies those SCRs, before any builder starts. Builders never add them.

### 2. Task plan (`docs/specs/05-build-plan/phase-1-tasks.md`)
- **Owners:**
  - T-045 → Lane 2
  - T-090, T-091, T-115 → Lane 3
  - T-043 → Lane 3
  - T-071, T-072, T-070, T-095 → decided in the Track B replan
- **T-043 reopened (Lane 3):**
  - Outputs add "composed merchant entry point: signer `keyAddress` (SCR-129), seller-proof adapter, Postgres payment-id store, config from SCR-130".
  - Acceptance (a)–(b) run locally against the D92 stand-in.
  - Acceptance (c) (testnet `curl` returns `402`) moves to T-050b.
  - The G0-04 dependency moves to T-050b. The local part does not need it.
- **T-050 split (SCR-132 §7):**
  - **T-050a "Local thin slice"** (Lane 2; deps T-122, T-123, T-043).
  - **T-050b "Testnet thin slice"** (M8, after T-121, deps G0-04): the current T-050 text.
- **New tasks:**
  - **T-122 "Execution runtime"** (Lane 2): SCR-132 §2–§6.
  - **T-123 "Interim Czar-registered selection"** (Lane 3): SCR-131.
  - **T-124 "Gateway balance projection"** (Lane 1): SCR-127 §1–§3 and §6 with the signer projection fields.
  - **T-125 "Owner manual return"** (Lanes 1, 2, 5; deps T-124, T-053): SCR-133.
- **T-053 gains (Lane 2):** SCR-127 §3–§5 consumers and SCR-133's persistence and reconciliation.
- **T-085 split:**
  - UI and intent: Lane 5, implemented.
  - "Server listener that calls `lowerAutoLimit(categoryId, 0)` per used category after `Frozen`": Lane 2, in the payer runtime under caller `cz-15`.
  - Why `cz-15`: CZ-15 `:413` names it "a follow-up agent step"; K3 belongs to CZ-15 (CZ-27 `:371`, `apps/signer/src/runtime-adapters.ts:9`); `lowerAutoLimit` is on the K3 allowlist (`apps/signer/src/abi.ts:97`). CZ-24 §4 still describes the lowering as its output. Running it as a CZ-15 follow-up step is that output, and no key-map change is needed.
- **T-105 amended:**
  - The K10-lab, payee-swap, K21a and K21b entries are required when T-106 and H7 start, not by T-105 itself.
  - `create-keys` gains a local mode that writes `deployments/local-keys.json` in the same `{K3:{address, ref}, …}` shape `contracts/script/Deploy.s.sol:90-95` reads.
  - `ops/local/deploy.sh` reads vault roles from that file instead of `eth_accounts[0]`.
  - Running key creation stays an operator step (Zaryab, G0-13).

### 3. Development-phase acceptance boundary (records Zaryab's instruction of 2026-10-25)
- **Required before a PR is reviewed:**
  - focused unit and integration tests for the new code, written first on money paths
  - `pnpm lint`
  - the package's typecheck
  - the package's existing tests
- **Deferred, and listed in each PR report as "NOT RUN / DEFERRED":**
  - acceptance tests that need local `arc-anvil`
  - crash/restart matrices
  - live Circle or model calls
  - real devices, testnet
- **A task is not marked done while any of its listed acceptance tests is deferred.** A merged PR records merged code, not task completion (`CLAUDE.md`). Track A changes no contract code; any later contract change still runs its tests on pinned `arc-anvil`.

### 4. Decisions log
- Add the D92 entry with the exact text of `phase-1-tasks.md:13` and date 2026-10-21. This records a decision already made.
- Add a new decision entry for §3 above. It takes the next free D-number at application time; the I-F-6 Q1–Q5 decision approved on 2026-10-23 is filed first.

## Affected tasks
- As listed.

## Decision
- Accepted by Zaryab on 2026-10-25 with the Track A replan (context and briefs in `docs/builder-prompts/track-a/`).

## Applied
- `docs/builder-coordination.md` lane table and shared-package rules
- `phase-1-tasks.md` owners, T-043, T-050 split, T-085 split, T-105, new T-122 to T-125
- `docs/product/decisions-log.md` D92, D93 (the I-F-6 decision of 2026-10-23, filed first) and D94 (the acceptance boundary)
- Track A briefs in `docs/builder-prompts/track-a/`
