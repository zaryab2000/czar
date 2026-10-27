# M3 thin-slice implementation status

## Implemented path and actual startup commands

`apps/merchants/src/search/route.ts` implements the specified czar-search
request/quote/payment/verification/handler/settlement flow as a route factory.
The actual merchant entry point does not compose this route yet:

- `fnm exec --using=22.22.0 pnpm --filter @czar/merchants start:local` starts the
  current health-only HTTP server (`GET /health`, 404 otherwise). It does not
  expose czar-search.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server start:local` starts the
  local app through `createLocalServerMain` and `createServerMain`. The started
  composition includes the boundary, payer, settlement lookup, receipt builder,
  planner/opening workers, dispatcher, and completion service. The dispatcher
  reaches approved plan steps and resumes them under the executor lease. This
  code wiring has focused local tests; the Arc process-level payment/receipt run
  remains deferred under D94.

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
- `apps/server/src/main.ts`: composition of boundary, acceptance, payer,
  settlement, receipt creation, dispatcher, and completion.
- `apps/server/src/local-main.ts` / `local-app.ts`: runnable local composition;
  `local-main.ts` starts the payment runtime through `createServerMain`.

## Handoffs and blockers

1. **Lane 1 / signer:** `czar-search` needs the public `K10:czar-search` payTo
   address. `SignerClient` currently provides `sign` and `createPocketKey`, not
   a public merchant-key address lookup. No accepted config or deployment
   manifest field was found to supply it. Add/approve that producer before
   composing the production seller route; private key material is not needed by
   the merchant process.
2. **Lane 4 / Lane 5 result acknowledgement:** Lane 2 stores local and
   agent-assist steps as `handed_off` and the dispatcher now waits without
   repeating the handoff. The existing OpenAPI `ackResult` route must consume
   `ackResult.assembly[]` and move the corresponding step to `done`; that route
   is not present in the server app implementation. Lane 5 owns route
   registration and Lane 4 owns the daemon caller.
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
- **NOT RUN:** Arc process-level execution from approved paid plan through
  settlement proof, acceptance report association, signed receipt persistence,
  envelope close, and objective completion. Run the Arc acceptance fixture
  after the local Arc services and deployment artifacts are prepared; this
  development task only ran the focused DB-backed local-step composition test.
- **NOT RUN:** crash/restart and Arc Anvil acceptance matrices for T-052/T-053/
  T-054. These remain deferred to the later validation phase.
- **NOT RUN:** hosted model, live Facilitator/Gateway, testnet, funding or
  deployment scenarios. These require the later G0-16/K18/T-121 approvals.

No testnet activity, funds, accounts, secrets or live service calls were used.
This report records implementation status only; it does not claim T-050
acceptance passed.

## PR and review status

- PR [#61](https://github.com/zaryab2000/czar/pull/61) is merged at
  `ce17dadce27fc25c9e424c1b656da416af370f46`. Its review loop is closed.
- TA-09 is delivered separately; see `apps/server/T-122-TA-09-task-report.md`.
