# Security and testing (spec 03)

- **Date:** 2026-10-18; amended 2026-10-19 (G0-01 review fixes: §3.7 contract regression tests, §3.8 off-chain regression tests). **Status:** draft. Covers `CzarVault`, `CzarVaultFactory`, `OpenEvidenceLog`, the job adapter, `CzarJobEscrow` (pre-mainnet), `BuilderEscrow` and `RecipeSplits` (Phase 2).

## 1. Threat model per contract (spec 01 §13 → the check that stops it)

| Threat (spec 01 §13) | Contract | What the attacker tries | Check that stops it |
|---|---|---|---|
| Model hijacked / agent key leaks (K3) | `CzarVault` | pay an unapproved payee | `reserve`/`openJob` require a Merkle proof under `payeeRoot` (02 §5.3); `isValidSignature` ties `to` to the reservation payee (§6.1 step 5) |
| | | inflate an amount | `value == unitAmount`, `stepCap ≤ maxStepAmount`, per-step `stepUsed + total ≤ stepCap` across every reservation and job of the step and its alternates, cap check (INV-1, INV-5, INV-12; RV-002, RV-035) |
| | | sign many authorizations | nonce derived per index, `index < count`, USDC nonce single-use (§6.5 proof) |
| | | open envelopes freely | agent-opened envelopes need `cap ≤ sat(autoLimit, usedInPeriod)` (INV-9); at most `2 × autoLimit` around a period boundary (RV-031); the signer checks K3's `openEnvelope` arguments against a stored plan (CZ-27, RV-032) |
| | | route a pullback elsewhere | `GATEWAY_BURN` fixes `destinationRecipient = vault` (INV-6) |
| | | over-fund a pocket | `funded ≤ cap × pocketCapBps / BPS`, delegate check (INV-7), agent-opened `pocketCapBps ≤ 2500` (D71) |
| | | register a pocket it controls | `registerPocket` requires a kind-4 leaf for that address under the owner-approved `payeeRoot` (INV-14, D71, RV-003) |
| | | attest fake receipts | `SL_RECEIPT` recomputes the `Receipt` struct hash and verifies a vault-bound `ReceiptAttestation` (INV-11, RV-013); the signer signs only for settled payments (CZ-27) |
| | | name itself evaluator | `openJob` uses `vault.evaluator` only (JOB-2) |
| | | withdraw | no agent withdraw path (INV-3) |
| Server compromised | all | all of the above plus evidence forgery under K8 | same bounds; guardian pause (`factory.guardianPaused()`) read on every spending path (INV-4); evidence forgery is detectable by recompute (SL §8.5) and moves no funds |
| Pocket key leaks (K4) | `CzarVault` | drain the pocket | a raw K4 can sign a burn intent from the pocket to any recipient, and on-chain a revoked delegate's intents still pass (`Burns.sol` lines 332–333; `Delegation.sol` lines 100–128, 153–164; RV-063), so the loss is the pocket's whole Gateway balance: bounded by `outstanding` ≤ 25% of cap; `requestPullback` immediately; pockets stay small and short-lived; `removeDelegate` by the attacker only blocks the trustless path, not the bound |
| Malicious merchant | `CzarVault` | settle without delivering | bounded per index by `unitAmount`; expiry release of unused indices; evidence (off-chain) |
| | | settle `upfront` early | routing policy; the vault bound is the same |
| Poisoned catalog text | none on-chain | — | off-chain reader/planner split (spec 01 §13.1) |
| Malicious observer input | none on-chain | — | off-chain; the vault only sees hashes |
| Dependency upgraded against Czar | `CzarVault` | USDC changes ERC-1271 semantics; Gateway changes delegate rules; ERC-8183 changes fees | the vault never trusts a dependency for accounting: settle reads `authorizationState`, pullback reads `isTransferSpecHashUsed`, fund reads fees in the same tx; indexer `Upgraded` alerts halt new actions; worst case per path bounded as spec 01 §13 |
| Claim server lies (D17) | `BuilderEscrow` | release to a wrong wallet | timelocked, public, cancellable release (builder-escrow spec) |
| Phished user approval | `CzarVault` | user approves a bad plan | on-chain bound = that envelope's cap; `userMax` per category; freeze; the app rebuilds `payeeRoot` and `planHash` from the displayed leaves before signing (CZ-22, RV-044) |
| Selection Layer operator misconduct | `OpenEvidenceLog` | drop or reorder evidence | per-publisher hash chain, inclusion tickets (off-chain), anyone can publish |
| Reentrancy | `CzarVault`, escrows | re-enter during `depositFor`, `transfer`, `fund`, `gatewayMint` callbacks | `ReentrancyGuardTransient` on every externally-calling function; checks-effects-interactions; USDC and Gateway make no callbacks to the vault except the `view` `isValidSignature` |
| Griefing with `settle`/`finalize` by anyone | `CzarVault` | call early or with wrong indices | `finalize` requires `now > validBefore`; indices validated; loops bounded by `FINALIZE_CHUNK` |
| Griefing `confirmPullback` | `CzarVault` | confirm a non-minted hash | `isTransferSpecHashUsed` must be true |
| Replay of signed messages | `CzarVault` | reuse an `AutonomyRaise` or `OwnerAction` | nonces + deadlines; chainId and vault address in the domain (02 §6.1) |
| Signature malleability | `CzarVault` | high-s variants | low-s rule, `v ∈ {27,28}` |
| Front-running `fund` with a raised budget | adapter | provider raises the budget after the agent decided to fund | `fundJob(jobKey, expectedBudget)` reverts `BudgetChanged` (M1-b); read and `fund` in one transaction (JOB-1) |
| Zero-budget submit (H1) | vault | provider submits while `Open` with budget 0, so the job can never be funded | `syncJob` releases `Opened` jobs whose escrow is `Submitted`/`Completed` (INV-16); the evaluator never completes an unfunded job |
| Unresponsive or overpriced provider (H2) | vault | the job blocks its step cap until expiry | `cancelJob` (client reject while `Open`); front-run by a zero-budget submit falls back to `syncJob` (N7) |
| Bytecode substitution for new users | factory | admin swaps vault code | impossible: a factory deploys only the bytecode compiled into it; a new version is a new factory (D73); existing vaults unaffected (FAC-4) |
| Default-signer swap for new users (K20 leak) | factory | admin sets attacker K3/K5/K7 for every new vault | `queueDefaults` is timelocked 48 h and alerted on (FAC-3, RV-015); predicted addresses do not move (FAC-5) |
| Re-committed probe intent | `OpenEvidenceLog` | reveal a second batch after seeing results | `AlreadyCommitted` (OEL-6, RV-014) |

