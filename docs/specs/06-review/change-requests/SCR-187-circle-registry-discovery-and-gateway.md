# SCR-187: Circle registry discovery and Gateway nanopayments on Arc testnet

| Field | Value |
|---|---|
| ID | SCR-187 |
| Filed by | Claude (chief architect), 2026-11-05 |
| Spec and section | CZ-17 selection (`docs/specs/04-components/server/server-acceptance-evidence-selection.md`, candidate sources); CZ-13/CZ-14 planner and routing (`server-planning-and-payment.md` §routing, `routing.gatewayEnabled`); CZ-15 payer pocket path; `packages/x402` offer classification; `packages/config` registry; SCR-141 (Gateway switch), SCR-127 and SCR-004 (pocket safety chain), SCR-182 (audit merchants) |
| Status | Open |
| Tracker | C11, decision DD-07: CD-01 (this SCR); unblocks CD-02 to CD-09 (`docs/tracker/demo-v1-tracker.md`) |
| Builder | GPT orchestrator (all implementation tasks). Money-path parts are reviewed by the architect before merge |

---

## 1. Problem

- **Czar finds merchants only in its own hand-kept catalog,** `selection.czarRegisteredServices`. A merchant must be registered with Czar before Czar can find it.
- **DD-07 (Zaryab, 2026-11-05):**
  - Czar must also search **Circle's x402 registry on Arc testnet**, and rank those merchants with its own scoring. Circle merchants are never excluded up front.
  - **Gateway nanopayments are turned on.**
  - Czar's own merchants also go through Circle's normal registry route.
- **What the Circle discovery research (2026-11-05, 13:14–13:20 UTC) measured:**
  - 134 listings on Arc testnet (`eip155:5042002`). **Every one is payable only through Circle Gateway** (`extra.name = "GatewayWalletBatched"`).
  - Czar's vanilla x402 rail correctly refuses those offers, so today Czar can pay none of them.
  - Czar's Gateway (pocket) route exists, but is off: `routing.gatewayEnabled = false`.
  - It has only ever run against the local Circle stand-ins (D92, SCR-130, SCR-150), never against Circle's real testnet Gateway API.

## 2. Evidence

### 2.1 The Circle discovery API (research Q1–Q3; Confirmed)
- `GET https://api.circle.com/v2/x402/discovery/resources` needs no key or account.
- The OpenAPI is at `agents.circle.com/.well-known/openapi.json` (v2.0.0).
- **Arc testnet:** `network=eip155:5042002` → 134 listings, all `INFRASTRUCTURE`: 132 Quicknode RPC endpoints and 2 BotPay endpoints.
- **Response:** `{ x402Version: 2, items[], pagination: { limit, offset, total } }`.
  - `limit` defaults to 50, maximum 200; 500 gives 400.
  - The page order is not stable: 18 duplicates across 11 pages.
- **Filters:**
  - `network`, `category` (11 values; an invalid value gives 400), `query` (substring match)
  - `type`, `asset`, `scheme`, `payTo`, `maxUsdPrice`
  - `siwx`, `supportsVanillax402`, `supportsCircleGateway`, `fields`, `limit`, `offset`
- **No sort, relevance or health score.**
- **Caching:** `cache-control: public, max-age=3600, stale-while-revalidate=600` and an `etag`. No rate-limit headers.
- **Each `accepts[]` entry uses `amount`.** The OpenAPI's `maxAmountRequired` never appears in live data.
- **Input and output schemas:**
  - The input schema is often missing: 1,819 of 2,186 Arc mainnet listings have none, while all 134 Arc testnet listings have a JSON body schema.
  - The output schema is mostly missing.

### 2.2 Live 402s (research Q4; Confirmed)
- Quicknode `arc-testnet` and BotPay `/go` and `/pay` return x402 v2 402s that match their listings.
- The Arc testnet option is `exact`, asset `0x3600…0000` (USDC), `extra.name "GatewayWalletBatched"`, `verifyingContract 0x0077777d…19B9`, `maxTimeoutSeconds 604900`.
- The verifying contract equals `chain.gatewayWalletAddress` (`packages/config/src/registry.ts:3214`).
- **Quicknode's 402 also declares** the extensions `sign-in-with-x` and `quicknode-session` at the 402 level, not in `extra`.

