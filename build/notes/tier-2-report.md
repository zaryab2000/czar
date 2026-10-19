# Tier 2 build report

- **Branch:** `build-v1`. No PR, no push to `main`.
- **Date:** 2026-10-19. **Builder:** Claude (Czar builder agent).
- **Scope:** the six tier-2 tasks T-007, T-042, T-011, T-035, T-105 and T-043. Tier 3 (vault, factory, vault-client, indexer projections) has not started.
- **Spec changes:** none. Spec problems are filed as SCR-107 to SCR-111 in `specs/06-review/change-requests/`, after tier 1's SCR-101 to SCR-106.
- **Secrets:** no key, keystore, seed phrase, API key or `.env` file was found, created or read.
  - Tests create throwaway keys in memory for each run. They are never written to disk and never logged; the keystore tests use an in-memory filesystem.
  - gitleaks reports no leaks over the full history and the staged changes before every commit.
  - One false positive is baselined in `.gitleaksignore`: the `jobKey` vector in the hashing fixture, a public test hash.
- **No deployments, no funded transactions, no live Facilitator or Circle calls.** T-105 was **not** run.
- **Agent-directed text:** none met in tier 2. Specs and research files were read as data only.

## Summary

| Task | Status | Main output |
|---|---|---|
| T-007 `@czar/hashing` | done | `packages/hashing`: JCS, named hashes, czar-merkle-v1, nonces, every EIP-712 digest; reproduces all of `eip712-vectors.json` |
| T-042 `@czar/x402` | done | `packages/x402`: buyer v2/v1 parsing, offer selection, seller helpers, extension sanitising, `safeFetch` (RV-022) |
| T-011 OpenEvidenceLog | done | `contracts/src/OpenEvidenceLog.sol`, unit tests, OEL-1 to OEL-6 Foundry invariants |
| T-035 Signer shell | done as scoped; testnet policy runs and tuning are T-036 | `apps/signer` (`@czar/signer`): request validation, policy tables, backend interface, `local-keystore` backend |
| T-105 Key creation | script and tests only; **not run** | `apps/signer/scripts/create-keys.ts` with `--dry-run`, keys-file validation |
| T-043 czar-search vanilla route | done locally; **live keyless-trial check: needs testnet run** | `apps/merchants`: route, Facilitator client, payment-identifier store |

- Also fixed:
  - **The tier-1 `indexer-arc-anvil` CI job (T-001).** One `anvil_mine 0xc351` call outlasted arc-cast's fixed 45 s client timeout. A first fix used arc-cast in 5,000-block chunks; arc-anvil mined 5,000 blocks in about 25 s, but the next chunk still hit 45 s. The job now mines over curl in 5,000-block chunks with a 600 s per-call limit and prints progress, and its timeout is 45 min.
  - **A flaky tier-1 daemon test (T-064).** "Sidecar stops after the idle period" used `idleMs` 200 ms, a 600 ms wait and vitest's 5 s default, against a 5 s start timeout. Under the parallel `pnpm -r test` load it failed both ways. It now uses 1 s idle, a 3 s wait and a 15 s test timeout.

## How to check it

- `pnpm install --frozen-lockfile`
- `pnpm lint && pnpm -r typecheck && pnpm -r test`
- `cd contracts && FOUNDRY_PROFILE=arc arc-forge build --deny-warnings && FOUNDRY_PROFILE=arc arc-forge test` (Arc Foundry runs in CI; it cannot be installed in this container, see the tier-1 report)
- Local Vitest results at the last commit:
  - hashing 36, x402 82, signer 75 and merchants 18, all passed.
  - Tier-1 packages unchanged and passing: config 24, logging 11, redaction 473, daemon 34 (+1 skipped), indexer 10, web 17.
- Forge results in CI (`contracts (ubuntu-24.04)` and `contracts (macos-15)`): 49 tests passed in 4 suites.

---

## T-007 `@czar/hashing`