## 2. Invariant list

| Id | Where defined |
|---|---|
| INV-1 … INV-15 | `czar-vault.md` §11 |
| FAC-1 … FAC-5 | `czar-vault-factory.md` §9 |
| JOB-1 … JOB-5 | `job-escrow-adapter.md` §8 (JOB-5 = INV-16, H1/H2) |
| OEL-1 … OEL-6 | `open-evidence-log.md` |
| CJE-1 … CJE-3 | `czar-job-escrow.md` §9 |
| BE-1 … BE-5, RS-1 … RS-3 | `builder-escrow-and-recipe-splits.md` |

Each is written so a Foundry `invariant_*` test can assert it after every handler call.

## 3. Test plan

### 3.1 Unit tests (per function and per error)

- One test per row of every function table and one per custom error, including the role matrix (`czar-vault.md` §2): every (role × function) cell has a test that expects success or the exact error.
- `isValidSignature`: for each kind and the fallback: happy path; every numbered check failing one at a time (wrong nonce, wrong index, index ≥ count, done bit set, wrong `to`, `value != unitAmount` (both larger and smaller, RV-035), `validAfter != 0`, wrong `validBefore`, expired, frozen, paused, wrong digest, wrong signer, high-s, bad `v`); never reverts; returns `0xffffffff` for a bare 65-byte signature against an unregistered digest.
- `GATEWAY_BURN`: each `TransferSpec` field mutated → `INVALID`; cross-chain domain → `INVALID`; `Cancelled` record → `INVALID`.
- Digest reproduction: the seven entries in 02 §6.4 must be reproduced on-chain: `derivedNonce`, USDC digest, burn digest with `transferSpecHash`, `Receipt` digest and struct hash, `ReceiptAttestation` digest (RV-013), `AutonomyRaise` (its `deadline` lies inside `periodId`, so the on-chain `raiseAutoLimit` call succeeds, RV-061), `OwnerAction`.
- D30: WebAuthn fixtures (a real assertion captured from a test passkey, RP ID `localhost`, D78) verified through `executeOwnerAction`; wrong `rpIdHash`, missing UV, wrong challenge → `InvalidPasskeyAssertion`; a **high-s** fixture is refused as sent and accepted after the client normalises `s` to `N − s` (RV-034); gas: 6,900 per precompile call, ≈ 6,900 on the valid path and ≈ 13,800 on the invalid path (A6-02, RV-034); every `OwnerActionKind` 1–16 dispatches to its function (RV-033).

