# M3 thin-slice implementation status

## Implemented path and actual startup commands

`apps/merchants/src/search/route.ts` implements the specified czar-search
request/quote/payment/verification/handler/settlement flow as a route factory.
The actual merchant entry point does not compose this route yet:

- `fnm exec --using=22.22.0 pnpm --filter @czar/merchants start:local` starts the
  current health-only HTTP server (`GET /health`, 404 otherwise). It does not
  expose czar-search.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server start:local` starts the
  local app with job-delivery DB/RPC/object-store dependencies. It does not call
  `createServerMain` and therefore does not connect the running entry point to
  boundary, payer, settlement, receipt persistence, and acceptance handoff.

Relevant existing configuration/service names are `CZAR_LOCAL_CONFIG`,
`CZAR_DATABASE_URL`, `CZAR_ARC_RPC_URL`, `CZAR_LOCAL_OBJECT_STORE_PATH`,
`CZAR_SERVER_PORT`, `CZAR_MERCHANT_PORT`, Postgres, the configured Arc RPC,
and the local object store. No secret values are recorded here.

## Existing modules traced

- `apps/merchants/src/search/route.ts`: canonical route factory and payment
  state machine.
- `apps/merchants/src/facilitator.ts`: Circle Facilitator client and seller-proof
  signing port.
- `apps/merchants/src/payment-id-store.ts`: bounded payment-id replay store.
- `apps/server/src/main.ts`: injectable composition of boundary, acceptance,
  payer, settlement and receipt creation; exports execution functions but does
  not schedule/dispatch approved plan steps from the local server entry point.
- `apps/server/src/local-main.ts` / `local-app.ts`: current runnable P1 job
  delivery composition; not the full payment server composition.

## Handoffs and blockers

1. **Lane 1 / signer:** `czar-search` needs the public `K10:czar-search` payTo
   address. `SignerClient` currently provides `sign` and `createPocketKey`, not
   a public merchant-key address lookup. No accepted config or deployment
   manifest field was found to supply it. Add/approve that producer before
   composing the production seller route; private key material is not needed by
   the merchant process.
2. **Lane 5 / server startup:** connect the actual server entry point to the
   existing planner and execution lifecycle. It must route approved steps into
   `createServerMain`'s payer/boundary path, persist settled receipts and
   acceptance reports, and resume outstanding work. `local-main.ts` currently
   stops at `createLocalApp`.
3. **Lane 3 / evaluator:** job deliverable cleanup requires a durable decision
   with the matched on-chain content hash and decision timestamp. The Lane 2
   cleanup helper is present, but there is no authoritative producer to trigger
   it safely.
4. **Gateway / G0-05 and later gates:** real Gateway balances/transfers and the
   Facilitator live path are not validated here. No route was substituted with
   a mock in production startup.

## Validation scenarios — NOT RUN / DEFERRED

- **NOT RUN:** merchant local HTTP quote/402 → payment verify → search handler →
  settle → response via the intended process. Required command once startup
  composition is implemented: `fnm exec --using=22.22.0 pnpm --filter
  @czar/merchants test` plus a child-process HTTP integration test.
- **NOT RUN:** server local process from approved plan inputs through payer,
  acceptance boundary, receipt persistence and report association. Required
  command once Lane 5 startup wiring exists: `fnm exec --using=22.22.0 pnpm
  --filter @czar/server test` with a process-level integration scenario.
- **NOT RUN:** crash/restart and Arc Anvil acceptance matrices for T-052/T-053/
  T-054. These remain deferred to the later validation phase.
- **NOT RUN:** hosted model, live Facilitator/Gateway, testnet, funding or
  deployment scenarios. These require the later G0-16/K18/T-121 approvals.

No testnet activity, funds, accounts, secrets or live service calls were used.
This report records implementation status only; it does not claim T-050
acceptance passed.

## PR and review status

- PR [#61](https://github.com/zaryab2000/czar/pull/61) targets `build-v1` and
  remains draft; current reviewed head before this report correction is
  `e01fa1e0a85d0bad34a63519d66e1019da9beba5`.
- The designated reviewer completed a local code review at `e01fa1e` and found
  no blocking code defect. Hosted Codex code and security reviews remain
  running on that SHA; no duplicate hosted review request was made.
- The full workspace typecheck passed for 14 of 15 projects with typecheck
  scripts. This is typecheck evidence only; the full server tests and T-050
  process/acceptance scenarios remain unrun or deferred as listed above.
