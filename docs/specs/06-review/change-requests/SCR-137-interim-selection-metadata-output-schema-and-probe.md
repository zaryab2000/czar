# SCR-137: Interim selection — truthful ranking metadata, response-body schema source, and the registered 402 probe

| Field | Value |
|---|---|
| ID | SCR-137 |
| Filed by | chief architect, 2026-10-25, from the Lane 3 TA-06 (T-123) pre-PR questions relayed by Zaryab |
| Spec and section | `docs/specs/02-data-and-protocol/schemas/ranking-decision.schema.json`; `docs/specs/02-data-and-protocol/data-and-protocol.md` §4.19; `docs/specs/04-components/server/server-acceptance-evidence-selection.md` CZ-18 §5.2 interim producer, §5.3 probe-before-plan, §5.6 parameters; SCR-131; SCR-122 (acceptance ports); `@czar/config` `selection.czarRegisteredServices` |
| Status | Accepted (Zaryab's delegation for TA-06; recorded by his merge of this change); Applied (2026-10-25) |

## Problem
- **Ranking metadata has no truthful interim values.**
  - `RankingDecision` requires `policy_version` (`pol_` + 16 hex, SL `PolicyVersion = "pol_" + hex(keccak256(policy tarball))[0:16]`), `snapshot_id` ("Anchored snapshot root") and `snapshot_anchor_tx` ("Anchor transaction") (`ranking-decision.schema.json`; SL architecture `:239`, `:449` invariant 8, `:772`).
  - The SCR-131 interim producer has no policy tarball, no materialised snapshot and no anchor.
  - Zero hashes or a locally invented policy id would claim an anchor and a policy that do not exist.
- **No response-body schema source is defined.**
  - SCR-122 says the merchant's output schema comes "from the sanitized `extensions.bazaar` data". But a Bazaar declaration's `schema` validates the declaration's `info`, not the bytes a buyer purchases.
  - `@x402/extensions` 2.28.0 puts a seller-declared response schema at `schema.properties.output.properties.example`, merged into a forced `{type: "object"}` (`dist/esm/chunk-SV2YHMOC.mjs:75-85`). When the seller declares none, that subschema is only `{type: "object"}`.
  - The acceptance checker already records `structural: inconclusive` when no usable schema exists (`apps/server/src/acceptance/executor/checks.js:25-33`).
- **The registered probe target is undefined.**
  - SCR-131 registers an *origin*, but `czar-search` answers only `GET /v1/search?q=` and returns `400` before any `402` when `q` is missing or invalid (`apps/merchants/src/search/route.ts:94-107`). So probing the origin, or the bare path, cannot discover the challenge.
  - The planner's own probe (`apps/server/src/planner/probe.ts:8-11`) sends only `resource.url` and `resource.method`.
  - The payer builds paid calls by appending call inputs to `resource.url` (`apps/server/src/payer/vault-direct.ts:968-973`), so the URL must stay bare.

## Proposed change

### 1. Ranking metadata for the interim producer
> **Superseded in part by SCR-138 (2026-10-25):** the `policy_version` descriptor and the snapshot `services` entry shape below are replaced by SCR-138 §1–§2. Storage, `snapshot_anchor_tx` and the schema change stand.

- **`policy_version`**: `"pol_" + hex(keccak256(utf8(JCS(descriptor))))[0:16]` via `@czar/hashing`, where `descriptor` is exactly:
  `{"policy":"czar-registered-interim","scr":"SCR-137","network":<selection.paymentNetwork>,"unverifiedWithApproval":<selection.unverifiedWithApproval>,"exploration":"lowest-live-price-then-serviceId","ranked":"none"}`.
  - This is the hash of the complete rule the producer applies, so it changes whenever that rule or its configuration changes.
  - It is **not** `pol_default_v1`, and no policy tarball or `GET /v1/policy/{policy_version}` is served for it.
- **`snapshot_id`**: `keccak256(utf8(JCS(snapshot)))`, where `snapshot` is
  `{"kind":"czar-registered-interim-snapshot","policy_version":…,"network":…,"services":[…]}`.
  - `services` is sorted by `serviceId`. Each entry is `{serviceId, serviceName, capabilities, resourceUrl, method, payTo, amount, scheme, network, probedAt}`: the configured capability assignments used for matching (sorted) and the sanitized live-402 fields this decision used. A config change to capabilities therefore yields a new `snapshot_id` (amended after PR #65 review).
  - The producer stores the exact JCS text in a server table `selection_interim_snapshots(snapshot_id text PRIMARY KEY, body_jcs text NOT NULL, created_at timestamptz NOT NULL, last_used_at timestamptz NOT NULL)`, a Lane 3 migration. `body_jcs` is the canonical UTF-8 text whose keccak256 is `snapshot_id`; verification hashes those stored bytes and never re-serialises them (`jsonb` is not used because it does not keep the exact bytes).
  - A decision that reuses an existing snapshot sets `last_used_at` to its own time. A row is deleted only when `last_used_at` is older than `selection.decisionRetentionDays`, so every decision's snapshot outlives that decision's retention window.
  - A decision is reproducible from `(policy_version, snapshot_id)`, as SL invariant 8 requires.
- **`snapshot_anchor_tx`**: `null`. The schema allows `Hash32 | null`.
  - `null` means the snapshot is **not anchored**. No consumer (planner, app, evidence) may present such a decision as anchored.
  - Anchoring (`FEATURE_SNAPSHOT`) arrives with T-091/T-057.
- **Schema:** `ranking-decision.schema.json` goes to 1.1. `snapshot_anchor_tx` becomes `Hash32 | null`, and the `snapshot_id` and `policy_version` descriptions state the interim meaning. Every other field is unchanged.
- **02 §4.19:** add the interim rule and the recorded deviation from SL invariant 8 ("anchored"): Phase 1 interim decisions are unanchored and say so.

### 2. Response-body schema for `AcceptancePorts.outputSchema.forService`
- Take `extensions.bazaar.schema.properties.output.properties.example` from the service's live 402, after the 02 §11.3 sanitizing (the extension validated, no external `$ref`, `schema` ≤ 8 KiB).
- Return `null`, meaning no response schema is declared, when any of these hold:
  - the extension was dropped
  - `output` is absent
  - the subschema has no keyword other than the `type: "object"` the SDK injects
- `null` yields `structural: inconclusive` in the checker. That is today's behaviour, and nothing is invented.
- A seller-declared schema is untrusted input. It is compiled only inside the acceptance sandbox (SCR-122) and never resolved outside the document.
- `czar-search` declares no Bazaar output schema today, so its `structural` result is `inconclusive` until CZ-20 adds a declaration. That would be a separate change.

### 3. Registered service shape and the 402 probe
- **`selection.czarRegisteredServices`** value shape becomes an object keyed by `serviceId`. Each entry is:
  - **`resource`**: `{url, method}`.
    - `url` is the full resource URL with no query string or fragment. Its origin must be in `fetch.localMerchantOrigins` locally, or `https` on testnet.
    - `method` is `GET` or `POST`.
  - **`probeInput`**: the fixed, non-personal input that makes the resource answer its `402`.
    - For `GET`: `{query: {<name>: <string>}}`, appended as query parameters.
    - For `POST`: `{body: <JSON object>}`, sent as the JSON body.
    - No new size limit: the values are fixed operator config, and the resource validates them like any request (for `czar-search`, CZ-20 §5.7).
    - It comes only from config, never from a catalog, a 402 body or a user.
  - **`capabilities`**: a subset of `drives.capabilityTaxonomy`.
  - **`serviceName`**: the merchant's own service name (CZ-20, e.g. `czar-search`), shown in labels and used for the signer's `K10:<serviceName>` key; it is not the map key.
- **Map key = `serviceId`** (`SlServiceId`, `^svc_[0-9a-f]{32}$`), derived once by the SL rule `"svc_" + hex(keccak256(utf8(origin ‖ method ‖ first_seen_path ‖ first_seen_ts)))[0:32]` (SL §5.1) at registration, with `first_seen_ts` the RFC 3339 registration time. It is recorded in config and never recomputed, so it stays stable. The producer refuses an entry whose key does not match the pattern.
- **Probe:**
  - The directory probes with `resource.method` at `resource.url` plus `probeInput`, unpaid, through `@czar/x402` `safeFetch` and the existing origin rules, with `selection.probeTimeoutMs`.
  - Only a `402` with a valid x402 `PAYMENT-REQUIRED` counts. Any other status is a failed probe.
  - The directory record handed to the planner carries `probeInput` beside the bare `resource`. CZ-13's probe-before-plan (CZ-18 §5.3) uses it; paid calls never use it (they use the plan's `callInputs`).
- **Local overlay value for `czar-search`:** `{"svc_223349701b9428c8a6dc42d8a7c99c4a": {"serviceName": "czar-search", "resource": {"url": "http://127.0.0.1:8787/v1/search", "method": "GET"}, "probeInput": {"query": {"q": "czar probe"}}, "capabilities": ["web-search"]}}`. The key is the SL rule over `http://127.0.0.1:8787`, `GET`, `/v1/search`, `2026-10-25T00:00:00Z`. The testnet overlay registers its own key from its own origin and time (T-121).

### 4. Where the response schema comes from in code
- `@czar/x402`'s sanitizer (`packages/x402/src/extensions.ts`) keeps only `info` and `routeTemplate` today and discards the validated `schema`.
- Ruling: `SanitizedExtensions.bazaar` gains `schema`, the declaration's schema exactly as validated, present only when the declaration passed every 02 §11.3 rule. TA-06 (Lane 3) adds it as an additive change to the shared package, in a separate small commit (the shared-package rule in `docs/builder-coordination.md`).
- No consumer re-parses the raw 402 to recover the schema; the sanitizer is the only reader of seller extensions.

## Affected tasks and briefs
- **T-123 / TA-06 (Lane 3):**
  - the §1 metadata and the `selection_interim_snapshots` migration
  - the §2 port rule and the §4 additive `@czar/x402` change (separate commit)
  - the §3 directory shape and probe
- **T-122 / TA-08 (Lane 2):** the planner prober (`apps/server/src/planner/probe.ts`) sends the directory record's `probeInput`, if present; the internal `PlannerService` type gains optional `probeInput`. A small addition to TA-08.
- **T-122 (Lane 2):** the planner test fixture moves to `schemaVersion: "1.1"` (done in this change so `build-v1` stays green).
- **TA-04 (Lane 1):** the local overlay value above.

## Decision
- Architect ruling for the TA-06 questions, under Zaryab's delegation. It takes effect when Zaryab merges this change.

## Applied
- `ranking-decision.schema.json` 1.1 and regenerated `@czar/schemas` types.
- 02 §4.19.
- CZ-18 interim producer, probe-before-plan and parameter row.
- `@czar/config` reason text for `selection.czarRegisteredServices` (key unchanged).
- Planner test fixture `schemaVersion`.