### 3.2 Fuzz tests (reservation and envelope math)

- Random sequences of `reserve`, `settle`, `finalize` with random `count`, `unitAmount`, indices and simulated USDC nonce consumption, including runs where every index settles before `validBefore`; assert INV-1, INV-5, INV-8, INV-12, INV-13 and that `reserved` returns to 0 after all reservations are final and the envelope closes (RV-001).
- Random pocket fund / pullback / cancel / confirm / recovery sequences, interleaved with owner `withdraw` of free balance and `forceCloseEnvelope`; assert INV-7, INV-14 and that `committedTotal` matches the recomputed sum and never exceeds `balanceOf` outside the settle window (INV-2, RV-005, RV-011).
- Earned-autonomy raises, lowerings and freezes across period boundaries; assert INV-9 (restated), INV-10, that raises are at least `PERIOD_LENGTH` apart, and that no allowance computation reverts with a panic (RV-008, RV-030, RV-031).
- Rounding: `cap × pocketCapBps / BPS` and raise steps never exceed caps by a unit.

### 3.3 Foundry invariant tests

- Handlers: owner (including `withdraw`, `forceCloseEnvelope`, `recordManualReturn`, `setMaxPullbackFee`), agent, autonomy, guardian, a USDC mock that honours ERC-1271 exactly like `NativeFiatTokenV2_2` (nonce map, `validBefore`, pause, blacklist), a Gateway mock (`depositFor`, `isAuthorizedForBalance`, `isTransferSpecHashUsed`), an ERC-8183 mock for both ABIs (Czar kind with partial claims, `settledAmount`).
- Assert every INV/FAC/JOB id after each call. Use `arc-anvil --network arc` as the test node so native-USDC semantics (18/6 decimals, zero-address rule, P-256) are real (A9-13, A9-14).

### 3.4 Fork tests (pinned `arc-anvil`, Arc testnet fork)

- Install `arc-foundry` v0.8.0-2 from the checksummed release tarball, never `foundryup` or `foundry-toolchain` (A9-12, A9-13). Fork `https://rpc.testnet.arc.io` at a recorded block.
- **USDC:** deploy the real vault, fund it, sign a `USDC_3009` envelope signature, call the bytes overload `0xcf092995` of `transferWithAuthorization` from a relayer address as Circle's relayer did (A1-18); assert the transfer, `AuthorizationUsed`, and `authorizationState == true`; then `settle` and `finalize`. Also the `v,r,s` overload is **not** used (envelope signatures are longer than 65 bytes).
- **GatewayWallet:** `grantPocketGas`, pocket `addDelegate(USDC, vault)`, `fundPocket` → `isAuthorizedForBalance` true and `Deposited` event (A2-02, A2-04); negative test: skip `addDelegate` → `DelegateNotSet`.
- **Pullback (AR-5):** build the burn intent from a `PullbackRequested` event, sign with the agent key in the `GATEWAY_BURN` envelope, run the vault's `isValidSignature` through `eth_call` exactly as Circle's TEE would (A2-08), then on the live testnet (not the fork) `POST /v1/transfer` with `contractSigner: true` and mint; assert `isTransferSpecHashUsed` and `confirmPullback`. This is the one test that needs real testnet funds (≤ 1 USDC) and Zaryab's explicit approval; the read-only parts run in CI.
- **ERC-8183 (Circle instance):** `openJob` → `JobCreated`; a test provider `setBudget`; `fundJob` reads budget and fees (both 0, A4-07) and funds; test evaluator `complete` and `reject`; `claimRefund` after expiry by an unrelated address (EIP reference, `erc-8183.md` line 690).
- **AR-3 `/verify` check:** from the fork-deployed vault address, deploy the same bytecode on live testnet (read-only otherwise), build a `PaymentPayload` with the envelope signature and call Circle's `/verify` keyless (A1-15, costs nothing). Record `isValid` and the reason. If rejected, set `vaultSignatureMode = digest` (02 §6.3.4) and repeat with `reserveWithDigests` + 65-byte signature.
- **Mainnet simulation only:** `eth_call` with state overrides against `rpc.mainnet.arc.io` for the USDC path (as A1-11); no mainnet transaction.