### 2.3 Czar code
- **`packages/x402/src/buyer.ts:147,157`:** `selectOffer` takes a Gateway offer only on `policy.rail === "gateway"`, and never on the vanilla rail.
- **`apps/server/src/selection/registered/index.ts`:**
  - `:99`: eligibility rule `scheme-exact,asset-usdc,no-siwx,no-siwx-only,no-batch-settlement`
  - `:618`: SIWX is read only from `extra.siwx`
  - `:620`: batch settlement is read only from `extra.paymentFlow === "batch-settlement"`
  - So a Circle Gateway offer is not recognised as Gateway at selection time.
- **`packages/config/src/registry.ts:3457`:** `routing.gatewayEnabled` (default `false`), reason "stays off until the SCR-127 pocket safety chain (TA-20, TA-21) merges; enabled only by a later SCR (SCR-141)".
- **The pocket safety chain exists and is merged:**
  - `apps/server/src/payer/pocket.ts`: `executePocketPreparation` (register, gas, delegate, fund), `payGatewaySteps`, `refreshGatewayStatuses`, `drainPocketsAfterHalt`, `sweepAndRetirePocketKey` (K4 `pocket-return` for native and USDC; zero balance before key retirement)
  - `apps/server/src/payer/pocket-recovery.ts`: `recoverLateGatewayBalance`, slow-path pullback
  - `pullback.ts`, `pullback-scheduler.ts`
  - SCR-004 and SCR-127 are applied. SCR-141 (the switch) is accepted.
- **What SCR-177 cut** (treasury drip, **merchant-side** Gateway sweeps, Czar-service refunds) is not the owner's pocket return path. The owner's return path is in the list above.
- **`chain.gatewayApiBaseUrl`** defaults to `https://gateway-api-testnet.circle.com`. The local overlay points it at the stand-in.

## 3. Proposed change

This SCR is the normative spec for C11 until it is folded into the component specs. Sections §4 to §11 are the parts. Section §12 lists the config keys, §13 the tests, §14 the build order.

## 4. Part A: the Circle discovery source (CD-05)

### 4.1 Module
- **New module `apps/server/src/selection/discovery/circle.ts`.**
- **It exports a candidate source** with the same shape the registered catalog feeds into ranking: a list of `{ serviceId, resource, accepts, card, source }`.
- **It never calls a model.**

### 4.2 Request
- **Base URL:** `selection.circleDiscovery.baseUrl` (default `https://api.circle.com/v2/x402/discovery/resources`).
- **Fixed parameters:**
  - `network=<selection.paymentNetwork>`, which must be `eip155:5042002` on the testnet deployment
  - `type=http`, `scheme=exact`, `asset=<USDC address for the network>`
  - `limit=selection.circleDiscovery.pageLimit` (200)
- **Per-capability parameters**, from `selection.circleDiscovery.capabilityMap`, an object keyed by capability tag:

  | Capability | `category` | `query` |
  |---|---|---|
  | `web-search` | `WEB_SEARCH_RESEARCH` | — |
  | `page-extract` | `WEB_SEARCH_RESEARCH` | `extract` |
  | `data-lookup`, `email-lookup`, `company-lookup` | `DATA_ENRICHMENT` | — |
  | `price-lookup` | `FINANCIAL_ANALYSIS` | `price` |
  | `image-generate` | `CREATIVE` | — |
  | `summarize`, `translate`, `transcribe` | `INFERENCE` | the tag |
  | `code-review` | — | `audit` (substring search; Circle has no audit category) |
  | `table-build`, `chart-build` | none: no Circle request | — |

- **A capability with no map entry sends no Circle request.**
- **Paging:**
  - follow `offset` until `offset ≥ pagination.total` or `selection.circleDiscovery.maxPages` (5) pages are read
  - **dedupe items by `(type, resource, metadata.method)`**, because the page order is unstable
