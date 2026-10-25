# Lane 1 briefs (contracts, signer, vault client, chain, indexer, ops)

## TA-01 Signer `sl-receipt` settled check from indexer facts
- **Gate:** SCR-128. **Branch:** `codex/ta01-sl-receipt-settled-check`.
- **Files:**
  - `apps/signer/src/policy.ts` (`slReceipt`, `:411-416`)
  - `apps/signer/src/projection.ts`
  - `apps/signer/src/postgres-projection.ts` (`hasSettledPayment`, `:299-306`)
  - `apps/signer/src/requests.ts`
  - signer tests
- **Build:**
  - Require `paymentRef: PaymentRef` (02 §4.12) in the `sl-receipt` payload and validate it with `@czar/schemas`.
  - Recompute `paymentRefHash` with `@czar/hashing` (★ fields excluded). A mismatch is `payment-ref-mismatch`.
  - Apply the SCR-128 rail binding. A failure is `payment-not-this-vault`.
  - Check the settled fact from indexer tables:
    - `authorizations` (vault, nonce, amount, `settled`)
    - `gateway_transfers` (`from`, nonce, `completed`)
    - the `jobs` mirror (`Completed`)
  - Remove the `evidence_receipts` read from this check. Leave `checksCommitExists` unchanged.
- **Tests first:**
  - a settled x402 payment signs; an unsettled one is denied `payment-not-settled`
  - a wrong hash is denied `payment-ref-mismatch`; payer ≠ vault is denied `payment-not-this-vault`
  - Gateway: `completed` signs, `confirmed` is denied
  - job: `Completed` signs, `Submitted` is denied
  - a regression proving no `evidence_receipts` row is needed
- **Acceptance:** the tests above, `pnpm --filter @czar/signer test`, typecheck, `pnpm lint`.
- **Deferred:** the `CZAR_LOCAL_CHAIN` signer suite.

## TA-02 Signer `keyAddress` socket method and client
- **Gate:** SCR-129. **Branch:** `codex/ta02-signer-key-address`.
- **Files:**
  - `apps/signer/src/socket.ts` (method union `:130`, dispatch `:168-171`, parser `:183-190`, client `:92-122`)
  - `apps/signer/src/service.ts`
  - `apps/signer/src/runtime-adapters.ts` (existing `LOCAL_CALLERS`)
  - tests
- **Build:**
  - Add `keyAddress(keyRef)` to the socket and to `createSignerClient`. It returns `backend.address(keyRef)` only for the caller-to-key pairs in SCR-129 (K4 excluded). Anything else is `key-not-allowed`.
  - K10 refs must name a service in the signer's merchant list.
  - Rate-limit with `signer.keyAddressPerMin`. Write no signing audit row.
- **Tests first:**
  - allowed: `cz-20` reads `K10:czar-search`; `cz-16` reads K7
  - refused: `cz-20` asking for K3; `cz-15` asking for K4; an unknown service
  - the response holds only an address
  - the rate limit
  - a client round trip over the socket
- **Acceptance:** tests, `@czar/signer` test and typecheck, lint.

## TA-03 Local key file and vault roles from signer keys
- **Gate:** SCR-136 §2 (T-105 amendment). **Branch:** `codex/ta03-local-key-roles`.
- **Files:**
  - `apps/signer/scripts/create-keys.ts`:
    - output shape `{network, chainId, backend, createdAt, K3:{address, ref}, …}` matching `contracts/script/Deploy.s.sol:90-95`
    - a local mode writing `deployments/local-keys.json`
    - lab and K21 entries optional until T-106/H7
  - `ops/local/deploy.sh:47-54`: read roles from that file instead of `eth_accounts[0]`; give those addresses local gas through the node's unlocked accounts
  - `apps/signer/test/create-keys.test.ts`
- **Rules:** write public addresses and refs only. Never print or log key material.
- **Acceptance:**
  - a dry-run test proves the file parses at the paths `Deploy.s.sol` reads
  - a shell or unit check proves `deploy.sh` reads it
  - lint, typecheck
- **Deferred:** creating local keys and running the deploy (operator step, Zaryab, G0-13).

## TA-04 D92 Circle stand-ins and the local-only guard
- **Gate:** SCR-130. **Branch:** `codex/ta04-circle-standins`.
- **Files:**
  - `packages/config` validator for the SCR-130 §2 local-only guard (the keys themselves arrive with the spec-application branch)
  - `apps/indexer/src/gateway-poller.ts:4` reads `chain.gatewayApiBaseUrl`
  - new `ops/local/circle-standins/`
  - `ops/local/process-compose.yaml`: the stand-in process; the server and merchants depend on it; the server gets `CZAR_INDEXER_URL`
  - `env/local.toml`: overlay values incl. `merchants.searchBackend = "fixture"`, `fetch.localStandinOrigins`, `merchants.publicOrigin`, `selection.czarRegisteredServices`