### 3.5 Gas tests

- `forge snapshot` on every function in `czar-vault.md` §13; CI fails on > 5% regression; the measured table feeds the routing parameters (`pocketThreshold(n)`).

### 3.6 Static analysis and lint (pinned in CI)

- `slither` (pin version in the build plan) with triage file; `forge fmt --check`; `solhint` optional; `cargo-deny`-style licence check for OpenZeppelin (MIT).
- Custom Slither detectors or grep checks: no `tx.origin`, no `block.prevrandao` (p1-A7), no unbounded loops, every external call behind the reentrancy guard, every function has a custom error path tested.

### 3.7 Named regression tests: contract fixes from the G0-01 review

Each row is a Foundry test the builder writes first (builder rules: tests first for contracts and money paths). The test name is binding; it appears in the task report. "Inv" is the invariant the fuzz/invariant suite must also assert.

| Test | RV | Asserts | Inv | Task |
|---|---|---|---|---|
| `test_settleAllIndices_reservationFinal_envelopeCloses` | RV-001 | reserve `count = 10`; settle 0–9 before `validBefore` → `ReservationFinal`, `openReservations == 0`, `closeEnvelope` succeeds and releases `cap − spent` | INV-13 | T-015 |
| `test_finalize_skipsDoneIndices` | RV-001 | settle 0–4; after `validBefore`, `finalize(0, 10)` releases 5–9 without reverting on 0–4 | INV-8, INV-13 | T-015 |
| `test_reserve_sameStepTwice_revertsStepCapExceeded` | RV-002 | second `reserve` on the same step beyond `stepCap` reverts `StepCapExceeded(step, used, stepCap, wanted)` | INV-12 | T-015 |
| `test_reserve_alternatePayee_sharesStepCap` | RV-002 | reserve on payee then on alternate: the sum is bounded by one `stepCap` | INV-12 | T-015 |
| `test_openJob_afterReserveOnSameStep_reverts` | RV-002 | a job needs the whole step cap free | INV-12 | T-018 |
| `test_releasedIndices_restoreStepRoom` | RV-002 | after `finalize` releases unused indices, a new `reserve` on the step succeeds up to the released amount | INV-12 | T-015 |
| `test_reserve_stepCapAboveMaxStepAmount_reverts` | RV-002 | a leaf whose `stepCap > maxStepAmount` cannot be reserved | INV-1 | T-015 |
| `test_registerPocket_addressNotInPayeeRoot_reverts` | RV-003 | `PocketNotInPlan` for any address without a kind-4 leaf | INV-14 | T-017 |
| `test_registerPocket_pocketCapZero_reverts` | RV-003 | `PocketCapZero` | INV-14 | T-017 |
| `test_registerPocket_secondPocketOnEnvelope_reverts` | RV-003, RV-005 | `PocketExists` | INV-14 | T-017 |
| `test_openEnvelope_agentPocketCapAbove2500_reverts` | RV-003 | agent `pocketCapBps = 2501` → `BadParams`; owner may use up to 5000 | INV-14 | T-014 |
| `test_recoveryPullback_closedPocket_mintIsFreeBalance` | RV-004 | written-off pocket; recovery `requestPullback`; `GATEWAY_BURN` digest valid; mint + `confirmPullback(creditedToEnvelope = false)`; `committedTotal` unchanged | INV-2, INV-6 | T-017 |
| `test_forceClose_fundedPocket_closesPocketAndReleasesAll` | RV-005 | `PocketClosed`, `pocketOutstanding == 0`, `released == cap − spent − jobEscrowed − shortfall`, INV-2 holds | INV-2, INV-14 | T-014, T-017 |
| `test_forceClose_openedJob_fundJobReverts` | RV-005 | after force-close, `fundJob` reverts `EnvelopeNotOpen`; `syncJob` sets `Released` without accounting | INV-2, INV-8 | T-018 |
| `test_confirmPullback_afterForceClose_creditsFreeBalance` | RV-005 | a `Pending` pullback minted after force-close does not touch `committedTotal` and does not underflow | INV-2, INV-7 | T-017 |
| `test_fundJob_whileFrozenOrPaused_reverts` | RV-006 | `FrozenVault` / `Paused` | INV-4 | T-018 |
| `test_grantPocketGas_whileFrozenPausedOrExpired_reverts` | RV-006 | `FrozenVault`, `Paused`, `EnvelopeExpired` | INV-4 | T-017 |
| `test_grantPocketGas_reentrantPocket_reverts` | RV-006 | an EIP-7702-style pocket that re-enters on receive cannot re-enter any guarded function | — | T-017 |
| `test_lowerBelowUsed_openEnvelopeRevertsAllowanceExceeded` | RV-008 | `usedInPeriod = 8`, lower to 0 → agent `openEnvelope` reverts `AllowanceExceeded(c, 0, cap)`, never panic 0x11 | INV-9 | T-014, T-019 |
| `test_lowerAutoLimit_equalIsNoop` / `test_raiseAutoLimit_notAbove_reverts` | RV-008 | lowering 0 → 0 succeeds; raise to ≤ current reverts `RaiseNotAbove` | INV-9 | T-019 |
| `test_syncJob_openedAfterExpiry_released` / `test_syncJob_openedRejected_released` | RV-009 | `Released`, `reserved` and `stepUsed` drop by `reservedCap`, `openJobs−−`, envelope can close | INV-8, INV-12 | T-018 |
| `test_syncJob_czarPartialClaim_refundsBudgetMinusSettled` | RV-009 | Czar kind: `settledAmount = 0.3`, budget 1.0, reject → credit 0.7, `spent += 0.3` | INV-1, INV-2 | T-018 |
| `test_closeEnvelope_afterDuplicateOpenJobRetry` | RV-009 | two `openJob` for one step (crash retry), one never funded; after expiry `syncJob` releases it and the envelope closes | INV-8 | T-018 |
| `test_recordManualReturn_boundedByOutstandingAndFree` / `_notOwner_reverts` / `_closedPocket_reverts` | RV-010 | credit = `min(amount, outstanding − pendingPullback, freeBalance())`; only the owner; `PocketWrongState` on `Closed` | INV-2, INV-7 | T-017 |
| `test_freeBalance_saturatesInSettleWindow` | RV-011 | USDC moves out through an authorization before `settle`: `freeBalance() == 0`, no revert; `withdraw` reverts `InsufficientFree` | INV-2 | T-013 |
| `test_withdrawBeforeConfirmPullback_recordsShortfall` | RV-011 | mint lands, owner withdraws it, `confirmPullback` → `ShortfallRecorded`, `committedTotal ≤ balanceOf` | INV-1, INV-2 | T-017 |
| `test_slReceipt_otherSlType_invalid` | RV-013 | a `Correction` digest with any blob returns `0xffffffff` | INV-11 | T-016 |
| `test_slReceipt_signatureForVaultA_invalidOnVaultB` | RV-013 | same receipt, same agent key, two vaults: only the bound vault returns MAGIC | INV-11 | T-016 |
| `test_slReceipt_v1Tag_invalid` | RV-013 | the retired `.v1` tag with an opaque struct hash returns `0xffffffff` | INV-11 | T-016 |
| `test_commitProbeIntent_twice_revertsAlreadyCommitted` / `test_recommitAfterReveal_reverts` | RV-014 | `AlreadyCommitted` before and after `reveal`; `batchRoot` never changes | OEL-2, OEL-6 | T-011 |
| `test_predictVault_stableAcrossDefaultsChange` / `test_createVault_anyCaller_sameAddress` | RV-015 | `predictVault(o)` before and after `applyDefaults` and for any caller equals the deployed address | FAC-5 | T-012 |
| `test_queueDefaults_appliesOnlyAfter48h` | RV-015 | `applyDefaults` before `eta` reverts `TooEarly` | FAC-3 | T-012 |
| `test_raiseSignedBeforeFreeze_cannotLand` / `test_raiseAutoLimit_whileFrozen_reverts` | RV-030 | freeze bumps `autonomyNonce`; the old signature fails `BadSigner`; while frozen `FrozenVault` | INV-10 | T-019 |
| `test_twoRaisesAcrossPeriodBoundary_secondReverts` | RV-031 | raise at `boundary − 1 s`, raise at `boundary + 1 s` → `RaiseAlreadyThisPeriod` | INV-9 | T-019 |
| `test_ownerAction_everyKindDispatches` | RV-033 | kinds 1–16 each reach their function; unknown kind → `UnknownAction` | — | T-019 |
| `test_passkey_highS_refusedThenNormalisedAccepted` | RV-034 | raw high-s assertion → `InvalidPasskeyAssertion`; `N − s` → success; gas per precompile call 6,900 | — | T-019 |
| `test_usdc3009_valueBelowUnitAmount_invalid` | RV-035 | `value = unitAmount − 1` returns `0xffffffff` | INV-5 | T-016 |
| `test_cancelPullback_beforeMaxBlockPlusDelay_reverts` / `test_gatewayBurn_afterMaxBlockHeight_invalid` | RV-036 | `TooEarly`; digest invalid once `block.number > maxBlockHeight` | INV-6, INV-7 | T-017 |
| `test_lateMintOfCancelledRecord_keepsPendingWithinOutstanding` | RV-036 | INV-7 holds; `requestPullback` arithmetic never underflows | INV-7 | T-017 |
| `test_setMaxPullbackFee_aboveCeiling_reverts` / `test_requestPullback_feeAboveCurrentMax_reverts` | RV-037 | `FeeCeilingExceeded`; `FeeTooHigh` against the owner's current `maxPullbackFee` | INV-15 | T-017 |
| `test_writeOff_registeredPocket_writtenOffZero` | RV-049 | a pocket whose `addDelegate` failed closes with `writtenOff = 0`; envelope can close | INV-14 | T-017 |
| `test_reserve_validBeforeAfterEnvelopeExpiry_reverts` | RV-056 | `BadTtl` when `validBefore > expiresAt` | — | T-015 |
| `test_abi_matchesICzarVaultSol` | RV-060 | every event topic and error selector the vault emits equals `ICzarVault.sol`; the indexer decoders are generated from the `.sol` ABI | — | T-014, T-031 |
| `test_vectors_reproducedOnChain` | RV-061, RV-013 | all seven 02 §6.4 entries reproduce; the `AutonomyRaise` vector executes on-chain at its `deadline` | INV-11 | T-023 |

