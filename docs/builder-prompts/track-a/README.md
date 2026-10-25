# Track A builder briefs (payment path, Lanes 1, 2, 3, 5)

## Ground rules
- **Base:** fresh `origin/build-v1` **after** the spec-application branch is merged. That branch:
  - applies the accepted SCRs to `docs/specs/`
  - adds the accepted SCRs' `@czar/config` keys (the architect adds them; builders never do, SCR-136 §1)
  - updates `docs/builder-coordination.md`
- **Gates:** every gate below (SCR-127 to SCR-136) was accepted by Zaryab on 2026-10-25 and applied by the spec-application PR that added this folder. Once that PR is merged, a brief may start when its dependencies (the Deps column) are merged.
- **Context in this folder:** `verified-lane-snapshot-2026-10-25.md` (status at `ce17dad`, file:line evidence), `payment-path-dependency-map.md` (hop-by-hop producers, consumers, owners). The SCR texts are in `docs/specs/06-review/change-requests/SCR-127` to `SCR-136`.
- **Every builder uses:**
  - the standard preamble in `docs/builder-coordination.md`
  - the loop in `docs/pr-review-workflow.md`
  - the SCR-136 ownership table
- **Acceptance boundary** (SCR-136 §3, recording Zaryab's 2026-10-25 instruction):
  - Required:
    - focused tests for the new code (failing tests first on money paths)
    - `pnpm lint`
    - the package typecheck
    - the package's existing tests
  - Every acceptance test that needs local `arc-anvil`, a crash/restart matrix, a live service, a real device or testnet is reported as `NOT RUN / DEFERRED`.
  - **No task is marked done while any of its acceptance tests is deferred.**
- **No brief:**
  - creates, reads or prints keys
  - starts the signer against a real keystore
  - deploys
  - calls a live Circle or model endpoint
  - touches testnet or mainnet
  - merges

## Order
- **Wave 1:** TA-01, TA-02, TA-03, TA-04, TA-06, TA-07, TA-10, TA-11, TA-14, TA-16
- **Wave 2:** TA-05, TA-08
- **Wave 3:** TA-09, TA-12
- **Phase A2:** TA-20 → TA-21 → TA-22a → TA-22b → TA-22c; TA-13 and TA-15 any time (SCR-135 and SCR-134 are applied)

## Brief table

| Brief | Lane | Gate | Deps | Title |
|---|---|---|---|---|
| TA-01 | 1 | SCR-128 | — | Signer `sl-receipt` settled check from indexer facts |
| TA-02 | 1 | SCR-129 | — | Signer `keyAddress` socket method and client |
| TA-03 | 1 | SCR-136 (T-105 amendment) | — | Local key file and vault roles from signer keys |
| TA-04 | 1 | SCR-130 | — | D92 Circle stand-ins and the local-only guard |
| TA-05 | 3 | SCR-129, SCR-130, SCR-136 | TA-02, TA-04 | Composed `czar-search` merchant (T-043 reopened) |
| TA-06 | 3 | SCR-131, SCR-136; SCR-129 for the K7 port | TA-02 (K7 port only) | Interim selection and acceptance ports (T-123) |
| TA-07 | 1 | SCR-132 | — | Indexer `GET /envelopes/by-plan-hash/{planHash}` |
| TA-10 | 1 | SCR-132 (allowance rule) | — | Vault-client `getLimits` reader |
| TA-08 | 2 | SCR-132, SCR-136 | TA-02, TA-06, TA-07, TA-10 | Composition root, planner loop, opening watcher (T-122 part 1) |
| TA-09 | 2 | SCR-132, SCR-128 | TA-08, TA-01 | Dispatcher, receipt ports, completion (T-122 part 2) |
| TA-11 | 1 | none (code defect) | — | Signer autonomy raise bound |
| TA-12 | 2 | SCR-136 (T-085 split) | TA-08 | Freeze → `lowerAutoLimit` listener |
| TA-13 | 5 | SCR-135 | — | Wallet production config |
| TA-14 | 5 | none | — | Approval-page JS and interactive budgets |
| TA-15 | 5 | SCR-134 | — | Device management routes and page |
| TA-16 | 5 | SCR-132 | — | Approvals list: "Approval sent" state |
| TA-20 | 1 | SCR-127 | — | Gateway balance projection and signer fields (T-124) |
| TA-21 | 2 | SCR-127 | TA-20, TA-08 | Halt drain inputs, late funds, write-off rule (T-053) |
| TA-22a | 1 | SCR-133 | TA-20 | Manual return: encoder and indexer |
| TA-22b | 2 | SCR-133 | TA-21, TA-22a | Manual return: persistence, reconciliation, hold |
| TA-22c | 5 | SCR-133 | TA-22a, TA-22b | Manual return: route and UI |