- **Fetching:**
  - only through the server's `safeFetch`, with `api.circle.com` added to its allowed origins for this source
  - timeout `selection.circleDiscovery.timeoutMs` (3000)
  - response size cap `selection.circleDiscovery.maxResponseBytes` (2,000,000)

### 4.3 Caching
- **Cache per `(network, capability)`** for `min(response max-age, selection.circleDiscovery.cacheSeconds)` (3600).
- **Revalidate with `If-None-Match`** (the `etag`).
- **Serve stale** for up to `stale-while-revalidate`, then drop.
- **The cache is in process.** No new table.

### 4.4 Failure
- **Any Circle error** (network, timeout, non-200, invalid JSON, schema mismatch): log `{ source: "circle", outcome, capability }` and continue with **Czar's own catalog only**.
- **Planning never fails because Circle is down.**

### 4.5 Listing → candidate mapping
- **`serviceId`:** `svc_` + `keccak256("circle|<network>|<method>|<resource>").slice(2, 34)`, a new `@czar/hashing` function `circleServiceId(network, method, resource)`.
  - It is deterministic, so evidence, ratings, incidents and lessons attach to a stable ID across refreshes.
- **`resource`:** `{ url: item.resource, method: item.metadata.method ?? "GET" }`. The URL must be `https:`, with no query or fragment, and pass the same URL rules as registered services; otherwise skip the item.
- **`accepts`:** the listing's offers for the payment network only.
- **`card`:**
  - `serviceName` = `metadata.provider.name` (≤ 80 chars)
  - `description` = `metadata.description` (≤ 300 chars)
  - `category` = `metadata.provider.category`
  - `inputFields` from `metadata.input` (§8)
  - `outputSchema` = `metadata.output` when present
- **`extensions.czar`:**
  - `source: "circle-registry"`
  - `claim.status: "unclaimed"`
  - `evidence` empty
- **Untrusted text:** all listing text is untrusted.
  - It is stored and shown only as plain text.
  - It reaches a model only through `ai-prompts.md` JSON-labelled blocks.
  - It is never used to build instructions.

### 4.6 Eligibility filter (before probing)
- **A Circle item is dropped,** with reason logged as a count per reason, when any of these holds:
  - `type` is not `http`
  - no `accepts` entry has `network = selection.paymentNetwork`, `scheme = exact` and `asset = USDC`
  - the payable offer's amount is over `planner.defaultMaxUnitAtomic` (or the plan's per-step maximum)
  - `metadata.siwx` is true, or `metadata.requiredHeaders` is non-empty
  - the capability needs a call template and the listing's input cannot be mapped (§8). The reason is `no-template`, as today.
- **Nothing else is filtered before ranking.** Circle merchants that pass compete with Czar's own (DD-07).

### 4.7 Probe before rank
- **Every Circle candidate is probed live** (one unpaid request), with the existing planner prober and the same probe input rules as registered services. Its 402 must:
  - be x402 v2
  - contain an offer equal to the listing's offer for the network (same `payTo`, `amount`, `asset`, `scheme`, `extra.name`)
  - declare no 402-level `sign-in-with-x` extension
  - declare no session extension that SCR-187 does not support (`quicknode-session` is unsupported)
- **A probe failure drops the candidate** for this objective.
- **The service version is recorded** with the existing `recordServiceVersion`, so the version-drift guard applies to Circle merchants unchanged.

## 5. Part B: one search, one ranking (CD-06)

### 5.1 Merging the two sources
- **For each capability, `createDecision` takes its candidates from:**
  - the registered catalog (as today)
  - **plus** the Circle source when `selection.circleDiscovery.enabled = true`

### 5.2 Dedupe across sources
- **The key is `(resource URL, method)`,** compared lower-case without a trailing slash.
- **When both sources list the same resource, the registered entry wins** for the `serviceId`, card and claim status.
  - It means Czar runs it, or has registered it by hand.
  - The Circle listing then adds nothing but a log line.