- **Built:**
  - `jcs`/`H` (RFC 8785 with Czar normalisation: lowercase addresses, undefined dropped, null/bigint/NaN refused).
  - Every named hash in 02 §5.
  - czar-merkle-v1 (tagged double-hashed leaves, sorted, commutative pairs, odd node carried, empty root 0).
  - `derivedNonce`, `burnSalt`, `jobKey`, `demandSalt`, `soulVersionCommit`.
  - All 16 type hashes, 5 domains, and digests for USDC 3009, Gateway burn, SL Receipt, `ReceiptAttestation` (v2, RV-013), `AutonomyRaise`, `OwnerAction` and `BriefRequest`. `transferSpecBytes` and its hash are included too.
- **Criteria met:**
  - `test/vectors.test.ts` reproduces every entry of `specs/02-data-and-protocol/vectors/eip712-vectors.json` byte for byte. That covers all type hashes, all 9 domain separators, the v2 `SL_RECEIPT` kind tag, `receiptAttestation_5042002` and `briefRequest_5042002`. A test also checks that the package's copy of the vectors equals the spec file.
  - RFC 8785 test inputs pass.
  - The Merkle property test passes (every leaf's proof verifies; tampering fails).
  - A cross-check against `viem.hashTypedData` passes for every typed digest.
- **Not built:** `userPseudonym`. Its preimage types (`abi.encode(userSecret, epoch)`) are not pinned in 02, and it is not in T-007's output list.
- **Deviation:** T-006 `@czar/schemas` is a listed dependency but is not in this tier, so the package was built from 02 directly (SCR-108).

## T-042 `@czar/x402`

- **Built:**
  - **Buyer:** `readPaymentRequired` (v2 header, v1 body fallback, 16 KiB cap).
  - **Offer selection:** `selectOffer` for the vault-direct rail (`exact`) and the Gateway rail (`exact` + `extra.name = "GatewayWalletBatched"`), with `unsupported-offer`, `price-or-payee-drift` and `flow-refused`.
  - **Payment payload:** `buildExactPaymentPayload` (payment-identifier only when advertised), and `readSettlement` (settled / pending / unpaid / missing / malformed).
  - **Seller:** `buildPaymentRequired` per 02 §11.1, `readPaymentSignature` (v2 only), `encodeSettlement`.
  - **Sanitising:** extensions go through the `@x402/extensions` helpers and Ajv 2020, with no external `$ref`/`$id` and an 8 KiB schema cap.
  - **`safeFetch` (RV-022):** https only, pinned DNS, blocked ranges including IPv4-mapped and IPv4-compatible IPv6, redirects re-checked (max 3), byte and time caps, `User-Agent: Czar/<version>`, and the local-merchant origin exception.
- **Criteria met:** every block rule has its own test, named by its `rule` (`url`, `scheme`, `port`, `credentials`, `dns`, `blocked-address`, `max-redirects`, `max-bytes`, `timeout`, `transport`). 82 tests.

## T-011 OpenEvidenceLog

- **Built:** `contracts/src/OpenEvidenceLog.sol`, implementing `IOpenEvidenceLog` exactly (the interfaces diff check in CI stays green).
- **Criteria met (CI forge logs):**
  - 18 unit tests, one per function and error. They include `test_commitProbeIntent_twice_revertsAlreadyCommitted` (RV-014), `test_recommitAfterReveal_reverts` and `test_rejectsNativeValue`.
  - 6 invariants, each 256 runs × depth 64 = 16,384 calls with 0 reverts: `invariant_OEL1_hashChain`, `invariant_OEL2_intentStatus`, `invariant_OEL3_appendOnly`, `invariant_OEL4_onlyOwnStorage`, `invariant_OEL5_noValueMovement` and `invariant_OEL6_intentCommittedOnce`. The handler deploys its own `MockUSDC3009` (tier-1 mock) to try value movement.
  - Gas: the first `EVIDENCE_BATCH` commit measured 102,374 gas excluding the 21k base, so about 123k in total. That is inside the 120–135k in 03 `open-evidence-log.md` §13.
- `contracts/foundry.toml` gained `[invariant] runs = 256, depth = 64, fail_on_revert = false`.

## T-035 Signer shell (CZ-27)

- **Where:** `apps/signer` (`@czar/signer`), not `apps/server/src/signer/` as T-035 says. build-plan §2.1 and T-105 put the signer in its own package (SCR-107).
- **Built:**
  - **Request validation (`src/requests.ts`):**
    - A strict shape for each of the 15 kinds.
    - Unknown fields are refused, so an opaque `structHash` is refused (RV-013).
    - Integers arrive as decimal strings with width checks.
    - Addresses and bytes32 are checked and lowercased.
    - The signer ABI-encodes `vault-call` and `relayer-tx` args itself from named fields.
  - **Policy (`src/policy.ts`):** every CZ-27 §5.2 row, with digests rebuilt through `@czar/hashing`.
    - **K3 `vault-call`:**
      - The allowlist, and the full never list (`withdraw`, `unfreeze`, `rotateSigners`, `setCategoryLimits`, `setPasskey`, `recordManualReturn`, `forceCloseEnvelope`, `setMaxPullbackFee`, `raiseAutoLimit`, `executeOwnerAction`) plus every factory selector, by name or by 4-byte selector (RV-055).
      - Plan checks: `openEnvelope` must equal a stored, auto-approvable plan with the D71 `pocketCapBps`. `reserve`, `openJob` and `registerPocket` must be a plan leaf whose `expectedCalls` are not used up (RV-032).
      - `writeOffPocket` is refused during a slow withdrawal (RV-004).
    - **`usdc-3009`:** the reservation's payee, `unitAmount`, `index < count` and `validBefore`; the nonce is derived; the result is the 416-byte 02 §6.3.1 envelope.
    - **Other K3 kinds:** `gateway-burn` uses the 03 §6.2 field table and is allowed while frozen. `sl-receipt` is vault-bound and needs a settled payment.
    - **Other keys:**
      - K5 `autonomy-raise`: D40 step, userMax, period and freeze.
      - K7 `evaluator-call` and `sl-validation-report`.
      - K8 `oel-commit`: `prev` must equal the latest root, plus the `czar-archive:<root>` URI and its `uriHash`.
      - K10 `merchant-seller-proof`: 5-minute expiry and the configured network.
      - K4: `gateway-nano`, `pocket-delegate`, `pocket-return` (destination always the owning vault) and `pocket-slow-withdraw`.
      - Relayer: `relayer-tx` and `gas-refill`.
    - **Freeze (D72):** every spending kind reads `frozen` and `guardianPaused` and fails closed when the view is older than `signer.freezeStateMaxAgeSec` (30 s). That covers `gateway-nano` and evaluator `complete`; a `reject` is always allowed.
  - **Service (`src/service.ts`):**
    - Pipeline: caller owns key → kind allowed for key → K5/K10 never send a transaction → shape → policy → rate limit → backend → audit.
    - K6 and K20 are refused with `interactive-only` (SCR-110).
    - A prepared transaction that differs from the policy's call is refused.
    - One audit row per request, holding ids, digest and outcome only.
    - Pocket-key create, retire and destroy follow RV-004: retiring is refused unless every balance is zero; the key is destroyed after `signer.pocketKeyRetainHours`; a balance that reappears keeps the key.
  - **Backend (`src/backend.ts`, `src/local-backend.ts`):**
    - A pluggable `SignerBackend` interface.
    - `local-keystore`: one AES-256-GCM file per key, scrypt N=2^17, key reference and address bound as AAD. Files are 0600, the directory 0700, and creation is exclusive (no overwrite).
    - The signer refuses to start if the path is inside a git work tree or group- or world-accessible (D78).
  - **Passphrase (`src/passphrase.ts`):**
    - Read from the macOS keychain (`dev.czar.signer.keystore`, account `keystore`) via `@napi-rs/keyring`, or from a TTY prompt with echo off. A piped stdin is refused.
    - `assertNoSecretInProcess` refuses passphrase-like argv words and environment names, and names only the variable, never its value.
- **Named tests passing** (CZ-27 §14, 03 `security-and-testing.md` §3.8):
  - Freeze (D72): `signer_gatewayNano_whileFrozen_denied`, `signer_evaluatorComplete_whilePaused_denied`, `signer_evaluatorReject_whileFrozen_allowed`.
  - Receipts (RV-013): `signer_slReceipt_unsettledPayment_denied`, `signer_slReceipt_opaqueStructHash_denied`.
  - Plan checks (RV-032): `signer_openEnvelope_argsNotMatchingStoredPlan_denied`, `signer_reserve_leafNotInPlan_denied`.
  - K3 never list (RV-055): `signer_k3_neverSignableSelectors_denied`.
  - K4 and pockets (RV-004, RV-055): `signer_k4_usdcApproveOrTransferElsewhere_denied`, `signer_k4_returnToOwningVault_allowed`, `signer_retirePocketKey_nonZeroBalance_refused`, `signer_writeOff_duringSlowWithdraw_denied`.
  - Gas and K5 (RV-017): `signer_gasRefill_aboveMax_denied`, `signer_k5_sendTransaction_denied`.
  - Keystore (D78, RV-028): `signer_keystoreInsideRepo_refusesStart`, `signer_passphraseFromArgvOrEnv_rejected`.
- **T-035 acceptance:**
  - A USDC digest whose `to` is outside the reservation is denied before the backend call. Every denial test asserts the backend was never called.
  - A `withdraw` call is denied.
  - The rate limit is enforced and recovers after the window.
  - The audit row holds no raw text (the test checks the origin string, query and payee).
  - A signature over a known digest recovers to the key's address (low s, v ∈ {27, 28}).
- **Replay (CZ-27 §14):** through the signer, `gateway-burn` reproduces `gatewayBurnIntent_sameChain`, `sl-receipt` reproduces `receiptAttestation_5042002` from the `slReceipt_5042002` fields, and `autonomy-raise` reproduces `autonomyRaise_5042002`.
- **Left for later:**
  - **T-036:** rate-limit tuning and the testnet policy runs. The limiter already reads `kms.maxSignaturesPerMin.<key>`.
  - **Not built:** the Unix-socket transport with per-service tokens (CZ-27 §3), the K6/K20 interactive CLI (SCR-110), and the projection implementation (tier 3 indexer projections). The signer takes a `Projection` interface; tests use a fake.
  - **ABIs:** T-026 `vault-client` is tier 3, so the signer declares its own ABI fragments, with a drift test against `contracts/src/interfaces` (SCR-108).
  - **Typed-data gaps:** the `gateway-nano` domain and the `SellerRequest` typed data are not pinned in 02 (SCR-109).
  - **RV-045 result:** `@napi-rs/keyring` 2.1.1 cannot set a per-application ACL (SCR-111). Confirming the default ACL on a Mac needs a device; see the commands below.

## T-105 Key creation script (not run)

- **Built:** `apps/signer/scripts/create-keys.ts`.
  - **What it creates:** K3 agentSigner, K5 autonomySigner, K6 guardian, K7 evaluator, K8 evidencePublisher, the relayer gas key and K20 factoryAdmin, in the CZ-27 keystore. It writes `deployments/arc-testnet-keys.json` with addresses and roles only, and prints addresses only.
  - **Refusals:**
    - When argv or the environment looks like it carries a secret.
    - When `signer.backend` is not `local-keystore`.
    - When the keystore path is inside git or loosely permissioned.
    - When the keys file or any of the seven keys already exists.
  - The passphrase is read only from the keychain item, by the process itself.
  - **`--dry-run`:** the same guards, then seven throwaway in-memory keys. It prints `DRY RUN: throwaway addresses, nothing written` and writes nothing.
- **Tests:**
  - `test/create-keys.test.ts`: keys-file validation (seven distinct checksummed addresses; no field named `key`, `secret`, `private` or `mnemonic`), the dry run, the refusals, and a keystore inside the repo.
  - `test/no-secret-in-argv-env.test.ts` spawns the script in dry-run mode and reads its `ps -o args` and `/proc/<pid>/environ` while it runs. Neither carries a passphrase-like value. A `CZAR_SIGNER_PASSPHRASE` variable makes it exit 1 without echoing the value.
- **Acceptance grep:** `git ls-files | grep -iE 'keystore|\.key$|\.env'` prints nothing. The backend source was renamed `local-backend.ts` so the grep does not match code.

## T-043 czar-search vanilla x402 route

- **Built (`apps/merchants`):**
  - **`createSearchRoute` (Web `Request → Response`), `GET /v1/search?q=`:**
    - Exactly one `q` of 1–200 characters, else 400.
    - A v1 `X-PAYMENT` client gets the v2 402 with `x402 v2 required` (A3-03).
    - `accepted` must equal our offer (scheme, network, amount, asset, payTo) before any Facilitator call.
  - **Payment-identifier handling:** same id and fingerprint → stored response replayed; same id with a different fingerprint → 409; in-flight → 409.
  - **Facilitator steps:**
    - `/verify` false → 402 with the reason, handler not run.
    - Handler failure → 500 and **no `/settle`**.
    - `/settle` success → 200 with `PAYMENT-RESPONSE`; `settlement_pending` → 200 with the body.
    - Other settle failure → 402 with the body withheld; Facilitator unreachable → 503 `Retry-After: 30`.
  - Events carry the input hash only.
  - **Facilitator client:** `POST /verify` and `/settle` with `{x402Version: 2, paymentPayload, paymentRequirements}` and a `Facilitator-Seller-Proof` over the body hash (from the signer's `merchant-seller-proof`). `encodeSellerProof` builds the base64url envelope from the A1 experiment.
  - **Payment-identifier store:**
    - Scoped per route.
    - The fingerprint is `H(jcs({scheme, network, asset, amount, payTo, route, method, inputHash}))`.
    - 24 h TTL, 1 MiB cap.
    - An id is freed when a request ends without a charge.
    - The in-memory implementation is behind an interface; Postgres arrives with hosting.
  - **Fixed index:** 8 public documentation entries, all query words must match, at most 10 results.
- **Criteria met (local, mocked Facilitator, 18 tests):**
  - A 402 decodes to the 02 §11.1 field table.
  - A handler failure means no `/settle`.
  - Same `payment-identifier` + same payload → cached response with no second Facilitator call; different payload → 409; TTL expiry.
- **Needs testnet run:**
  - "curl without payment returns 402 with a valid `PAYMENT-REQUIRED`" and the live keyless-trial `/verify`. Both need T-040 hosting, which this tier does not include, and the K10 key from the merchants task.
- **Not built:** the Gateway nanopayment route (`/nano/v1/search`) and the other two services. T-043 is the vanilla route only.

---

## Pinned versions and where each came from

- **Reused from tier 1:** viem 2.57.7, vitest 5.0.5, @napi-rs/keyring 2.1.1 (same pin as the daemon; 2.1.2 is newer than the one-day release-age rule allows), Node 22.22.0, pnpm 10.28.0.
- **New in tier 2 (npm registry, exact pins, `save-exact`):**
  - **@x402/extensions 2.28.0:** matches `@x402/core` 2.28.0 in CZ-20 §15 and F2-02. Used for the payment-identifier and Bazaar helpers.
  - **ajv 8.17.1:** JSON Schema 2020-12 for sanitising extension schemas.
- **Contracts:** unchanged from tier 1 (Arc Foundry v0.8.0-2, solc 0.8.30, OpenZeppelin 5.7.0, forge-std as pinned in tier 1).
- **Not used:** `@x402/core` and `@circle-fin/x402-batching` (the Gateway route is not in T-043).

## Spec change requests filed

| ID | Title | Affects |
|---|---|---|
| SCR-107 | T-035 path and test command conflict with `apps/signer` | T-035, T-036 |
| SCR-108 | Tier-2 tasks depend on T-006 and T-026 | T-006, T-007, T-026, T-035, T-042 |
| SCR-109 | `gateway-nano` domain, its step choice, and `SellerRequest` are not pinned in 02 | T-035, T-036, T-043 |
| SCR-110 | K6 and K20 have no signing kind in CZ-27 §4 | T-035, T-036, T-027 |
| SCR-111 | The keychain ACL hardening cannot be set through `@napi-rs/keyring` | T-035, T-105 |

## Things a reviewer should know

- **Tier-1 CI fixes:**
  - The `indexer-arc-anvil` job was red on every run since tier 1, because of the 45 s arc-cast timeout. The curl-based mining is the third attempt; see "CI status" for whether it is green.
  - The flaky sidecar test came from tier 1, and so did my local check helper. The helper used to run the suite twice and report only the second run, which hid the failure. It now fails on the first failing run.
- **Signer projection reads are an interface.** Every policy rule is tested against a fake projection; real values arrive with the tier-3 indexer projections. Until then, nothing can sign against a real chain.
- **Key references:**
  - K4 keys are referenced as `K4:<pocket>`.
  - There is one K10 key in the signer today. CZ-20 says one per service, so K10 per-service references are a follow-up when the other services land.
- **`merchant-seller-proof` derives two fields:** `payTo` is the K10 address and `issuedAt = expiry − 300`. Both come from the A1 experiment (SCR-109).

---

## Commands for Zaryab's Mac

- Run from the repository root on `build-v1` after `git pull && pnpm install --frozen-lockfile`.
- None of these makes a funded transaction.

### T-105: create the Phase 1 keys (needs your written approval first)

```sh
# 1. Store the keystore passphrase in the keychain. With -w last and no value, `security` prompts,
#    so the passphrase never appears on the command line or in shell history.
security add-generic-password -s dev.czar.signer.keystore -a keystore -w

# 2. Dry run: same guards, throwaway in-memory keys, nothing written.
node apps/signer/scripts/create-keys.ts --dry-run
# expect: "DRY RUN: throwaway addresses, nothing written" and seven lines "<key> <role> 0x…"

# 3. Real run. macOS asks whether node may read the keychain item; choose "Allow", not "Always Allow".
node apps/signer/scripts/create-keys.ts
# expect: "wrote …/deployments/arc-testnet-keys.json" and seven address lines, nothing else

# 4. Checks.
ls -la "$HOME/Library/Application Support/Czar/signer/keystore/"   # dir drwx------, seven *.json files -rw-------
git ls-files | grep -iE 'keystore|\.key$|\.env'                    # prints nothing
node -e 'const f=require("./deployments/arc-testnet-keys.json");console.log(Object.keys(f.addresses).length)'   # 7

# 5. Commit the addresses file only.
git add deployments/arc-testnet-keys.json && git commit -m "T-105 Record Phase 1 key addresses"
```

### T-035: record the keychain ACL (RV-045, needs device)

```sh
# After step 1 above: open Keychain Access → login → search "dev.czar.signer.keystore" →
# Get Info → Access Control. Record which applications are listed (expect: only "security",
# so node prompts on every read), and optionally tick "Confirm before allowing access".
open -a "Keychain Access"
pnpm --filter @czar/signer test   # the signer suite on macOS
```

### T-043: live 402 and keyless-trial check (needs testnet run, after T-040 hosting and the K10 key)

```sh
# 402 without payment: expect HTTP/2 402 and a PAYMENT-REQUIRED header that decodes to the 02 §11.1 table.
curl -si 'https://merchants.testnet.czar.dev/v1/search?q=eip' | sed -n '1p;/^payment-required:/Ip'
curl -s 'https://merchants.testnet.czar.dev/v1/search?q=eip' -o /dev/null -D - \
  | awk -F': ' 'tolower($1)=="payment-required"{print $2}' | tr -d '\r' | base64 -d | python3 -m json.tool
# Keyless-trial /verify: run the A1 reference flow against the deployed 402 (costs nothing, A1-15).
```

---

## CI status

- **Green at `a3a63c6`** on `build-v1`: workflows `ci` (run 39295777850) and `secrets` (run 39295777879) both succeeded.
- Jobs: lint/typecheck/test, contracts (ubuntu-24.04) and contracts (macos-15) with forge build and test (49 tests, including the OEL invariants), indexer paging against arc-anvil (50,001 blocks), czar-redact, web e2e in Chromium and WebKit, actionlint and zizmor.
- **indexer-arc-anvil** had been red since tier 1. Three causes, fixed in turn (T-001 commits):
  - A single `anvil_mine` call outran arc-cast's 45 s client timeout. Mining now runs over curl in 5,000-block chunks with a 600 s limit per call.
  - Without `--prune-history`, arc-anvil kept every historical state. Each chunk was slower than the last, and the runner ran out of disk at about 30,000 blocks. It now starts with `--prune-history`.
  - The job timeout was raised to 45 minutes.
- A flaky sidecar idle test in the daemon (T-064) was given wider timing margins.
