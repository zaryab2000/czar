# Lane 3 and Lane 5 briefs

## Lane 3 (acceptance, evidence, selection, supply)

### TA-05 Composed `czar-search` merchant (T-043 reopened)
- **Gate:** SCR-129, SCR-130, SCR-136. **Deps:** TA-02, TA-04. **Branch:** `codex/t043-merchant-runtime`.
- **Files:**
  - `apps/merchants/src/local-main.ts`
  - a new Postgres payment-id store (CZ-20 `server-supply-side.md:30` and §5.4 `:99-110` require Postgres)
  - a seller-proof adapter
  - `apps/merchants/package.json` (add `@czar/signer` and `@czar/logging` as workspace deps)
  - tests
- **Build:**
  - At startup, load config and call `keyAddress("K10:czar-search")`. Any error stops startup (`merchant_signer_unavailable`).
  - `createSearchRoute` takes:
    - `payTo` from the signer
    - `resourceUrl = merchants.publicOrigin + "/v1/search"`
    - network, price and timeouts from existing keys
    - `createFacilitator({sellerProof, baseUrl: merchants.facilitatorBaseUrl, timeoutMs})`
    - the Postgres store
    - `emit` → `@czar/logging`
  - Seller-proof adapter:
    - bytes32 nonce, expiry ≤ 300 s
    - `sign("cz-20", {keyId:"K10", kind:"merchant-seller-proof", payload:{service, purpose, method, bodyHash, network, nonce, expiry}})`
    - `encodeSellerProof` with the same `payTo`
  - Adapt the fetch-style handler to the HTTP server. Apply `merchants.drainTimeoutMs` on stop and the per-payer/per-route rate-limit keys.
  - If `indexer.merchantPayoutAddresses` is non-empty and lacks the address, log `merchant_payout_unindexed`.
- **Tests (local, mocked Facilitator):**
  - T-043 acceptance (a) and (b)
  - the Postgres store survives a restart
  - signer unavailable stops startup
  - no `payTo` is ever read from config
- **Acceptance:** tests, lint, typecheck.
- **Deferred:** T-043 (c) → T-050b; the stand-in round trip → T-050a.

### TA-06 Interim selection and acceptance ports (T-123)
- **Gate:** SCR-131, SCR-136; SCR-129 for the K7 port. **Deps:** TA-02 (K7 port only). **Branch:** `codex/t123-interim-selection`.
- **Files:** new `apps/server/src/selection/registered/`; `apps/server/src/acceptance/ports.ts` (new).
- **Build:**
  - **Directory** over `selection.czarRegisteredServices`: live-402 probe through `@czar/x402` `safeFetch`, re-probed every `selection.registeredRecrawlHours`. Keep only the 02 §11.3 sanitized fields; `source = "czar-registered"`.
  - **`rank()`:** a schema-valid `RankingDecision`:
    - `ranked: []`
    - matching services in `unverified[]`
    - the top one (lowest live price, then `serviceId`) in `exploration_slot` with `reason = "no-ranked-candidate"` when `selection.unverifiedWithApproval`
  - **`AcceptancePorts`:**
    - `outputSchema.forService` from the sanitized bazaar output schema
    - `shapeHistory.forService` → `null`
    - `validatorIdentity.address` → `keyAddress("K7")` as `cz-16`
    - `clock`
- **Tests:**
  - the decision validates against `ranking-decision.schema.json`
  - wrong network or over `max_price_atomic` → excluded
  - deterministic tie-break
  - no description text is stored
  - a changed `payTo` in a live 402 wins
  - port values
- **Acceptance:** tests, lint, typecheck.
- **Out of scope:** BM25, cards, Circle catalog, reputation (T-115, T-091, Track B).

## Lane 5 (web app and app-facing server)

### TA-13 Wallet production config
- **Gate:** SCR-135 (keys `app.circleClientUrl`, `app.circleClientKey`, `app.arcRpcUrl`).
- **File:** `apps/web/packages/wallet.ts:11-13`.
- **Build:** remove the three test defaults and read the SCR-135 keys. A missing value fails at build or start. The bundler transport is unchanged (T-087 owns secondary bundlers).
- **Acceptance:** a test that a missing value fails rather than falling back; e2e passes with values from the e2e config; lint; typecheck.

### TA-14 Approval-page JS and interactive budgets
- **Gate:** none (CZ-22 §3 `:33`).
- **Build:**
  - Measure a deep link to `/approve/[planId]` for both budgets: first load ≤ 300 KB JS gzipped, and interactive ≤ 1.5 s.
  - Mirror the method of `apps/web/e2e/app.spec.ts:25-35`.
  - If over budget, lazy-load `#src/wallet` (and `@circle-fin/modular-wallets-core` through it) on the approve action.
- **Acceptance:** both measurements pass locally; lint; typecheck. The 1.5 s figure on a mid-range laptop is recorded with its machine, as CZ-22 states it.

### TA-15 Device management routes and page
- **Gate:** SCR-134.
- **Files:** `apps/server/src/devices/`, `app.ts` registration, schemas/api-contract for the three operations, `apps/web/app/settings/devices/page.tsx`.
- **Build:** the three SCR-134 operations and the page with SCR-134 wording; `Idempotency-Key` on POSTs.
- **Tests:** another user's device → 404; the code is never logged; the code expires after `app.pairingCodeTtlMinutes`; e2e issue → list → revoke; a revoked token is refused.
- **Acceptance:** tests, lint, typecheck.

### TA-16 Approvals list: "Approval sent" state
- **Gate:** SCR-132 §2.
- **Files:** `apps/server/src/app/approvals.ts` (list query), the approvals pages.
- **Build:**
  - A plan in `approved` whose objective is `awaiting-approval` is listed with "Approval sent. Waiting for the network to confirm it."
  - It has no approve action.
  - Plans in `offered` are unchanged.
- **Tests:** listing and no-action for that state; `offered` unchanged; another user's plans are not listed.
- **Acceptance:** tests, lint, typecheck.

### TA-22c Manual return: route and UI (T-125)
- **Gate:** SCR-133. **Deps:** TA-22a, TA-22b.
- **Build:**
  - `listManualReturns` (AppSession, user-scoped).
  - The Envelope detail section and the Home notice with SCR-133 wording.
  - Submit via `sendOwnerUserOperation(passkey, vault, encodeRecordManualReturn(pocket, returnedAmount))`.
  - Show "Recorded {recordedCredit}" once the row is `recorded`.
- **Tests:** user scoping; the encoder is used; the expired wording.
- **Acceptance:** tests, lint, typecheck.
- **Deferred:** a real passkey UserOp on testnet (M8).