### 5.3 Ranking
- **Unchanged:** Wilson lower bound, health facts, the incident overlay (SCR-164), lessons (SCR-164), the exploration slot and approval reasons.
- **A Circle candidate with no ratings goes to `unverified[]`.** It needs owner approval, or the exploration slot, exactly like any unrated merchant.
- **Ratings, incidents and lessons for a Circle merchant attach to its `circleServiceId`.**

### 5.4 Volume limit
- **At most `selection.circleDiscovery.maxCandidates` (20) Circle candidates per capability** go on to probing.
  - They are taken in listing order after the eligibility filter.
  - The rest are dropped with reason `cap`.
- **Probing respects the existing `planner.probeTopK` and probe timeouts.**

## 6. Part C: recognising Circle Gateway offers (CD-04)

### 6.1 Classification
- **New pure function `classifyOffer(offer, extensions402, config)` in `@czar/x402`,** returning one of:
  - `"vanilla"`: `extra.name !== "GatewayWalletBatched"`, and no batch-settlement marker
  - `"gateway"`: `extra.name === "GatewayWalletBatched"` **and** `extra.verifyingContract` equals `chain.gatewayWalletAddress`, compared case-insensitively
  - `"unsupported"`: anything else, for example a Gateway offer with a different verifying contract, `extra.paymentFlow === "batch-settlement"` outside Gateway, or SIWX in `extra.siwx` or the 402 `extensions`
- **The rule is defined once and used by both** selection eligibility (`registered/index.ts:99,618,620` and the Circle source) and `selectOffer`.

### 6.2 Rail mapping
- `"vanilla"` → rail `x402-exact` (vault-direct, as today)
- `"gateway"` → rail `gateway-batched`, which routing turns into a `gateway-nano` step on the pocket path **when `routing.gatewayEnabled = true`**
- `"unsupported"` → not eligible
- **A candidate with both a vanilla and a Gateway offer:** routing chooses as it does today (CZ-14 §4–§5, SCR-141), with both rails available.

### 6.3 Selection eligibility
- **Replace the `no-batch-settlement` check** with `classifyOffer !== "unsupported"`.
- **Add `gateway` to the rails a ranked candidate may carry**, only when `routing.gatewayEnabled = true`. When it is `false`, a Gateway-only candidate is ineligible with reason `gateway-off`.

## 7. Part D: turning Gateway nanopayments on (CD-02, CD-03)

### 7.1 Already built (no new money code)
- **The pocket path exists:** register, gas, delegate, fund, pay, refresh statuses, pullback, slow withdraw, late-balance recovery, sweep, and key retirement at zero balance.
- **This SCR does not redesign it.**

### 7.2 CD-02: verify the pocket path against Circle's real testnet Gateway (P0, money path)
- **Run on a local stack with real external endpoints:**
  - `chain.gatewayApiBaseUrl = https://gateway-api-testnet.circle.com` (the default) instead of the stand-in
  - the real Arc testnet RPC
