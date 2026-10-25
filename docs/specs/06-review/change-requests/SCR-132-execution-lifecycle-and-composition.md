# SCR-132: Execution lifecycle — trigger, `EnvelopeOpened` match, workers, recovery and completion

| Field | Value |
|---|---|
| ID | SCR-132 |
| Filed by | chief architect, 2026-10-25 (Track A replan, baseline `ce17dad`) |
| Spec and section | `docs/specs/04-components/server/server-planning-and-payment.md` CZ-12 §4 (`:26`), §5 (`:32-58`), §6 (`:82-90`), storage (`:66`); CZ-15 §2 (`:267`), runtime (`:271`), crash table (`:348-358`); `docs/specs/04-components/server/server-acceptance-evidence-selection.md` CZ-19 §5.4 (`:101-115`); SCR-126 §2 (server composition root, Accepted); `docs/specs/05-build-plan/phase-1-tasks.md` T-050, T-071; `@czar/config` |
| Status | Accepted (Zaryab, 2026-10-25); Applied (2026-10-25) |

## Problem
- SCR-126 §2 (Accepted) already makes Lane 2 own the server composition root `apps/server/src/main.ts` and fixes its start order:
  - pool and migrations
  - acceptance checker, boundary
  - signer client, receipt builder
  - vault-direct payer, HTTP app
- But the started entry still does not run it:
  - The started entry is `start:local` → `apps/server/src/local-main.ts:29-38` → `createLocalApp` → `createApp`. It never calls `createServerMain`, which has test callers only.
  - The start order has no planner loop, no `EnvelopeOpened` match, no step dispatcher and no completion. No code moves an objective `opening → executing`, emits `plan.approved`, writes `results` or emits `objective.delivered`/`objective.failed` (verification report A §6.1).
- The specs describe two triggers and never say how they interact:
  - server-driven execution after `EnvelopeOpened` (CZ-12 `:57`; acceptance Stage 4)
  - per-step `createPayRequest` (CZ-12 §6 `:90`; MCP `pay`)
- CZ-12 says "CZ-19 matches EnvelopeOpened by planHash" (`:82`), but CZ-19's "exact list" of queries has no `planHash` lookup (`:101-115`). The existing indexer `/envelopes` route requires `vault` (`apps/indexer/src/api/router.ts:34-45`).
- No config key exists for the planner loop, the dispatch loop, the opening match poll, or reclaiming a stuck `planning` claim.
- After a match timeout, a plan whose approval UserOp was submitted stays `approved` and can never be re-approved: the pending list and both approval routes require `offered` (`apps/server/src/app/approvals.ts:82-85,238,343`). A late `EnvelopeOpened` is never matched, which orphans an open envelope with committed funds.
- `ServerMainOptions.modelClient` and `BoundaryDependencies.modelClient` are required (`apps/server/src/main.ts:65`, `apps/server/src/boundary/index.ts:49`), although G0-16/K18 forbids a model provider today.
- Code emits `approval.intent-issued` and `approval.submitted` (`approvals.ts:249,356`), which the CZ-12 §4 event list does not include.

## Evidence
- The verification reports cited below are architect working papers outside the repository; every claim also carries a repository file:line.
- Verification report A §3, §4, §6, §7; fact-check rows 6–15 and G1, G4, G11.

## Proposed change

### 1. One trigger per plan
- A plan created from `submitObjective` is **server-driven**: CZ-15 executes it after its `EnvelopeOpened` is matched.
- A plan created from `createQuote` (MCP) is **pay-request-driven**: only `createPayRequest` executes its steps. The trigger is fixed at plan creation.
- `createPayRequest`, `createQuote` and MCP `pay` (T-071, T-072) are **not built under this SCR**. Their shared-budget rules are specified with T-071 in the Track B replan, because I-F-6 changes `StepResult`.

### 2. `EnvelopeOpened` match
- **CZ-19 §5.4 query** `envelopeByPlanHash(planHash)`, consumer CZ-12.
  - Route: `GET /envelopes/by-plan-hash/{planHash}`, a distinct path so the existing `vault`-required `/envelopes` route is unchanged.
  - Returns the `envelopeByRef` response shape (SCR-119), or 404.
  - The mirror already stores `planHash` (written at `apps/indexer/src/mirrors.ts:101`; read by the signer at `apps/signer/src/postgres-projection.ts:280`).
