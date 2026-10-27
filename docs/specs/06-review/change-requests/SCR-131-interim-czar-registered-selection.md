# SCR-131: Interim Czar-registered selection before T-115 and T-091

| Field | Value |
|---|---|
| ID | SCR-131 |
| Filed by | chief architect, 2026-10-25 (Track A replan, baseline `ce17dad`) |
| Spec and section | `docs/specs/04-components/server/server-acceptance-evidence-selection.md` CZ-18 §5.1 (C2), §5.2 (N1 rule at `:657`; `unknown_policy` at `:661`); `docs/specs/04-components/server/server-supply-side.md` CZ-20 §5.8 (`:142` "Registered with CZ-18 at startup"); `docs/specs/05-build-plan/phase-1-tasks.md` T-045 (`:693-712`), T-115 (`:965-976`); D91 item 11 (`decisions-log.md:568`); `docs/specs/04-components/shared/ai-prompts.md` P-03 fallback (`:150`); `@czar/config` |
| Status | Accepted (Zaryab, 2026-10-25); Applied (2026-10-25) |

## Problem
- The planner calls `ports.ranking.rank(...)` and `ports.directory.get(...)` (`apps/server/src/planner/index.ts:272-284,327`). Neither has a production implementation, and no `apps/server/src/selection/` exists.
- T-045 is titled "Czar-registered candidates only" and D91 item 11 says "the planner core (T-045) keeps tag matching until T-115 lands". But no spec says which component answers `RankingDecision` before T-115 and T-091, or where the registered list comes from.
  - CZ-20 says merchants register "through its internal submit call" (`server-supply-side.md:43,142`), but that call has no transport, route or shape.
- CZ-18 says "Czar's own merchants are ranked by the same rules" (`:663`). With no receipts, `n_eff = 0`, so a Czar merchant is `unverified`. Under N1 (`:657`, `selection.unverifiedWithApproval` default `true`) it can be offered only in `exploration_slot`, and a plan using it always needs approval.

## Evidence
- The verification reports cited here are architect working papers outside the repository; every claim also carries a repository file:line.
- Verification report A §5 and §7.4; the file:line references above.

## Proposed change
- **Scope:** an interim CZ-18 producer that serves only Czar-registered services until T-115 (index, cards, retrieval) and T-091 (reputation) land. It is replaced by those tasks, not extended.
- **Registered list source.** New `@czar/config` key:

  | Key | Type | Default | Reason |
  |---|---|---|---|
  | `selection.czarRegisteredServices` | object keyed by `serviceId`, each `{resource, capabilities[]}` | `{}` | CZ-20 "registered with CZ-18 at startup"; Phase 1 transport is configuration. `resource` must be an origin in `fetch.localMerchantOrigins` (local) or `https` (testnet); `capabilities` ⊆ `drives.capabilityTaxonomy` |

  - This replaces the unspecified "internal submit call" for Phase 1.
  - T-115 loads the same key into its index ("Load Czar-registered and lab merchants into the index"), so the key outlives the interim producer.
- **Directory (`ports.directory.get`):**
  - For each configured service, the producer probes the live 402 through `@czar/x402` `safeFetch`.
    - It re-probes every `selection.registeredRecrawlHours` (new key, default 24; reason: CZ-20 `server-supply-side.md:142` "re-crawled by CZ-18 every 24 h").
    - The planner's own probe-before-plan (CZ-18 `:670`) still runs on every plan.
  - It stores only the sanitized fields 02 §11.3 allows:
    - `payTo`, `amount`, `scheme`, `network`, `maxTimeoutSeconds`
    - the sanitized `extensions.bazaar` input/output schema
    - `extensions.czar.rail`
  - The live 402 always wins (CZ-18 `:670`). Records carry `source = "czar-registered"`.
- **Ranking (`ports.ranking.rank`):**
  - Returns a schema-valid `RankingDecision` (02 §4.19) under the CZ-18 rules with zero observations:
    - `ranked = []`
    - every matching registered service whose live 402 is on `selection.paymentNetwork` and within `max_price_atomic` is listed in `unverified[]`
    - when `selection.unverifiedWithApproval` is true, the top one is placed in `exploration_slot` with `reason = "no-ranked-candidate"`
  - "Top" among unverified candidates means lowest live price, then lexicographic `serviceId`. This is a deterministic tie-break, stated because CZ-18 does not order unverified candidates.
  - It never fabricates evidence fields (`n_eff = 0`, no posteriors).
- **Two spec texts amended so the N1 candidate is reachable in Phase 1:**
  - CZ-18 `:661` (`unknown_policy = exclude` … "never pays an unverified service unless … exploration"): add "In Phase 1, `exclude` still honours the N1 `exploration_slot` (`:657`) when `selection.unverifiedWithApproval` is true. The slot is the exploration path." The planner code already does this (`apps/server/src/planner/index.ts:284-290`).
  - ai-prompts P-03 fallback (`:150`, "top-ranked verified candidate"): becomes "the top-ranked verified candidate, or, when there is none, the N1 `exploration_slot` candidate (plan always needs approval)". Without this, the model-free fallback yields no supplier under this SCR.
- **Consequence, accepted:** every Track A plan uses `exploration_slot` and therefore always needs the person's approval (CZ-13 §6 step 10). There is no earned-allowance auto-approval and no agent-opened envelope until T-091 or the I-F-6 ranking lands.
- **Acceptance port supply (SCR-122):** the same directory record supplies `AcceptancePorts.outputSchema.forService` (the sanitized `extensions.bazaar` output schema). `shapeHistory.forService` returns `null` until T-090, exactly as SCR-122 states.
- **Task plan:**
  - T-045's "fetch Czar-registered candidates" step points at this producer.
  - T-115 gains the line "replace the SCR-131 interim producer; keep `selection.czarRegisteredServices` as the registered source".

## Affected tasks
- T-045 (planner ports), T-047 (acceptance ports), T-115, T-090, T-091.
- New task TA-06 in the Track A plan.

## Decision
- Accepted by Zaryab on 2026-10-25 with the Track A replan (context and briefs in `docs/builder-prompts/track-a/`).

## Applied
- CZ-18 interim producer bullet and the `unknown_policy` note (`server-acceptance-evidence-selection.md`)
- ai-prompts P-03 fallback
- CZ-20 registration note
- `@czar/config`: `selection.czarRegisteredServices` (type `object`, keyed by `serviceId`, each `{resource, capabilities[]}`: the registry has no list-of-objects type, so the list is a map), `selection.registeredRecrawlHours`
- Tasks T-123, T-045 and T-115 notes