- **Run these four cases:**
  - **(a) A normal step:** fund pocket → pay one Gateway step to a **Czar** merchant on Arc testnet (CZ-20 Gateway route, if present; otherwise CD-07's Circle listing) → batch settles → leftover swept back → pocket key retired at zero.
  - **(b) A failed merchant call:** no charge, and the leftover is swept back.
  - **(c) A halt or cancel** mid-plan: `drainPocketsAfterHalt` returns all funds.
  - **(d) A late Gateway balance:** after `writeOffPocket`, `recoverLateGatewayBalance` returns it.
- **Each case is first a failing test** with recorded Gateway API responses (fixtures captured from the real API, no secrets), then a live check with Zaryab's approval for testnet funds.
- **Any gap found becomes a fix in that PR,** tests first.
- **Acceptance:**
  - the vault balance after each case equals before, minus exactly the settled payments
  - no pocket keeps a balance
  - each phase is recorded in `payer_executions`

### 7.3 CD-03: the switch
- **`routing.gatewayEnabled = true` only in the demo deployment overlay** (`env/cloud-demo.example.toml`), and only after CD-02 merges.
- **The production default stays `false`** until a later SCR, as SCR-141 requires.
- **Local stacks keep the stand-ins.**

### 7.4 Pocket funding limits stay unchanged
- `plan.pocketCapBps`, `calculatePocketFunding` and SCR-180's pending-spend rule all apply as they are.

## 8. Part E: input from a listing (CD-08, P1; a minimal version is P0)

- **P0 minimum, needed for CD-05 and CD-06:** a listing is usable when it fits one of these cases.
  - **Case 1:** `metadata.input` is a JSON body or query schema with **exactly one required string property**. That property becomes `inputFields: [{ name, type: "string" }]`, so the existing per-capability template applies.
  - **Case 2:** the capability has a fixed request the planner already knows (none today besides SCR-182's `contract`).
  - **Otherwise** the listing is `no-template` and drops at planning, as today.
- **P1 (CD-08):** listings with several fields, or with no schema.
  - Several fields with defaults: fill the one free-text field from the template, and the rest from schema defaults or examples only.
  - No schema: never call blind. Drop it.
  - A model-built input is **out of scope.** It needs its own SCR.
- **The pay-time rule `input-not-in-template` is unchanged:** a pay call may send only the keys in `inputKeys`.

## 9. Part F: delivery check with no output schema (CD-09, P1)

- **When a Circle listing has `metadata.output` with a JSON schema:**
  - the acceptance profile for its task class checks the body against it
  - an empty `example: {}` is not a schema
- **Otherwise the generic profile `generic-delivery.v1` applies:**
  - an HTTP 200 body within `acceptance.genericMaxBytes` (1,000,000)
  - a content type of JSON or text
  - JSON that parses, when JSON is claimed
  - the boundary screen (P-01) passes
  - Quality is judged by the owner rating, never by this check.
- **Until CD-09 lands,** Circle candidates whose task class has no acceptance profile drop at planning with reason `no-profile`.

## 10. Part G: Czar's merchants through Circle's registry (CD-10, P1, Zaryab)

- **Zaryab applies through Circle's agent marketplace** to list `czar-search`, `czar-spot`, `czar-extract`, `czar-audit-quick` and `czar-audit-deep` on Arc testnet.
- **Once listed, §5.2 dedupe keeps Czar's registered entry authoritative,** so nothing changes in ranking.
- **`selection.czarRegisteredServices` stays** as the fallback, because approval and timing are not guaranteed.
- **A listing is public and names Czar** ("Run by Czar", SCR-182 §1).

## 11. Part H: terms (CD-11, P1, Zaryab)

- **Circle's terms neither allow nor forbid caching, re-ranking or showing incidents about listed sellers** (research Q5).
- **Before production use beyond the testnet demo:** written confirmation from Circle.
- **Until then, `selection.circleDiscovery.enabled` defaults to `false`.** The demo deployment overlay sets it `true`.
- **The public feed never names a Circle merchant in an incident's opening post** unless that merchant has Czar evidence. The existing rule already requires evidence; this restates it.

## 12. Config keys (new)

| Key | Type | Default | Unit | Reason |
|---|---|---|---|---|
| `selection.circleDiscovery.enabled` | boolean | false | flag | Off until terms are confirmed; the demo overlay turns it on |
| `selection.circleDiscovery.baseUrl` | string | `https://api.circle.com/v2/x402/discovery/resources` | url | Circle x402 discovery API v2 |
| `selection.circleDiscovery.pageLimit` | integer | 200 | items | API maximum |
| `selection.circleDiscovery.maxPages` | integer | 5 | pages | Bounds work per refresh |
| `selection.circleDiscovery.timeoutMs` | integer | 3000 | ms | Never blocks planning for long |
| `selection.circleDiscovery.maxResponseBytes` | integer | 2000000 | bytes | Response size bound |
| `selection.circleDiscovery.cacheSeconds` | integer | 3600 | seconds | Matches Circle's `max-age` |
| `selection.circleDiscovery.maxCandidates` | integer | 20 | count per capability | Bounds probing |
| `selection.circleDiscovery.capabilityMap` | object | §4.2 table | — | Capability → Circle category or query |
| `acceptance.genericMaxBytes` | integer | 1000000 | bytes | Generic delivery profile (CD-09) |

- **Demo overlay additions** (`env/cloud-demo.example.toml`):
  - `"selection.circleDiscovery.enabled" = true`
  - `"routing.gatewayEnabled" = true` (only after CD-02)
- **`api.circle.com` and the Gateway API host must be allowed** by the server's safe fetch and the VM egress, if egress is restricted.

## 13. Tests (acceptance)

1. **Discovery request:** the exact URL and parameters for each mapped capability; `table-build` sends no request; paging stops at total or `maxPages`; duplicates across pages are removed.
2. **Caching:** a second call within `max-age` makes no request; an `etag` gives a 304 and reuses the cache; past stale-while-revalidate the cache is dropped.
3. **Failure fallback:** Circle 500, timeout or invalid JSON leave planning on the registered catalog only, with the outcome logged.
4. **Mapping:** the real Arc testnet listing fixtures (Quicknode, BotPay, from the research) map to candidates with a stable `circleServiceId`; untrusted text is truncated and never interpolated into prompts.
5. **Eligibility:** a SIWX listing, a `requiredHeaders` listing, an over-price listing and a wrong-network listing are all dropped with their reasons.
6. **Probe:**
   - a 402 matching the listing → candidate kept, version recorded
   - a changed `payTo` or amount → dropped
   - a 402-level `sign-in-with-x` → dropped
7. **Classification** (`classifyOffer`), with the real 402 fixtures:
   - Gateway offer → `gateway`
   - vanilla USDC → `vanilla`
   - a Gateway offer with another verifying contract → `unsupported`
   - `selectOffer` never takes a Gateway offer on the vanilla rail
8. **Gateway off:** a Gateway-only candidate is ineligible with `gateway-off`, and nothing is paid.
9. **Merge and dedupe:** a resource present in both sources yields one candidate, with the registered `serviceId`; Circle and registered candidates rank together; an unrated Circle candidate is in `unverified[]`.
10. **Planner:** with discovery on and a Circle candidate that fits a template, the plan step uses it, the version-drift guard applies, and approval is required while it is unrated.
11. **Pocket path against the real testnet Gateway (CD-02):** cases (a) to (d) of §7.2, with recorded fixtures first, then one live run each with approval.
12. **End to end (CD-07):** discover Quicknode `arc-testnet` → probe → rank → pay one `eth_blockNumber` call for 100 atomic (0.0001 USDC) through the pocket → settle → sweep → the vault reconciles.

## 14. Build order and owners

| Order | Task | Owner | Money path |
|---|---|---|---|
| 1 | CD-04 `classifyOffer` and the selection eligibility change | GPT | Yes (payment classification): architect review |
| 2 | CD-05 the Circle discovery source (fixtures-first) | GPT | No |
| 3 | CD-06 merge into `createDecision` and the planner | GPT | Planner: architect review |
| 4 | CD-02 pocket path against the real testnet Gateway, recorded fixtures, then live (approval) | GPT | **Yes, tests first, architect review** |
| 5 | CD-03 demo overlay keys (`routing.gatewayEnabled`, `selection.circleDiscovery.enabled`) | GPT | Config only, after CD-02 |
| 6 | CD-07 end-to-end live payment to Quicknode `arc-testnet` | GPT + Zaryab (funds) | Yes |
| 7 | CD-08 input builder, CD-09 generic delivery profile | GPT | No |
| — | CD-10 listing application, CD-11 terms | Zaryab | — |

- **CD-04 and CD-05 can run in parallel.**
- **CD-02's fixture-based tests need no funds.** Its live runs and CD-07 need Zaryab's approval for testnet funds, and the production setup for anything on the VM.

## 15. Out of scope
- Model-built request inputs for schema-less listings.
- Circle Gateway on any network other than Arc testnet.
- Merchant-side Gateway sweeps and Czar-service refunds (SCR-177).
- Mainnet.

## Affected tasks
- CD-01 to CD-11 (C11)
- MR-04: registered A and B stay authoritative under §5.2

## Decision
- <filled in by Zaryab>