- **CZ-12 opening watcher**, every `api.openingPollMs`:
  - **Scope:** every objective in `opening` (owner-approved or, once that path is built, agent-opened), and every objective in `awaiting-approval` whose plan is `approved` (owner submitted), until the plan's `expiresAt`.
  - **On a match:** an `Open` envelope of the user's vault. In one transaction it:
    - sets `objectives.envelope_ref` (an existing column, `migrations/0001-cz12.sql:42`; CZ-12 storage `:66`)
    - moves the objective to `executing`
    - emits `plan.approved` with `{planId, envelopeRef}`
  - **No match within `api.approvalWaitMinutes`:** the objective returns to `awaiting-approval`, the existing CZ-12 edge. The plan **stays `approved`**, and the watcher keeps matching it, so a late UserOp is still picked up.
    - The app lists it with CZ-22 §12 wording "Approval sent. Waiting for the network to confirm it." and does **not** offer re-approval, which could open a second envelope for the same plan.
    - This is a Lane 5 change to the approvals list: brief TA-16.
  - **At the plan's `expiresAt` with no match:** the plan becomes `expired` and the objective `expired`. Both are existing states (`migrations/0001-cz12.sql:39,56`). The person can submit the objective again.
- **Plan `state = approved`** keeps its meaning, "owner submitted the approval UserOp". The signer maps it to `owner-approved`, which no policy reads today (`postgres-projection.ts:374`; `policy.ts:266` reads `auto-approvable`). Execution is gated on the objective being `executing`, never on `plans.state`.

### 3. Workers and recovery

| Key | Default | Reason |
|---|---|---|
| `planner.pollMs` | 1000 | claim the next `objective.received` (SKIP LOCKED); keeps planning latency well under P-03's 20 s budget |
| `planner.claimTimeoutSeconds` | 300 | a `planning` objective older than this with no stored plan was claimed by a crashed worker; above the P-03 timeout plus `planner.probeTopK` probes |
| `payer.dispatchPollMs` | 1000 | how often CZ-15 looks for `executing` envelopes without a live lease |
| `api.openingPollMs` | 5000 | `EnvelopeOpened` reaches the indexer within a few blocks; faster polling only loads the indexer |

- **Planner loop:** runs `processNextReceived` (`apps/server/src/planner/service.ts:263-299`).
  - **New CZ-12 §5 transition `planning → received` (reclaim):** a `planning` objective older than `planner.claimTimeoutSeconds` with no stored plan moves back to `received`.
  - No new outbox row is written. The original `objective.received` row is still undelivered and is claimed again by `processNextReceived`.
  - `apps/server/src/objectives/state.ts` gains this edge.
- **Planner ports with no other producer yet** (added during application, 2026-10-25):
  - `allowance` follows the contract's own rule (03 `czar-vault.md` `openEnvelope` row and §5.6): `remaining = sat(autoLimit, usedInPeriod)` when `periodId == now / PERIOD_LENGTH`, else `autoLimit`, read through `@czar/vault-client`. Any read error gives `"0"` (approval required).
  - `agentHosts` answers `false` until `ingestReport` (T-070) records agent hosts.
  - `pocketKeys` is the signer's `createPocketKey`.
- **Dispatcher (CZ-15):**
  - Claims one `executing` envelope through `executor_leases` (TTL `payer.leaseSeconds`).
  - Runs the steps in `dependsOn` order through the existing step executors. One executor per envelope (CZ-15 `:271`).
  - Reads `frozen()`/`guardianPaused()` before each step; no step starts while either is set.
- **Restart recovery** is the existing lease rule. An expired lease is claimed again, and each step resumes from its last `step_executions` phase (`vault-direct.ts:206-211,326,834`). No separate startup scan.

