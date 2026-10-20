# 4. Detect work worth delegating to a specialist agent (ERC-8183 jobs)

- **ID:** I-F-4
- **Raised by:** Zaryab, while reviewing Planning (ERC-8183 jobs)
- **Date:** 2026-10-19
- **For:** the project architect agent, to review and turn into decisions, spec changes and tasks
- **Status:** requested feature. Not yet a decision. **Depends on research I-R-1 and I-R-2**, plus the research items in §6 of this file.
- **Related:** I-F-1 (user-provided project data), I-F-3 (finding specialist agents)

---

## 1. The problem

- Czar only spots needs that fit **x402 service calls**. The drives engine has three detectors, `placeholder`, `repeated-error` and `agent-refusal` (`local-soul-and-drives.md` CZ-06 §5.1). It maps them to 13 small capability tags such as `web-search` and `table-build`.
- Nothing asks the bigger question: **"Is there a piece of Sam's work that a specialist agent would do better or faster?"**, for example:
  - a security review of his webhook code
  - a full competitor analysis report
  - a pricing-page copy rewrite
  - test coverage for a module
- A job is chosen today only by a router rule (`server-planning-and-payment.md` CZ-14 §5 step 1): the supplier is "a specialist agent" (undefined), the step needs acceptance before payment, or it costs $5 or more. That is about **money**, not about **what kind of work it is**.
- **Price alone forces a job, which is wrong.** The router sends any step costing $5 or more (`routing.jobThresholdAtomic` = 5,000,000) to an ERC-8183 job. But price doesn't make something a job:
  - A merchant selling a premium dataset or report through its x402 API for $5, $20 or $50 is still an **x402 purchase**. It's a fixed-price API call that returns content immediately. There's no work to commission, no provider to name, and nothing to submit and evaluate.
  - Forcing that call into a job breaks it. The merchant doesn't take ERC-8183 jobs, so the step finds no provider and ends as "no supplier", even though the merchant could have been paid directly.
  - Cheap work can still be a real job, for example a $2 review that needs acceptance.
  - **What should decide job versus x402 is the nature of the work:** commissioned work by a provider, with a deliverable that must pass acceptance before payment. Not the price.
  - **Ask:** remove price as a job trigger. High prices on the x402 path should be handled by approval rules and caps (for example the user's `userMax` and a per-step limit the user can raise), not by changing the payment path.
- **The point of jobs for Sam isn't saving money.** It's **better quality or saved time** on work that is too big, too specialized or too important for a quick tool call. Czar doesn't recognize that work today.

## 2. What the project says today

| Where | What it says |
|---|---|
| `docs/specs/04-components/local-soul-and-drives.md` CZ-06 | 3 detectors; value filter = minutes saved × hourly value ≥ 5 × price. Phase 2 detectors: `stale-work`, `repeated-search`, `copy-paste-loop`, `deadline`. |
| same, CZ-06 §5.3 | Fixed 13-tag taxonomy, all small service-call capabilities. No "job" kind. |
| `docs/specs/04-components/server-planning-and-payment.md` CZ-14 §5 | Job routing rule based on supplier type, acceptance need or price ≥ $5. |
| `docs/specs/01-system-architecture/system-architecture.md` §19 | Phase 1 jobs: "named provider, Czar evaluator". Open jobs are Phase 3. |
| `docs/specs/02-data-and-protocol/` §4.21 | `JobBrief` exists: built from a plan step's input template and acceptance profile. |

## 3. Features for version 1

### 4.1 A "delegation" detector

- **What:** a new detector that looks for **work units** a specialist agent could own end to end, not single tool calls.
- **Signals from observation** (all from structured events, per the existing ASI06 rules):
  - long or repeated sessions on one project area with many failures or retries (struggle signal)
  - agent refusals or "I can't" on a substantial task (extends `agent-refusal`)
  - work outside the user's usual pattern per the soul's Mission and Taste (for example a founder who never writes security code suddenly working on auth)
  - large planned deliverables mentioned in trusted prompts or files (report, audit, migration, test suite)
  - deadline pressure (a Mission deadline close, with lots of open work)
- **Signals from data the user provides** (depends on I-F-1):
  - projects, goals and deadlines declared in the onboarding interview
  - "things I want help with" answers
  - local files (`CLAUDE.md`, `AGENTS.md`, repo TODOs) describing bigger planned work
- **Output:** a **job candidate**, not a capability list:
  - the work unit in plain words (redacted)
  - the job type (from a job-type list built from I-R-2)
  - the expected deliverable and its format
  - why Czar thinks a specialist would help (quality, time, or both)
  - draft acceptance criteria
- **Done when:** on a synthetic corpus, the detector proposes the expected job candidates and stays quiet on routine work.

### 4.2 Judge by quality and time, not only price

- **What:** a separate value rule for job candidates. Today's filter (minutes saved × hourly value ≥ 5 × price) assumes cheap service calls. For jobs, add:
  - **time saved:** hours of the user's work, at the hourly value
  - **quality gain:** a qualitative reason ("security review by a specialist", "independent second opinion")
  - the user's posture: how much they're willing to pay for quality (Spending posture section)
- **Done when:** a job candidate can be shown even when it's more expensive than x402 calls, with the reason stated in quality and time terms.

### 4.3 The user shapes and confirms the job brief

- **What:** before any job is opened, the user sees the job candidate and can:
  - edit the scope and the deliverable
  - adjust the acceptance criteria
  - add context the observer couldn't see
  - choose a provider from the list (from I-F-3; no ranking required)
- This is where user-provided project data (I-F-1) matters most. A job brief written only from observation will often miss context.
- **Done when:** the approval screen for a job shows the brief, the deliverable, the acceptance criteria and the provider, and the user can edit the first three before approving.

### 4.4 The planner can choose "job" as a plan shape

- **What:** the planner (CZ-13) can return a plan that is **one ERC-8183 job** (or a job plus some x402 steps), not only a chain of x402 calls. The router rule becomes: a step goes to a job **because the detector or the planner chose a job-type unit of work**, with "needs acceptance before payment" kept as an extra trigger. **The price trigger (≥ $5) is removed:** an expensive x402 offer stays on the x402 path, under the user's caps and approval rules.
- **Done when:**
  - The same objective can produce either an x402 plan or a job plan, and the plan says why.
  - A $20 x402 offer is planned and paid as x402 (subject to caps and approval), never routed to a job.

## 4. Not in scope here

- **Ranking job providers.** Zaryab's direction: not a priority. The market is niche, providers are few, and some will be Czar-run. A curated or listed set is enough (I-F-3, I-R-1).
- Open jobs where any agent can claim the work. Phase 3 in the spec today; revisit after I-R-1.

## 5. What the architect needs to change

1. **`docs/specs/04-components/local-soul-and-drives.md`:** the delegation detector (4.1), the job-type list, the job value rule (4.2), and use of soul and user-provided data as signals.
2. **`docs/specs/02-data-and-protocol/`:** a job-candidate shape on `Objective` / `ObjectiveSubmission` (job type, deliverable, draft acceptance criteria), and how it becomes a `JobBrief`.
3. **`docs/specs/04-components/server-planning-and-payment.md`:**
   - Job as a plan shape (4.4).
   - CZ-14 routing rule 1: remove the `unitAmount ≥ routing.jobThresholdAtomic` trigger and the `routing.jobThresholdAtomic` parameter.
   - Make sure high-priced x402 steps are bounded by the per-step cap and approval instead (check `planner.maxStepAtomic` 5 USDC and `planner.defaultMaxUnitAtomic` 1 USDC, which today also block expensive x402 offers).
   - Same change in `system-architecture.md` §8.7.
4. **`docs/specs/04-components/app-and-notifications.md`:** a job approval screen with an editable brief (4.3).
5. **`docs/specs/04-components/server-acceptance-evidence-selection.md`:** acceptance profiles per job type (from I-R-2), since quality is the reason for the job.
6. **`docs/specs/04-components/ai-prompts.md`:** prompts for job candidates and briefs. Structured output only, with injection rules like P-03 and P-05.
7. **Board and `docs/specs/05-build-plan/phase-1-tasks.md`:** tasks under CZ-06, CZ-13, CZ-14, CZ-16 and CZ-22.

## 6. Connected research (I-R)

**Linked research files:**
- **I-R-1** `docs/imperative-research/1_arc-job-provider-index.md`: where providers come from
- **I-R-2** `docs/imperative-research/2_agent-job-market-landscape.md`: which job types are in demand and checkable

**Research specific to this feature:**
- **R4-1. Delegation signals:** which observable signals reliably mean "this work would benefit from a specialist"? Is there published work on detecting struggle or task difficulty from developer or agent activity? Which of these signals do Claude Code hooks expose (ground truth part 2, B1)?
- **R4-2. Job-type list:** build the first job-type list from I-R-2's findings. For each type: the deliverable, how Czar checks it, and the observable signals that point to it.
- **R4-3. Acceptance criteria authoring:** how do existing agent-job systems write acceptance criteria? Can a model draft them safely from a redacted brief, and how good are they?
- **R4-4. Brief privacy:** a job brief must give the provider enough context to do real work. That conflicts with redaction (the same issue as the planning critique "C1: redacted values never restored"). What can be shared with a provider, under what consent, and how?

## 7. Open questions for the architect

- Should the delegation detector run on the user's Mac (like the other detectors) or on the server from the redacted objective?
- Is a job candidate always user-approved in Phase 1, even inside an auto-limit, given the larger amounts and scope?
- How does a job candidate share the user's context with a provider without breaking the "raw data stays on the Mac" rule (R4-4)?