- **Stand-in:**
  - Facilitator `POST /verify` and `/settle` with the shapes `apps/merchants/src/facilitator.ts` uses. Settle sends `transferWithAuthorization` with `eth_sendTransaction` from the node's unlocked account. **No private key is embedded or loaded.**
  - Gateway `POST /v1/balances`, `POST /v1/transfer`, `GET /v1/x402/transfers` from the recorded A2 fixtures.
- **Startup refusals:** a non-loopback RPC, no `anvil_nodeInfo` answer, a non-`127.0.0.1` bind, or a non-`local` overlay. If pinned `arc-anvil` lacks `anvil_nodeInfo`, stop and report.
- **Tests:**
  - the config guard rejects a loopback URL when the RPC is non-loopback, and when `anvil_nodeInfo` is unanswered
  - the stand-in refuses each startup condition
  - verify/settle round trip against a mocked RPC
- **Acceptance:** tests, lint, typecheck.
- **Deferred:** the stand-in against a running `arc-anvil` (T-050a).

## TA-07 Indexer `GET /envelopes/by-plan-hash/{planHash}`
- **Gate:** SCR-132 §2. **Branch:** `codex/ta07-envelope-by-plan-hash`.
- **Files:** `apps/indexer/src/api/router.ts`, the indexer store module, tests. The existing `vault`-required `/envelopes` route is unchanged.
- **Build:** return the `envelopeByRef` response shape (SCR-119) or 404. Lowercase 0x-hex 32-byte check (400 otherwise).
- **Tests:** match, no match, bad hash; the response validates against the SCR-119 contract.
- **Acceptance:** tests, lint, typecheck.

## TA-10 Vault-client `getLimits` reader
- **Gate:** SCR-132 (planner `allowance` rule in TA-08). **Branch:** `codex/ta10-vault-client-limits`.
- **Files:** `packages/vault-client/src/client.ts`, tests.
- **Build:** typed `getLimits(vault, categoryId) → {userMax, autoLimit, usedInPeriod, periodId, lastRaiseAt}` (`contracts/src/interfaces/ICzarVault.sol:170-176,479`).
- **Tests:** decoding against the ABI; a revert decodes to a named error (T-026 rule).
- **Acceptance:** tests, lint, typecheck.

## TA-11 Signer autonomy raise bound
- **Gate:** none. It's a code defect; CZ-24 `:64` and CZ-27 `:403` specify the step from `userMax`. **Branch:** `codex/ta11-autonomy-raise-bound`.
- **File:** `apps/signer/src/postgres-projection.ts:144-151`.
- **Build:** `maxStepTo = autoLimit + userMax × maxRaiseStepBps / BPS`. The contract bounds the increase by `userMax` (`contracts/src/vault/logic/AutonomyLogic.sol:48`).
- **Tests first:** with `autoLimit = 0` and with `autoLimit > 0` (only the second tells the two formulas apart). A raise of exactly `userMax × bps / BPS` is allowed; one atomic unit more is denied `above-step`.
- **Acceptance:** tests, lint, typecheck.

## TA-20 Gateway balance projection and signer fields (T-124)
- **Gate:** SCR-127. **Branch:** `codex/t124-gateway-balance-projection`.
- **Files:**
  - `apps/indexer/ponder.schema.ts` (`pocket_balances`)
  - the Gateway poller and registration: balances poll; scope includes `DelegateReady` and `Closed`; on-chain `withdrawingBalance`/`withdrawalBlock`; Gateway domain from the deployment manifest
  - indexer API queries `pocketBalance`, `fundedPocketsForVault`, `closedPocketsWithBalance`
  - `pocket-stale` and `gateway-poll-failing` flags
  - `apps/signer/src/postgres-projection.ts`:
    - `pocketBalances`: chain reads plus the projection, with the max age
    - `slowWithdrawalOpen`: derived
    - `slowWithdrawAllowed`: per SCR-127 §4
    - write-off at or below the fee (SCR-127 §4)
    - `nanoSpent`: non-failed transfers
- **Tests first:**
  - exact decimal→`Amount6` conversion, including malformed inputs
  - a stale API figure denies write-off, retire and slow withdraw, and allows `pocket-return`
  - write-off is allowed with dust ≤ fee and denied above it
  - Closed pockets stay polled until K4 is destroyed
  - `nanoSpent` includes `received`, `batched` and `confirmed`
- **Acceptance:** tests, lint, typecheck (indexer and signer).
- **Deferred:** G0-05; the local-chain run.

## TA-22a Manual return: encoder and indexer (T-125)
- **Gate:** SCR-133. **Deps:** TA-20.
- **Files:** `packages/vault-client/src/encoders.ts` (`encodeRecordManualReturn`); indexer `ManualReturnRecorded` fields (`pocket`, `credit`); query `manualReturnsForVault`.
- **Tests:** the encoder matches the ABI; the projection stores pocket, credit, tx and block; the query is vault-scoped.
- **Acceptance:** tests, lint, typecheck.