### 4. Completion
- When every step is terminal, CZ-15:
  1. Closes the envelope with K3 `closeEnvelope(envelopeId)` once every reservation is `Final`, every pocket of the envelope is `Closed` and every job is terminal (the 03 `closeEnvelope` preconditions; otherwise `EnvelopeBusy`). This is CZ-15 §2 (`:267`) "close envelopes"; it is on the K3 allowlist (`apps/signer/src/abi.ts:96`) and the agent may call it (`contracts/src/vault/logic/EnvelopeLogic.sol:92`).
  2. Stores one `results` row in the 02 Result shape and sets `objectives.result_id`.
  3. Moves the objective to:
     - `delivered` when at least one step's content was delivered
     - `failed` when no step delivered content (including when every step was quarantined)
  4. Emits `objective.delivered` or `objective.failed`.
- **Quarantine (D76):** a quarantined step delivers nothing.
  - The `results.rendered_body` (NOT NULL) holds only the CZ-22 quarantine notice for that step, never merchant content.
  - The `failed` payload's reason is the existing stable code `result-quarantined` (`openapi.yaml:420`). The ledger row shows `quarantined` (AM-05).
- **Model gate:** until G0-16/K18 is approved the server composes **no model provider**.
  - `ServerMainOptions.modelClient` and `BoundaryDependencies.modelClient` become optional.
  - When absent, the boundary takes the ai-prompts P-01 "model unavailable" branch (`ai-prompts.md:49`): the step is quarantined and acceptance records `inconclusive` with `limits += ["screen-unavailable"]`.
  - P-03 takes its rule-based fallback (`:150`, as amended by SCR-131).
  - No stand-in classifier is allowed. The money path (reserve → settle → receipt) completes normally.
- `objective.no-supplier` is **not** added here; Track B decides it.

### 5. CZ-12 §4 event list
- Add `approval.intent-issued` and `approval.submitted`.

### 6. Composition (amends SCR-126 §2)
- **Start order:**
  1. pool, then migrations
  2. the acceptance checker with production ports (SCR-131)
  3. the boundary (model optional, §4)
  4. the signer client
  5. the receipt builder
  6. the CZ-18 interim producer (SCR-131)
  7. the payer runtime (vault-direct and existing executors; halt monitor when SCR-127 lands)
  8. the planner loop
  9. the opening watcher
  10. the dispatcher
  11. the HTTP app (`createApp` with app read options)
- **The started entry is the composition root.** `local-main.ts` calls `createServerMain`, and SCR-126 §2's started-root test applies to it.
- **Configuration sources:**
  - `@czar/config` (via the existing `CZAR_LOCAL_CONFIG` pointer)
  - the deployment manifest (factory, Gateway minter, domain)
  - the existing launcher env pointers set by `ops/local` (`env/local.toml:1`, "Runtime ports and RPC URLs are set by ops/local"): `CZAR_DATABASE_URL`, `CZAR_ARC_RPC_URL`, `CZAR_SERVER_PORT`, `CZAR_LOCAL_OBJECT_STORE_PATH` (`local-main.ts:20,26,36,64`) and `CZAR_INDEXER_URL`
  - No other raw env read. `ops/local/process-compose.yaml` sets `CZAR_INDEXER_URL` for the server.

### 7. Task plan
- **T-050 splits:**
  - **T-050a "Local thin slice"**: T-050's assertions on local `arc-anvil` with the SCR-130 stand-ins (D92); deps T-122, T-123, T-043.
  - **T-050b "Testnet thin slice"**: the current T-050 text, in M8 after T-121.
- **New T-122 "Execution runtime"** (Lane 2) carries §2–§6.
- **T-071** is re-sequenced into Track B.

## Affected tasks
- T-041, T-045, T-048, T-049, T-050 (split), T-071 (Track B), T-084 ("objective moves to executing" now produced by T-122), SCR-126 §2.

## Decision
- Accepted by Zaryab on 2026-10-25 with the Track A replan (context and briefs in `docs/builder-prompts/track-a/`).

## Applied
- CZ-12 §4 events, §5 state diagram and table, opening watcher and one-trigger rule
- CZ-15 §3 loops, completion, model gate, composition (amends SCR-126 §2); CZ-13 planner ports `allowance`, `agentHosts`, `pocketKeys`
- CZ-19 §5.4 `envelopeByPlanHash`
- CZ-22 "Approval sent" wording
- `@czar/config`: `planner.pollMs`, `planner.claimTimeoutSeconds`, `payer.dispatchPollMs`, `api.openingPollMs`
- Tasks T-050a, T-050b, T-122, T-071 note