### 3.7a Named regression tests: ERC-8183 job-path review (H1, H2, M1-b, N7)

All on the Circle-instance mock, whose zero-budget submit, client reject, fee-at-complete and refund rules match the deployed source (job-path review R1–R5), and repeated in the T-022 fork tests against the real proxy.

| Test | Finding | Asserts | Inv | Task |
|---|---|---|---|---|
| `test_syncJob_zeroBudgetSubmit_releases` | H1 | `openJob`; provider `submit` while `Open` with budget 0; `syncJob` → `Released`, `reserved` and `stepUsed` drop by `reservedCap`, `openJobs` drops, `closeEnvelope` succeeds | INV-8, INV-12, INV-16 | T-018 |
| `test_syncJob_unfundedCompleted_releases` | H1 | as above, then evaluator `complete` (budget 0, no transfer); `syncJob` → `Released`; vault balance unchanged | INV-2, INV-16 | T-018 |
| `test_fundJob_afterEarlySubmit_revertsJobNotOpen` | H1 | `fundJob` on a job the provider already submitted reverts `JobNotOpen` | INV-16 | T-018 |
| `test_cancelJob_open_releasesAndAlternateOpens` | H2 | `cancelJob` → escrow `Rejected` (client), `JobCancelled`, `Released`; an `openJob` for the alternate payee on the same step succeeds | INV-12, INV-16 | T-018 |
| `test_cancelJob_funded_reverts` | H2 | `cancelJob` on a funded job reverts `JobWrongState` | — | T-018 |
| `test_cancelJob_frozen_allowed` | H2 | `cancelJob` succeeds while `frozen` and while the guardian has paused | INV-4 | T-018 |
| `test_cancelJob_frontRunBySubmit_fallsBackToSync` | N7 | provider zero-budget `submit` in the same block before `cancelJob` → `JobNotCancellable(Submitted)`; `syncJob` then releases | INV-16 | T-018 |
| `test_ownerAction_cancelJob` | H2 | `executeOwnerAction(CANCEL_JOB, abi.encode(jobKey))` cancels | — | T-019 |
| `test_fundJob_budgetChanged_reverts` | M1-b | provider raises the budget after `BudgetSet`; `fundJob(jobKey, oldBudget)` reverts `BudgetChanged(old, new)` | JOB-1 | T-018 |
| `test_fundJob_zeroBudget_reverts` | R2 | `fundJob(jobKey, 0)` reverts (`0 < b` required; Circle's `fund` would accept 0) | JOB-1 | T-018 |
| `invariant_unfundedJobsAlwaysRelease` | H1, H2 | fuzz provider actions (`setBudget` any value, `submit` any time, nothing) and evaluator actions; every unfunded job reaches `Released` without `forceCloseEnvelope` | INV-16 | T-021 |

### 3.8 Named regression tests: off-chain fixes from the G0-01 review

The off-chain fixes are proven by tests named in their component specs; this index lists them so every review finding maps to at least one test or invariant.

| RV | Tests | Defined in |
|---|---|---|
| RV-004, RV-007, RV-013, RV-017, RV-028, RV-032, RV-055 | `signer_*` and `gasRefill_keepsK3K7K8WithinBounds` | `S04/server-autonomy-roi-keys.md` CZ-27 §14 |
| RV-004, RV-007, RV-012, RV-022, RV-023, RV-025, RV-041, RV-042 | `payer_*`, `pullback_fullBalanceDrain_valuePlusFeeFitsBalance` | `S04/server-planning-and-payment.md` CZ-15 §14 |
| RV-003, RV-018, RV-022 | `planner_*` | CZ-13 §14 |
| RV-019, RV-020, RV-021, RV-027, RV-043, RV-050 | `pay_*`, `mcpPay_*`, `mcpQuote_*`, `objectiveStatus_onlyCanonicalValuesStored`, `modelProxy_sameKey_409NoReplay` | CZ-12 §14 |
| RV-019, RV-021 | `mcp_payLoop_stopsAtExpectedCalls`, `mcp_payInput_secretAndPiiFixtures_neverSent` | `S04/local-agent-surfaces.md` CZ-09 §14 |
| RV-022 | `safeFetch` SSRF corpus | `S04/cross-cutting.md` §2.1 |
| RV-024 | deliverable mismatch → `reject` after re-fetches | CZ-16 §10, T-055 |
| RV-026 | demand-proof v2 contains no pseudonym and no bare `soulVersionHash` (schema test) | `S02/schemas/demand-proof-leaf.v2.schema.json`, T-057 |
| RV-029, RV-054 | the amended scenario stages | `S04/phase-1-acceptance-scenario.md` |
| RV-040 | `hook_daemonDown_queueHasNoSecretOrEmail` | `S04/local-observers-and-daemon.md` |
| RV-044 | approval screen refuses a fourth hidden payee | T-084 |
| RV-052, RV-051, RV-043 | rules-only compile; no hosted screen at intake; no model replay | T-066, T-063, T-065 |
| RV-057, RV-058, RV-061, RV-062 | fault-injecting RPC proxy; hardfork pin; vector executes; G0-16 record | T-010/T-030, T-003, T-023, G0-16 |

## 4. Deployment

| Step | Detail |
|---|---|
| 1 | Deploy `OpenEvidenceLog` through Arachnid CREATE2 (`0x4e59b44847b379578588920cA78FbF26c0B4956C`, A9-15) with a fixed salt; same address on both networks. |
| 2 | Deploy `CzarVaultFactory` through CREATE2 with constructor args: network immutables (USDC, GatewayWallet, GatewayMinter, domain 26, job escrow address and kind), initial `defaults` (agent K3, autonomy K5, evaluator K7 addresses from the signer service's local keystore, D70/D78, created by task T-105 before T-027, RV-016), guardian (K6), admin (K20, Ownable2Step pending). |
| 3 | Admin accepts ownership. There is no version registration step: the factory deploys only the vault bytecode compiled into it (D73, RV-015; the earlier "register version 1 without timelock" step is superseded). Publish `VAULT_CREATION_CODE_HASH`. |
| 4 | Publish bytecode hashes (`creationCodeHash`, runtime code hash of a reference vault) and verified sources on the Arc explorer (testnet API keyless, A9-10; mainnet needs a key, A9-11). |
| 5 | Pre-mainnet: deploy `CzarJobEscrow` proxy with Czar admin timelocks; then a new factory version whose immutables point to it. |
| 6 | Phase 2: `BuilderEscrow`, `RecipeSplits`. |
| 7 | Indexer: subscribe to `Upgraded(address)` on USDC proxy `0x3600…0000` (admin slot per A1-01), GatewayWallet and GatewayMinter proxies, ERC-8183 proxy, ERC-8004 registries (A5-11); page `eth_getLogs` ≤ 9,999 blocks (A9-06); halt the affected path on any event. |

Constructor arguments are recorded per network in the build plan; `maxFeePerGas ≥ 20 Gwei` on every deployment transaction (p1-A6).

## 5. Pre-mainnet checklist

- [ ] External audit of `CzarVault`, `CzarVaultFactory`, adapter and `CzarJobEscrow` configuration (and the deployed base-contracts commit).
- [ ] A2-G2: explain the GatewayWallet mainnet/testnet code-hash difference (rebuild from source at the verified commit, or obtain Circle's confirmation).
- [ ] A2-G3: prove a delegate/contract burn intent on mainnet with a minimal amount after audit, or keep the pocket path testnet-only at launch.
- [ ] AR-4: `cast call` `authorizationState` on mainnet USDC with a known nonce (simulation already shows it, A1-11).
- [ ] AR-3: rerun the `/verify` check against mainnet (`network: eip155:5042`) with a mainnet-deployed vault and no funds at risk.
- [ ] AR-5: live pullback on mainnet with ≤ 1 USDC.
- [ ] `Upgraded` alerts live for every pinned dependency; runbook for halting each path.
- [ ] Gas table measured on mainnet; routing parameters updated.
- [ ] Guardian and admin keys in separate custody (Phase 1 keeps them on one Mac as an accepted testnet exception, D80; dual control arrives with Cloud KMS, `stage-2-backlog.md` §6); pause drill performed.
- [ ] `CzarJobEscrow`: `claimRefund` not blocked by pause, `emergencyWithdraw` removed or limited to non-escrowed surplus, pause and withdraw roles split behind the timelock (RV-038; `czar-job-escrow.md` §2, CJE-3).

## Change log

| Date | ID | Change |
|---|---|---|
| 2026-10-19 | G0-01 review | Threat model rows for RV-002/003/013/014/015/063; invariant ranges INV-1…15, FAC-1…5, OEL-1…6; §3.1–§3.3 updated; §3.7 named contract regression tests; §3.8 off-chain regression tests; deployment steps 2–3 (D73, T-105, D78); pre-mainnet checklist (D80, RV-038). |
| 2026-10-20 | H1, H2, M1-b, N7 | Threat rows; JOB-5 / INV-16; tests in §3.8. |
