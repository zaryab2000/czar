# Phase 1 tasks (spec 05)

- **Date:** 2026-10-18. **Status:** ready once Gate 0 passes (`gate-0-checks.md`). Milestones, entry criteria and exit gates: `build-plan.md` §5.
- **Every agent follows `builder-agent-rules.md`.** A task never changes a spec; spec problems go through `spec-change-request-template.md`.
- **Path shorthands:** `S01/` = `specs/01-system-architecture/`, `S02/` = `specs/02-data-and-protocol/`, `S03/` = `specs/03-smart-contracts/`, `S04/` = `specs/04-components/`, `S05/` = `specs/05-build-plan/`. Code paths follow the monorepo layout in `S04/cross-cutting.md` §1.
- **How to read a task:**
  - **Spec refs** are the source of truth. Read them all before coding.
  - **Inputs** must exist before the task starts. **Outputs** are what the task creates.
  - **Acceptance tests** are commands with an expected result. The task is done only when all of them pass and the task report lists them.
  - **Who:** "agent" runs alone. "agent, after Zaryab approves …" waits for written approval in the task report thread. "Zaryab" is a human step.
- **Size:** S = half a session or less; M = one session; L = one long session. Anything bigger is split before it starts.
- **Network:** local `arc-anvil --network arc`, an `arc-anvil` fork of Arc testnet, or live Arc testnet (`eip155:5042002`, `https://rpc.testnet.arc.io`). Never mainnet.
- **Money tasks** (anything that reserves, signs, pays, settles, funds, pulls back or refunds) write tests first and include a kill-and-resume recovery test.

## Summary

| ID | Title | Milestone | Size | Deps |
|---|---|---|---|---|
| T-001 | Repo scaffold | M0 | M | G0-12 |
| T-002 | CI and security scanning | M0 | M | T-001 |
| T-003 | Contracts toolchain | M0 | M | T-001, G0-10 |
| T-004 | `@czar/config` | M0 | S | T-001 |
| T-005 | `@czar/logging` | M0 | S | T-001 |
| T-006 | `@czar/schemas` | M0 | M | T-001 |
| T-007 | `@czar/hashing` | M0 | M | T-006 |
| T-008 | `@czar/redaction` layer 1 | M0 | M | T-001 |
| T-009 | OpenAPI contract-test harness | M0 | S | T-006 |
| T-010 | Contract test mocks | M1 | M | T-003 |
| T-011 | `OpenEvidenceLog` | M1 | M | T-003 |
| T-012 | `CzarVaultFactory` | M1 | M | T-003 |
| T-013 | Vault core | M1 | L | T-010, T-012 |
| T-014 | Envelopes | M1 | M | T-013 |
| T-015 | Reservations | M1 | L | T-014 |
| T-016 | `isValidSignature` (USDC, fallback, receipt) | M1 | L | T-015, T-007 |
| T-017 | Pockets and `GATEWAY_BURN` | M1 | L | T-016 |
| T-018 | Job adapter and job functions | M1 | L | T-014 |
| T-019 | Earned autonomy and passkey owner actions | M1 | L | T-014 |
| T-020 | Size build (D42) | M1 | S | T-017, T-018, T-019, G0-08 |
| T-021 | Fuzz and invariant suites | M1 | L | T-020, T-011 |
| T-022 | Fork tests | M1 | L | T-020 |
| T-023 | On-chain vector reproduction | M1 | S | T-020, T-007 |
| T-024 | Gas snapshot and gas table | M1 | S | T-020 |
| T-025 | Slither and static checks | M1 | M | T-020 |
| T-026 | `@czar/vault-client` | M1 | L | T-020, T-007 |
| T-027 | Testnet deployment | M1 | M | T-021..T-026 |
| T-030 | Indexer setup | M2 | M | T-027 |
| T-031 | Vault and factory projections | M2 | L | T-030 |
| T-032 | External event ingestion | M2 | L | T-030 |
| T-033 | Alerts and halt flags | M2 | M | T-031, T-032 |
| T-034 | Indexer query API | M2 | M | T-031, T-032 |
| T-035 | Signer service | M2 | L | T-026, G0-13 |
| T-036 | KMS policies on testnet | M2 | M | T-035, T-027 |
| T-037 | Pocket key lifecycle | M2 | M | T-035 |
| T-040 | Testnet hosting | M3 | M | T-034, T-036 |
| T-041 | Server skeleton | M3 | L | T-006, T-009, T-004, T-005 |
| T-042 | `@czar/x402` | M3 | L | T-006 |
| T-043 | `czar-search` vanilla route | M3 | M | T-042, T-040, G0-04 |
| T-044 | Payment router | M3 | M | T-024, T-004 |
| T-045 | Planner core | M3 | L | T-041, T-042, T-044, T-007 |
| T-046 | Injection boundary | M3 | L | T-006, T-005 |
| T-047 | Acceptance checker minimal | M3 | M | T-006, T-007 |
| T-048 | Paying agent vault-direct | M3 | L | T-045, T-046, T-047, T-034, T-036 |
| T-049 | Receipts and evidence store | M3 | M | T-048 |
| T-050 | Thin slice on testnet | M3 | M | T-049, T-043 |
| T-051 | Merchants complete | M4 | L | T-050 |
| T-052 | Pocket loop | M4 | L | T-050, T-037 |
| T-053 | Pullback | M4 | L | T-052, G0-05 |
| T-054 | Job loop | M4 | L | T-050 |
| T-055 | ERC-8183 evaluator | M4 | M | T-054, T-056 |
| T-056 | Acceptance profiles complete | M4 | M | T-047 |
| T-057 | Evidence publisher | M4 | L | T-049, T-036 |
| T-058 | Third-party verification script | M4 | M | T-057 |
| T-059 | Multi-path testnet run | M4 | M | T-051..T-058 |
| T-060 | Daemon skeleton | M5 | L | T-004, T-005, T-006 |
| T-061 | Device pairing | M5 | S | T-060, T-041 |
| T-062 | Observer plugin | M5 | M | T-060, G0-11 |
| T-063 | Hook intake and memory | M5 | L | T-062, T-008 |
| T-064 | Presidio helper | M5 | L | T-060 |
| T-065 | Model proxy route | M5 | M | T-041 |
| T-066 | Soul compiler | M5 | L | T-063, T-064, T-065 |
| T-067 | Soul viewer | M5 | M | T-066 |
| T-068 | Drives engine | M5 | L | T-063, T-065 |
| T-069 | Objective publisher | M5 | M | T-068, T-064, T-061 |
| T-070 | Shadow mode | M5 | M | T-069, T-045 |
| T-071 | Quote, outcome and pay routes | M5 | M | T-048, T-045 |
| T-072 | MCP server | M5 | L | T-071, T-061 |
| T-073 | Write-back adapter | M5 | M | T-062, T-061 |
| T-080 | Web app scaffold (desktop browser) | M6 | M | T-001 |
| T-081 | Session and app read routes | M6 | M | T-041, T-034 |
| T-082 | Onboarding | M6 | L | T-080, T-081, T-026, G0-03 |
| T-083 | Notifications — **moved to stage 2 (D69)** | stage 2 | M | T-080, T-041 |
| T-084 | Approvals | M6 | L | T-082, T-045 |
| T-085 | Freeze and D60 lowering | M6 | M | T-084, T-048, T-034 |
| T-086 | Ledger and shadow screens | M6 | M | T-081, T-070 |
| T-087 | Secondary bundler fallback | M6 | S | T-082, G0-14 |
| T-090 | Selection Layer lite intake | M7 | L | T-041, T-051 |
| T-091 | Reputation and ranking | M7 | L | T-090, T-049 |
| T-092 | Planner with P-03 | M7 | M | T-091, T-045 |
| T-093 | MCP `find_service` wiring | M7 | S | T-091, T-072 |
| T-094 | Earned autonomy | M7 | M | T-071, T-036 |
| T-095 | ROI ledger | M7 | M | T-049, T-071 |
| T-100 | End-to-end harness | M8 | L | M3..M7 exits |
| T-101 | Scenario in CI on a fork | M8 | M | T-100 |
| T-102 | Scenario on live testnet (desktop browser) | M8 | M | T-101 |
| T-103 | Release security gates | M8 | M | T-101 |
| T-104 | Phase 1 sign-off | M8 | S | T-102, T-103 |

---

## M0 Foundations

### T-001 Repo scaffold: pnpm workspace, Node 22, strict tsconfig, oxlint/oxfmt, root .gitignore
- **Milestone / group / who:** M0 / M0-a / agent. **Size:** M. **Deps:** Gate 0 G0-12.
- **Spec refs:** `S04/cross-cutting.md` §1, §7; `S01/system-architecture.md` §17; `S05/gate-0-checks.md` G0-12.
- **Inputs:** an empty code repo.
- **Outputs:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.oxlintrc.json`, `.gitignore`, empty package folders `apps/*`, `packages/*`, `plugins/claude-code`, `contracts/`, `models/`, `CLAUDE.md` (copied from `S05/builder-agent-rules.md`).
- **Steps:**
  - Create the workspace with the package names in cross-cutting §1; ESM only; Node 22 LTS.
  - Turn on every strict tsconfig flag from the global standards; absolute imports via path aliases (`@czar/*`).
  - Set `pnpm config set minimumReleaseAge 1440` and `ignore-scripts true`; pin exact versions.
  - Root `.gitignore`: `*.key`, `*.key.json`, `.env*`, `keystore/`, `node_modules/`, `out/`, `cache/`.
- **Acceptance tests:**
  - `pnpm install --frozen-lockfile` succeeds.
  - `pnpm -r exec tsc --noEmit` and `pnpm oxlint` pass with 0 warnings.
  - `git ls-files | grep -E '\.key$|\.key\.json$|\.env'` prints nothing.

### T-002 CI: pinned actions, gitleaks secret scan, zizmor, lint/type/test jobs
- **Milestone / group / who:** M0 / M0-a / agent. **Size:** M. **Deps:** T-001.
- **Spec refs:** `S03/security-and-testing.md` §3.6; `S04/cross-cutting.md` §7 (gitleaks v8.30.1, C2-06); `S05/gate-0-checks.md` G0-12; A9-13 (no `foundry-toolchain` in CI).
- **Inputs:** T-001 workspace.
- **Outputs:** `.github/workflows/ci.yml`, `.github/workflows/secrets.yml`, `.github/dependabot.yml`.
- **Steps:**
  - Pin every action to a full SHA with a version comment; `persist-credentials: false`.
  - Jobs: lint, type check, unit tests, gitleaks scan on every push and pull request.
  - Dependabot with 7-day cooldowns and grouped updates.
- **Acceptance tests:**
  - `actionlint .github/workflows/` and `zizmor .github/workflows/` report 0 findings.
  - A test branch with a planted fake key string fails the secret job; removing it passes.

### T-003 Contracts toolchain: arc-foundry v0.8.0-2 installer with sha256 check, Foundry project, solc 0.8.30 prague, OZ 5.7.0, interfaces copied from spec 03
- **Milestone / group / who:** M0 / M0-a / agent. **Size:** M. **Deps:** T-001, G0-10.
- **Spec refs:** `S03/czar-vault.md` header (solc 0.8.30, `prague`, OZ v5.7.0); `S03/security-and-testing.md` §3.4, §3.6; A9-12, A9-13, A9-14.
- **Inputs:** G0-10 result.
- **Outputs:** `scripts/install-arc-foundry.sh`, `contracts/foundry.toml` (`[profile.arc] network = "arc"`), `contracts/src/interfaces/*.sol` (byte copies of `S03/interfaces/*.sol`), `contracts/lib/openzeppelin-contracts` at v5.7.0.
- **Steps:**
  - Download the release tarball, verify `.sha256`, rename to `arc-forge`, `arc-cast`, `arc-anvil`; never `foundryup`.
  - Same script used in CI.
  - CI job builds contracts and fails on any warning.
- **Acceptance tests:**
  - `shellcheck scripts/install-arc-foundry.sh` clean; running it twice is idempotent.
  - `arc-anvil --version` shows commit `d497beea…` (A9-13).
  - `cd contracts && arc-forge build --deny-warnings` compiles 7 interface files.
  - `diff -r contracts/src/interfaces specs/03-smart-contracts/interfaces` shows no differences.

### T-004 @czar/config parameter registry
- **Milestone / group / who:** M0 / M0-b / agent. **Size:** S. **Deps:** T-001.
- **Spec refs:** `S04/cross-cutting.md` §3.2, §3.3; every component's "Named parameters" section in `S04/`.
- **Outputs:** `packages/config/` (registry, env overlay `CZAR_<SECTION>_<KEY>`, `czar config dump`).
- **Steps:**
  - One typed registry entry per parameter named in `S04/` with default, unit and reason.
  - Read-only mirrors of contract constants (for example `vault.maxAuthorizationsPerReservation = 128`, D39).
  - Unknown keys fail at startup.
- **Inputs:** workspace from T-001; parameter tables in `specs/04-components/*.md`.
- **Acceptance tests:**
  - `pnpm --filter @czar/config test` passes, including: unknown key → startup error; env overlay overrides a default.
  - A script greps `S04/*.md` for `` `<component>.<name>` `` parameter names and the test asserts each exists in the registry (0 missing).

### T-005 @czar/logging allowlist
- **Milestone / group / who:** M0 / M0-b / agent. **Size:** S. **Deps:** T-001.
- **Spec refs:** `S04/cross-cutting.md` §4; `S01/system-architecture.md` §16.3.
- **Outputs:** `packages/logging/`.
- **Steps:**
  - JSON lines with the fixed fields; drop any field outside the allowlist.
  - Truncate IPs; strip query strings from URLs.
- **Inputs:** workspace from T-001; allowlist in `specs/04-components/cross-cutting.md` §4.
- **Acceptance tests:**
  - `pnpm --filter @czar/logging test` passes a corpus test: goal text, soul text, file paths, emails and a merchant body are never emitted; redaction markers are kept.

### T-006 @czar/schemas: compile 02 schemas, validators, privacyClassOf, sender guard
- **Milestone / group / who:** M0 / M0-b / agent. **Size:** M. **Deps:** T-001.
- **Spec refs:** `S02/data-and-protocol.md` §2–§4; `S02/schemas/*.schema.json`; `S04/cross-cutting.md` §2.
- **Outputs:** `packages/schemas/` (generated types, Ajv 8 2020-12 validators, `privacyClassOf(name, field)`, `assertNoLocalOnly(obj)`).
- **Steps:**
  - Load all 19 schema files, including cross-file `$id` refs (`receipt` → `payment-ref`).
  - Generate TypeScript types; never hand-write a shape.
  - Sender guard rejects any `local-only` field on outbound objects.
- **Inputs:** workspace from T-001; `specs/02-data-and-protocol/schemas/*.schema.json`.
- **Acceptance tests:**
  - `python3 -I specs/02-data-and-protocol/schemas/check-schemas.py` reports 0 problems.
  - `pnpm --filter @czar/schemas test` passes: every invented example in `S02/data-and-protocol.md` §4 validates; an `ObjectiveSubmission` with an added `evidence` field is rejected by the guard.

### T-007 @czar/hashing: JCS, named hashes, czar-merkle-v1, nonce/salt; reproduce vectors
- **Milestone / group / who:** M0 / M0-c / agent. **Size:** M. **Deps:** T-006.
- **Spec refs:** `S02/data-and-protocol.md` §5, §6, §7.2, §7.3; `S02/vectors/eip712-vectors.json`.
- **Outputs:** `packages/hashing/` (JCS, `H()`, `objectiveHash`, `planHash`, `soulVersionHash`, `observationHash`, `reportHash`, `descriptionHash`, Merkle builder and proofs, `derivedNonce`, burn salt, EIP-712 digests).
- **Steps:**
  - RFC 8785 canonicalization with the normalization rules in §5.1.
  - Merkle: tagged double-hashed leaves, sorted-pair nodes, odd node carried up, empty root `0x00…00`.
  - Export the vectors file as a test fixture for T-023.
- **Inputs:** `packages/schemas` from T-006; `specs/02-data-and-protocol/vectors/eip712-vectors.json`.
- **Acceptance tests:**
  - `pnpm --filter @czar/hashing test` reproduces all type hashes, domain separators, the six digests, `transferSpecHash` and the derived nonce in `eip712-vectors.json` byte for byte.
  - A property test builds random trees and verifies every proof with the same rules as OpenZeppelin `MerkleProof.verify`.

### T-008 @czar/redaction layer 1 (vendored gitleaks v8.30.1 rules) and marker format
- **Milestone / group / who:** M0 / M0-b / agent. **Size:** M. **Deps:** T-001.
- **Spec refs:** `S04/local-observers-and-daemon.md` CZ-26; `S02/data-and-protocol.md` §3.1; C2-06, C2-07.
- **Outputs:** `packages/redaction/` (layer 1 rules, `[[R:S:<rule>]]` markers, layer-2 client interface for T-064).
- **Steps:**
  - Vendor `config/gitleaks.toml` at v8.30.1 (222 rules, MIT) and convert to TypeScript regexes.
  - Idempotent: redacting twice changes nothing.
- **Inputs:** workspace from T-001; gitleaks `config/gitleaks.toml` at v8.30.1 (vendored copy).
- **Acceptance tests:**
  - `pnpm --filter @czar/redaction test` passes the vendored gitleaks test corpus (every secret replaced with the right marker, no false hit on the clean corpus).
  - Never calls trufflehog or any live verification (grep test).

### T-009 OpenAPI contract-test harness for openapi.yaml and local-openapi.yaml
- **Milestone / group / who:** M0 / M0-c / agent. **Size:** S. **Deps:** T-006.
- **Spec refs:** `S02/api/openapi.yaml`; `S02/api/local-openapi.yaml`; `S02/data-and-protocol.md` §9.
- **Outputs:** `packages/api-contract/` (loads both files, resolves every `$ref`, builds request and response validators per `operationId`).
- **Inputs:** `packages/schemas` from T-006; `specs/02-data-and-protocol/api/openapi.yaml`, `api/local-openapi.yaml`.
- **Steps:**
  - Load both OpenAPI files and resolve every internal and file `$ref`.
  - Build a request and a response validator per `operationId`.
  - Expose a helper that route tests call with a recorded request and response.
- **Acceptance tests:**
  - `pnpm --filter @czar/api-contract test` parses both files, resolves every `$ref` (0 unresolved), and lists every `operationId` (37 in `openapi.yaml`, 6 in `local-openapi.yaml` at the time of writing).

---

## M1 Contracts

### T-010 Contract test mocks: USDC honouring ERC-1271 like NativeFiatTokenV2_2, Gateway mock, ERC-8183 mocks (both ABIs)
- **Milestone / group / who:** M1 / M1-a / agent. **Size:** M. **Deps:** T-003.
- **Spec refs:** `S03/security-and-testing.md` §3.3; `S03/czar-vault.md` §10; `S03/job-escrow-adapter.md` §2; A1-08, A1-09, A2-02, A2-04, A4-06.
- **Outputs:** `contracts/test/mocks/MockUSDC3009.sol`, `MockGatewayWallet.sol`, `MockGatewayMinter.sol`, `MockCircleAgenticCommerce.sol`, `MockCzarJobEscrow.sol`.
- **Steps:**
  - USDC mock: bytes overload `transferWithAuthorization`, `staticcall` to `isValidSignature`, nonce map, `validBefore`, pause and blacklist, as `EIP3009.sol` lines 84–143, 296–335.
  - Gateway mock: `depositFor`, `addDelegate`, `isAuthorizedForBalance`, `isTransferSpecHashUsed`.
  - ERC-8183 mocks with the exact Circle testnet ABI and the base-contracts ABI.
- **Inputs:** `contracts/` Foundry project and `contracts/src/interfaces/*.sol` from T-003.
- **Acceptance tests:**
  - `arc-forge test --match-contract MockSelfTest` passes: the USDC mock rejects a reused nonce, an expired authorization, and an `isValidSignature` that returns anything but `0x1626ba7e`.

### T-011 OpenEvidenceLog implementation and tests
- **Milestone / group / who:** M1 / M1-a / agent. **Size:** M. **Deps:** T-003.
- **Spec refs:** `S03/open-evidence-log.md` §1–§13 (SL §7.1 verbatim, invariants OEL-1..5, D54 `archiveUri` in §11).
- **Outputs:** `contracts/src/OpenEvidenceLog.sol`, `contracts/test/OpenEvidenceLogTest.t.sol`.
- **Steps:** tests first for `commit`, `reveal`, `PrevMismatch`, `UnknownIntent`, `AlreadyRevealed`, views; then the contract (no owner, no pause, no upgrade).
- **Inputs:** `contracts/` project and `contracts/src/interfaces/IOpenEvidenceLog.sol` from T-003.
- **Acceptance tests:**
  - `arc-forge test --match-contract OpenEvidenceLogTest` passes, one test per function and per error.
  - Gas for `commit` within the 120–135k estimate (§13) or the measured value is recorded.

### T-012 CzarVaultFactory implementation and tests
- **Milestone / group / who:** M1 / M1-a / agent. **Size:** M. **Deps:** T-003.
- **Spec refs:** `S03/czar-vault-factory.md` §2–§10; `S03/interfaces/ICzarVaultFactory.sol`; FAC-1..4; A9-15.
- **Outputs:** `contracts/src/CzarVaultFactory.sol`, `contracts/test/FactoryTest.t.sol`.
- **Steps:** tests first for `createVault`, `predictVault`, `pause`/`unpause`, version and guardian timelocks (48 h), `setDefaults`, Ownable2Step; the vault constructor is a stub until T-013.
- **Inputs:** `contracts/` project and `contracts/src/interfaces/ICzarVaultFactory.sol` from T-003.
- **Acceptance tests:**
  - `arc-forge test --match-contract FactoryTest` passes, including: second `createVault` for one owner reverts `VaultExists`; `applyVersion` before the eta reverts `TooEarly`; only the guardian can pause.

### T-013 CzarVault core: storage, roles, freeBalance/sync/withdraw, limits, freeze/unfreeze, rotateSigners, guardian read
- **Milestone / group / who:** M1 / M1-b / agent. **Size:** L. **Deps:** T-010, T-012.
- **Spec refs:** `S03/czar-vault.md` §2, §3, §4, §5.1, §9, §12; `S03/interfaces/ICzarVault.sol`; D33.
- **Outputs:** `contracts/src/CzarVault.sol` (core), `contracts/test/VaultCoreTest.t.sol`.
- **Steps:**
  - Constants and immutables exactly as §3 (USDC domain separator built in the constructor from `block.chainid`).
  - Role checks matching the §2 table; `ReentrancyGuardTransient` on every externally-calling function.
  - `freeBalance = balanceOf − committedTotal`; `withdraw` only up to `freeBalance`; `receive()` emits `NativeReceived`.
- **Inputs:** mocks in `contracts/test/mocks/` from T-010; `contracts/src/CzarVaultFactory.sol` from T-012; `contracts/src/interfaces/ICzarVault.sol`.
- **Acceptance tests:**
  - `arc-forge test --match-contract VaultCoreTest` passes, including a role-matrix test that tries every (role × function) cell from §2 and expects success or the exact error.
  - `USDC_DOMAIN_SEPARATOR` equals `0x3611…c6b0` on chain id 5042002 (`S02/data-and-protocol.md` §6.1).

### T-014 Envelopes: openEnvelope (owner/agent allowance), closeEnvelope, forceCloseEnvelope
- **Milestone / group / who:** M1 / M1-c / agent. **Size:** M. **Deps:** T-013.
- **Spec refs:** `S03/czar-vault.md` §5.2, §5.6 (allowance period), §8.1, INV-1, INV-2, INV-9; D11.
- **Outputs:** envelope functions in `CzarVault.sol`; `contracts/test/EnvelopeTest.t.sol`.
- **Steps:** tests first: owner opens any cap ≤ free balance; agent opens only within `autoLimit − usedInPeriod`; period roll; close needs zero open reservations, pockets, jobs; force close after expiry + 1 day.
- **Inputs:** `contracts/src/CzarVault.sol` core from T-013.
- **Acceptance tests:**
  - `arc-forge test --match-contract EnvelopeTest` passes, including `AllowanceExceeded`, `InsufficientFree`, `EnvelopeBusy`, `FrozenVault`, `Paused`.

### T-015 Reservations: reserve, reserveWithDigests, derivedNonce, settle, finalize
- **Milestone / group / who:** M1 / M1-c / agent. **Size:** L. **Deps:** T-014.
- **Spec refs:** `S03/czar-vault.md` §5.3, §6.6, §8.2, INV-5, INV-8; `S02/data-and-protocol.md` §5.3 (payee leaves), §7.2; D36, D39, D43.
- **Outputs:** reservation functions; `contracts/test/ReserveTest.t.sol`.
- **Steps:** tests first: Merkle proof against `payeeRoot` with `PAYEE_LEAF` kind 1; `count ≤ 128`; TTL bounds; `settle` only when `authorizationState == true`; `finalize` only after `validBefore`, chunked by 32; digest mode stores `digestSlot` for `count ≤ 8`.
- **Inputs:** `contracts/src/CzarVault.sol` with envelopes from T-014.
- **Acceptance tests:**
  - `arc-forge test --match-contract ReserveTest` passes, including `PayeeNotInPlan`, `StepCapExceeded`, `CapExceeded`, `BadTtl`, `BadCount`, `NotUsed`, `AlreadyDone`, `NotExpired`.
  - `derivedNonce(12, 3)` for the example vault equals `0x1f7eb762…fd59f` from the vectors file.

### T-016 isValidSignature: USDC_3009, 65-byte fallback, SL_RECEIPT; exposure-bound tests
- **Milestone / group / who:** M1 / M1-c / agent. **Size:** L. **Deps:** T-015, T-007.
- **Spec refs:** `S03/czar-vault.md` §6, §6.1, §6.3, §6.4, §6.5, INV-4, INV-5, INV-11; `S02/data-and-protocol.md` §6.3.1, §6.3.3, §6.3.4, §6.3.5; A1-03, A1-09.
- **Outputs:** dispatcher in `CzarVault.sol`; `contracts/test/SignatureTest.t.sol`.
- **Steps:** tests first, one per numbered check in §6.1 failing alone; then the dispatcher; never revert, return `0xffffffff` on any failure.
- **Inputs:** `contracts/src/CzarVault.sol` with reservations from T-015; `packages/hashing` from T-007 (vector fixtures).
- **Acceptance tests:**
  - `arc-forge test --match-contract SignatureTest` passes: wrong nonce, index ≥ count, done bit, wrong `to`, `value > unitAmount`, `validAfter != 0`, wrong `validBefore`, expired, frozen, paused, wrong digest, wrong signer, high-s, bad `v` → each returns `0xffffffff`; a bare 65-byte signature against an unregistered digest → `0xffffffff`.
  - Through the USDC mock, an exposure test signs 1,000 authorizations against a `count = 10` reservation and asserts total moved ≤ `10 × unitAmount` (§6.5).

### T-017 Pockets and GATEWAY_BURN kind: register, gas, fund, requestPullback, confirm, cancel, writeOff, recordManualReturn
- **Milestone / group / who:** M1 / M1-d / agent. **Size:** L. **Deps:** T-016.
- **Spec refs:** `S03/czar-vault.md` §5.4, §6.2, §8.3, INV-6, INV-7; `S02/data-and-protocol.md` §6.3.2, §7.3; D22, D41; A2-02, A2-04, A2-05, A2-18.
- **Outputs:** pocket functions and the `GATEWAY_BURN` branch; `contracts/test/PocketTest.t.sol`.
- **Steps:** tests first: `NotEoa`, `DelegateNotSet`, 25% cap (`PocketCapExceeded`), gas grant cap, each `TransferSpec` field mutated → `INVALID`, cross-chain domain → `INVALID`, cancelled record → `INVALID`, confirm only when `isTransferSpecHashUsed`; `recordManualReturn` owner-only.
- **Inputs:** `contracts/src/CzarVault.sol` with the dispatcher from T-016; `MockGatewayWallet.sol`, `MockGatewayMinter.sol` from T-010.
- **Acceptance tests:**
  - `arc-forge test --match-contract PocketTest` passes.
  - The burn-intent struct hash built by the vault for the `gatewayBurnIntent_sameChain` vector equals `0xbaa687f2…6ec8` and `transferSpecHash` equals `0xa2f49c1a…3616`.

### T-018 Job adapter (CircleTestnet kind) and openJob/fundJob/syncJob/claimJobRefund
- **Milestone / group / who:** M1 / M1-d / agent. **Size:** L. **Deps:** T-014.
- **Spec refs:** `S03/job-escrow-adapter.md` §2–§9 (JOB-1..4); `S03/czar-vault.md` §5.5, §8.4, §9.1 (`JobSynced.state` mapping, AM-19); D27, D32; A4-03, A4-05, A4-07.
- **Outputs:** `contracts/src/JobEscrowAdapter.sol` (internal library), job functions in `CzarVault.sol`; `contracts/test/JobTest.t.sol` against both mocks.
- **Steps:** tests first: budget read and `fund` in one tx; fee check (both 0 on the Circle kind); `BudgetExceedsReserved`; description is exactly `"czar:" + 64 hex`; `optParams` empty; refunds credit the envelope or free balance.
- **Inputs:** `contracts/src/CzarVault.sol` with envelopes from T-014; ERC-8183 mocks from T-010.
- **Acceptance tests:**
  - `arc-forge test --match-contract JobTest` passes on both mock ABIs, including a provider front-running `setBudget` in the same block (rejected) and a refund after the envelope closed (`creditedToEnvelope = false`).

### T-019 Earned autonomy (raiseAutoLimit/lowerAutoLimit, AutonomyRaise) and executeOwnerAction with WebAuthn/P-256
- **Milestone / group / who:** M1 / M1-d / agent. **Size:** L. **Deps:** T-014.
- **Spec refs:** `S03/czar-vault.md` §5.6 (empty `sig` for the owner, AM-20; D60 note), §7; `S02/data-and-protocol.md` §6.2 (`AutonomyRaise`, `OwnerAction`); D30, D40; A6-01 to A6-03.
- **Outputs:** autonomy and owner-action functions; `contracts/test/AutonomyTest.t.sol`, `contracts/test/OwnerActionTest.t.sol`, a captured WebAuthn fixture in `contracts/test/fixtures/`.
- **Steps:** tests first: one raise per period, ≤ 20% of `userMax`, signer recovery, nonce and deadline; WebAuthn with UV required, `rpIdHash` check, P-256 at `0x100` costing 6,900 gas.
- **Inputs:** `contracts/src/CzarVault.sol` with envelopes from T-014; a captured WebAuthn assertion fixture.
- **Acceptance tests:**
  - `arc-forge test --match-contract AutonomyTest` passes, including `RaiseTooLarge`, `RaiseAlreadyThisPeriod`, `BadSigner`, `Expired`.
  - `arc-forge test --match-contract OwnerActionTest` passes on `arc-anvil --network arc` (real P-256 precompile, A9-14), including wrong `rpIdHash`, missing UV and wrong challenge → `InvalidPasskeyAssertion`.
  - The `autonomyRaise_5042002` and `ownerAction_5042002` digests reproduce on-chain.

### T-020 Size build and D42 library split decision
- **Milestone / group / who:** M1 / M1-e / agent. **Size:** S. **Deps:** T-017, T-018, T-019, G0-08.
- **Spec refs:** D42; `S02/data-and-protocol.md` §15.1 AR-16; `S03/czar-vault-factory.md` §11; G0-08 result.
- **Outputs:** `contracts/SIZE.md` (measured runtime size, limit from G0-08, decision); if needed `contracts/src/VaultLib.sol` (external library) with tests unchanged.
- **Steps:** `arc-forge build --sizes`; if `CzarVault` exceeds the limit, move WebAuthn and Gateway hashing into an external library; rerun all M1 tests.
- **Inputs:** complete `contracts/src/CzarVault.sol` from T-017, T-018, T-019; size limit record `specs/05-build-plan/gate-0-results/G0-08.md`.
- **Acceptance tests:**
  - `arc-forge build --sizes` shows `CzarVault` runtime size ≤ the limit recorded in G0-08.
  - All tests from T-011..T-019 still pass.

### T-021 Fuzz and Foundry invariant suites (INV-1..11, FAC-1..4, JOB-1..4, OEL-1..5)
- **Milestone / group / who:** M1 / M1-e / agent. **Size:** L. **Deps:** T-020, T-011.
- **Spec refs:** `S03/security-and-testing.md` §2, §3.2, §3.3; `S03/czar-vault.md` §11.
- **Outputs:** `contracts/test/invariant/InvariantVault.t.sol`, handlers per role, `contracts/test/fuzz/*.t.sol`.
- **Steps:** handlers for owner, agent, autonomy, guardian, USDC mock (consumes nonces), Gateway mock, job mocks; assert every invariant after each call.
- **Inputs:** all contracts from T-011 and T-020; mocks from T-010.
- **Acceptance tests:**
  - `arc-forge test --match-contract InvariantVault -vv` passes with `invariant.runs ≥ 256` and `depth ≥ 64`.
  - `arc-forge test --match-path 'test/fuzz/*'` passes with `fuzz.runs ≥ 10000`.
  - Mutation check: deleting the `payeeRoot` proof check makes INV-3 fail (recorded in the task report, change reverted).

### T-022 Fork tests on arc-anvil testnet fork: USDC bytes overload, authorizationState, GatewayWallet depositFor/addDelegate, Circle ERC-8183
- **Milestone / group / who:** M1 / M1-e / agent. **Size:** L. **Deps:** T-020.
- **Spec refs:** `S03/security-and-testing.md` §3.4; `S03/czar-vault.md` §10; A1-08, A1-11, A1-12, A1-18, A2-02, A2-04, A4-06, A4-07.
- **Outputs:** `contracts/test/fork/*.t.sol`, a pinned fork block in `contracts/foundry.toml`.
- **Steps:**
  - Fork `https://rpc.testnet.arc.io` at a recorded block with `arc-anvil --fork-url`.
  - Vault on the fork pays via the real USDC bytes overload `0xcf092995` from a relayer address; then `settle` and `finalize`.
  - `fundPocket` against the real GatewayWallet; Circle ERC-8183 `openJob`/`fundJob`/`claimRefund`.
- **Inputs:** all contracts from T-020; `scripts/install-arc-foundry.sh` from T-003; testnet RPC URL.
- **Acceptance tests:**
  - `arc-forge test --match-path 'test/fork/*' --fork-url $ARC_TESTNET_RPC --fork-block-number $PINNED` passes.
  - Assertions include `AuthorizationUsed`, `authorizationState == true`, `Deposited`, `DelegateAdded`, `JobFunded`, `Refunded`.

### T-023 On-chain reproduction of spec 02 §6.4 vectors
- **Milestone / group / who:** M1 / M1-e / agent. **Size:** S. **Deps:** T-020, T-007.
- **Spec refs:** `S02/data-and-protocol.md` §6.4; `S02/vectors/eip712-vectors.json`; `S03/security-and-testing.md` §3.1.
- **Outputs:** `contracts/test/VectorsTest.t.sol` reading the JSON fixture.
- **Inputs:** all contracts from T-020; `packages/hashing` and the vectors fixture from T-007.
- **Steps:**
  - Load `eip712-vectors.json` as a Foundry JSON fixture.
  - Recompute each digest, `transferSpecHash` and the derived nonce in Solidity.
  - Assert equality for every vector.
- **Acceptance tests:**
  - `arc-forge test --match-contract VectorsTest` passes: all six digests, `transferSpecHash` and the derived nonce match.

### T-024 Gas snapshot and measured gas table for routing
- **Milestone / group / who:** M1 / M1-e / agent. **Size:** S. **Deps:** T-020.
- **Spec refs:** `S03/czar-vault.md` §6.6, §13; `S03/security-and-testing.md` §3.5; `S04/server-planning-and-payment.md` CZ-14 §5; D37, D38.
- **Outputs:** `contracts/.gas-snapshot`, `packages/config/gas-table.json` (values for `routing.gas.*`).
- **Inputs:** all contracts and tests from T-020; `packages/config` from T-004.
- **Steps:**
  - Run `arc-forge snapshot` on all function tests.
  - Write the measured values to `packages/config/gas-table.json` under `routing.gas.*`.
  - Add the `--check` step to CI.
- **Acceptance tests:**
  - `arc-forge snapshot --check` passes in CI (fails on > 5% regression).
  - `gas-table.json` has every key `routing.gas.*` names, and `pocketThreshold(1)`, `(10)`, `(100)` computed from it are printed in the task report.

### T-025 Slither, static checks (no tx.origin, no prevrandao, bounded loops), triage file
- **Milestone / group / who:** M1 / M1-e / agent. **Size:** M. **Deps:** T-020.
- **Spec refs:** `S03/security-and-testing.md` §3.6; p1-A7.
- **Outputs:** `contracts/slither.config.json`, `contracts/SLITHER-TRIAGE.md`, CI job.
- **Inputs:** all contracts from T-020; CI from T-002.
- **Steps:**
  - Add a pinned Slither config and CI job.
  - Triage every finding in `contracts/SLITHER-TRIAGE.md`.
  - Add the grep checks for banned constructs.
- **Acceptance tests:**
  - `slither contracts/ --config-file contracts/slither.config.json` shows 0 unresolved high or medium findings; every remaining finding has a triage reason.
  - `grep -rE 'tx\.origin|prevrandao|block\.difficulty' contracts/src` prints nothing.

### T-026 @czar/vault-client: typed calls, signature-envelope encoders, error decoding, WebAuthn helpers
- **Milestone / group / who:** M1 / M1-e / agent. **Size:** L. **Deps:** T-020, T-007.
- **Spec refs:** `S04/cross-cutting.md` §2; `S02/data-and-protocol.md` §6.3; `S03/interfaces/*.sol`; `S03/czar-vault.md` §9.2.
- **Outputs:** `packages/vault-client/` (viem 2.57.x).
- **Steps:** ABI from compiled interfaces; encoders for `USDC_3009`, `GATEWAY_BURN`, `SL_RECEIPT` and the 65-byte fallback; revert decoding to error names; `maxFeePerGas ≥ 20 Gwei` (p1-A6).
- **Inputs:** compiled ABIs from T-020; `packages/hashing` from T-007.
- **Acceptance tests:**
  - `pnpm --filter @czar/vault-client test` passes; an `arc-anvil` integration test calls every `ICzarVault` function once and decodes every custom error by name.
  - The encoder's `USDC_3009` bytes are exactly 416 bytes and accepted by the T-016 contract.

### T-027 Testnet deployment via Arachnid CREATE2, bytecode hash publication, verified sources
- **Milestone / group / who:** M1 / M1-f / agent, after Zaryab approves funds. **Size:** M. **Deps:** T-021..T-026.
- **Spec refs:** `S03/security-and-testing.md` §4 steps 1–4; `S03/czar-vault-factory.md` §3, §12; A9-10, A9-15.
- **Outputs:** `contracts/script/Deploy.s.sol`, `deployments/arc-testnet.json` (addresses, constructor args, creation-code hash, runtime hash).
- **Steps:**
  - Deploy `OpenEvidenceLog` and `CzarVaultFactory` through `0x4e59b44847b379578588920cA78FbF26c0B4956C` with fixed salts.
  - Admin accepts ownership; register vault version 1.
  - Verify sources on the testnet explorer (keyless, rate-limited).
- **Inputs:** tested contracts from T-021..T-025; `packages/vault-client` from T-026; Zaryab's written funds approval.
- **Acceptance tests:**
  - `arc-cast code <factory> --rpc-url https://rpc.testnet.arc.io` is non-empty and its keccak equals the published runtime hash.
  - `arc-cast call <factory> "guardianPaused()(bool)"` returns `false`.
  - Re-running the script is a no-op (addresses already exist).

---

## M2 Indexer and key management

### T-030 Indexer: Ponder project, chains config, ≤9,999-block paging, -32012/-32014 retry
- **Milestone / group / who:** M2 / M2-a / agent. **Size:** M. **Deps:** T-027.
- **Spec refs:** `S04/server-acceptance-evidence-selection.md` CZ-19 §5.1, §5.2, §10; A9-05, A9-06, A9-07, A9-08; p1-A7.
- **Outputs:** `apps/indexer/` (Ponder 0.18.x, `ponder.config.ts` with `ethGetLogsBlockRange` 9,999 and the deployed addresses).
- **Inputs:** `deployments/arc-testnet.json` from T-027; compiled ABIs.
- **Steps:**
  - Create the Ponder project with testnet chain config and a keyed fallback RPC.
  - Set `ethGetLogsBlockRange` to 9,999 and add retry for `-32012` and `-32014`.
  - Add checkpoints so a restart resumes.
- **Acceptance tests:**
  - Against a local `arc-anvil` that returns `-32012` for wide ranges and `-32014` randomly, the indexer syncs 50,000 blocks without gaps (test asserts every block range covered once).
  - Restart mid-sync resumes from the checkpoint (kill-and-resume test).

### T-031 Indexer projections: vault and factory events → Envelope, Reservation, PocketRecord, JobRecord mirrors
- **Milestone / group / who:** M2 / M2-b / agent. **Size:** L. **Deps:** T-030.
- **Spec refs:** CZ-19 §5.3; `S03/czar-vault.md` §9.1 (including the `JobSynced.state` mapping); `S02/data-and-protocol.md` §4.8–§4.11.
- **Outputs:** projection handlers and tables in `apps/indexer/src/`.
- **Inputs:** `apps/indexer/` from T-030; `packages/schemas` mirrors (T-006).
- **Steps:**
  - Add handlers for every vault and factory event in §9.1.
  - Build the four mirror tables from 02 §4.8–§4.11.
  - Apply the `JobSynced.state` mapping from `czar-vault.md` §9.1.
- **Acceptance tests:**
  - A replay test runs the T-021 invariant handler sequence on `arc-anvil`, indexes it, and asserts every mirror field equals the on-chain view at the final block.
  - Mirrors validate against `S02/schemas/envelope.schema.json`, `reservation.schema.json`, `pocket-record.schema.json`, `job-record.schema.json`.

### T-032 Indexer external events: USDC Transfer/AuthorizationUsed (both emitters), Gateway, GatewayMinter, ERC-8183, OpenEvidenceLog; Gateway transfers poll
- **Milestone / group / who:** M2 / M2-b / agent. **Size:** L. **Deps:** T-030.
- **Spec refs:** CZ-19 §4, §5.3, §5.6; SL-F4 (EIP-7708 emitter, 18→6 decimals); A2-29, A2-30, p1-G10.
- **Outputs:** handlers for external contracts filtered to Czar addresses; Gateway poller (`indexer.gatewayPollSeconds`).
- **Inputs:** `apps/indexer/` from T-030; pinned external addresses in `specs/01-system-architecture/system-architecture.md` §6.2.
- **Steps:**
  - Add filtered handlers for USDC (both emitters), GatewayWallet, GatewayMinter, ERC-8183 and `OpenEvidenceLog`.
  - Normalize 18-decimal native amounts to 6 decimals.
  - Add the Gateway transfers poller at `indexer.gatewayPollSeconds`.
- **Acceptance tests:**
  - On the T-022 fork run, `AuthorizationUsed(vault, nonce)` and both `Transfer` emitters are indexed with amounts normalized to 6 decimals.
  - A recorded Gateway API fixture moving `received → batched → completed` updates the pocket payment status in order.

### T-033 Alerts and halt flags: Upgraded on pinned proxies, ERC-8183 admin events, lag, reservation rate
- **Milestone / group / who:** M2 / M2-c / agent. **Size:** M. **Deps:** T-031, T-032.
- **Spec refs:** CZ-19 §5.5; `S01/system-architecture.md` §16.2; FD-18; A1-02, A2-23, A4-08, A5-12.
- **Outputs:** alert rules, `halt_flags` table read by the paying agent.
- **Inputs:** projections from T-031 and T-032.
- **Steps:**
  - Watch `Upgraded(address)` on every pinned proxy and ERC-8183 admin events.
  - Write `halt_flags` rows that the paying agent reads.
  - Add lag and reservation-rate alerts with their parameters.
- **Acceptance tests:**
  - On `arc-anvil`, emitting `Upgraded(address)` from a mock at a pinned address sets the matching halt flag within one poll and pages (test sink).
  - Lag above `indexer.maxLagBlocks` raises the lag alert.

### T-034 Indexer query API for server, app and paying agent
- **Milestone / group / who:** M2 / M2-c / agent. **Size:** M. **Deps:** T-031, T-032.
- **Spec refs:** CZ-19 §5.4 (exact query list).
- **Outputs:** `apps/indexer/src/api/` with one route per listed query.
- **Inputs:** projections from T-031 and T-032.
- **Steps:**
  - Implement one route per query in CZ-19 §5.4.
  - Return objects that validate against the 02 mirror schemas.
  - Add pagination per 02 §9.5.
- **Acceptance tests:**
  - `pnpm --filter @czar/indexer test` covers every query in §5.4 against a seeded database, including "reservations needing `settle`/`finalize`" and "pullbacks to confirm".

### T-035 Signer service (CZ-27) with request validation and a pluggable backend; Phase 1 backend `local-keystore` (D61, D70)
- **Milestone / group / who:** M2 / M2-a / agent. **Size:** L. **Deps:** T-026, G0-13.
- **Spec refs:** `S04/server-autonomy-roi-keys.md` CZ-27 §5.1, §5.2, §5.4, §9; D61, D62; AR-1.
- **Outputs:** `apps/server/src/signer/` (separate process), policy tables per key K3, K4, K5, K7, K8, K9 (Phase 2), K10.
- **Steps:**
  - Rebuild every digest from structured fields before asking the KMS; allowlist of contracts and selectors per key; per-key rate limits (`kms.maxSignaturesPerMin`); audit row per signature.
  - Selectors `withdraw`, `unfreeze`, `rotateSigners`, `recordManualReturn` are never signable by server keys.
- **Inputs:** `packages/vault-client` from T-026; G0-13 record `specs/05-build-plan/gate-0-results/G0-13.md`.
- **D70 note:** implement the backend interface with `local-keystore` (encrypted keystore, passphrase from the macOS keychain). The `gcp-kms` backend is a stage-2 task. "KMS" in the steps and tests below means the configured backend.
- **Acceptance tests:**
  - `pnpm --filter @czar/server test signer` passes: a USDC digest whose `to` is outside the reservation is denied before the KMS call; a `withdraw` call is denied; rate limit enforced; the audit row has no raw text.
  - Against the KMS test key from G0-13, a signature over a known digest recovers to the key's address.

### T-036 Signer policies tested on testnet, rate limits, relayer gas key in the `local-keystore` backend (D62, D70)
- **Milestone / group / who:** M2 / M2-c / agent, after Zaryab approves funds. **Size:** M. **Deps:** T-035, T-027.
- **Spec refs:** CZ-27 §5.2, §14; D61, D62.
- **Outputs:** KMS keys for K3, K5, K7, K8, K10 and the relayer gas key on testnet; `deployments/arc-testnet-keys.json` (addresses only, no key material).
- **Inputs:** `apps/server/src/signer/` from T-035; `deployments/arc-testnet.json` from T-027; Zaryab's funds approval.
- **Steps:**
  - Create the testnet KMS keys for K3, K5, K7, K8, K10 and the relayer.
  - Record their addresses (no key material) in `deployments/arc-testnet-keys.json`.
  - Run the allowed and denied signing tests on testnet after Zaryab approves funds.
- **Acceptance tests:**
  - On testnet, the relayer key (KMS) sends one `OpenEvidenceLog.commit` with a zero test root under a test publisher; `arc-cast receipt` shows status 1.
  - A denied request (wrong selector) never reaches the KMS (KMS audit log shows no call).

### T-037 Pocket key lifecycle in the signer (create, sign, destroy)
- **Milestone / group / who:** M2 / M2-c / agent. **Size:** M. **Deps:** T-035.
- **Spec refs:** CZ-27 §5.3; `S03/czar-vault.md` §5.4; D22.
- **Outputs:** pocket-key API inside the signer (create per objective, sign `addDelegate` tx and `GatewayWalletBatched` authorizations only, destroy after `PocketClosed`).
- **Inputs:** `apps/server/src/signer/` from T-035.
- **Steps:**
  - Add create, sign and destroy calls for per-objective pocket keys.
  - Restrict signing to `addDelegate` transactions and `GatewayWalletBatched` authorizations.
  - Destroy the key when `PocketClosed` is indexed.
- **Acceptance tests:**
  - Unit test: a pocket key cannot sign a burn intent (those are signed by K3 as the vault) or any transfer to a non-Gateway address.
  - Destroy is called when a fixture `PocketClosed` event arrives; a later sign request fails.

---

## M3 First money path

### T-040 Testnet hosting: server, indexer, merchants, Postgres, object store, secret references
- **Milestone / group / who:** M3 / M3-a / agent, after Zaryab approves accounts. **Size:** M. **Deps:** T-034, T-036.
- **Spec refs:** `S01/system-architecture.md` §5; `S04/cross-cutting.md` §3.1, §3.3.
- **Outputs:** infrastructure definitions (one region), `env/testnet.toml` with parameter overlays and secret references only.
- **Inputs:** indexer query API from T-034; testnet KMS keys from T-036; Zaryab's account approval.
- **Steps:**
  - Define server, indexer, merchants, Postgres and object store in one region.
  - Write `env/testnet.toml` with parameter overlays and secret references only.
  - Add health checks.
- **Acceptance tests:**
  - Health checks for server, indexer and merchants return 200 on testnet hosting.
  - A scan of deployed environment variables finds no key material (only KMS ids).

### T-041 Server skeleton CZ-12: device tokens, idempotency, RFC 9457 errors, rate limits, Postgres schema, objective state machine
- **Milestone / group / who:** M3 / M3-a / agent. **Size:** L. **Deps:** T-006, T-009, T-004, T-005.
- **Spec refs:** `S04/server-planning-and-payment.md` CZ-12 §4–§14; `S02/data-and-protocol.md` §9.1–§9.5; `S02/api/openapi.yaml`.
- **Outputs:** `apps/server/` (HTTP app, migrations for the CZ-12 tables, middleware).
- **Inputs:** `packages/schemas` (T-006), `packages/api-contract` (T-009), `packages/config` (T-004), `packages/logging` (T-005).
- **Steps:**
  - Implement device-token auth, idempotency keys and RFC 9457 errors.
  - Add migrations for the CZ-12 tables.
  - Implement the objective state machine and the daemon routes listed in the tests.
- **Acceptance tests:**
  - Contract tests from T-009 pass for `pairDevice`, `submitObjective`, `listObjectives`, `getObjective`.
  - Idempotency: same key + same body replays; same key + different body → `409 idempotency-conflict`.
  - `submitObjective` with a tampered goal → `422 hash-mismatch`.

### T-042 @czar/x402: buyer v2/v1 parsing, seller helpers, extension sanitizing
- **Milestone / group / who:** M3 / M3-a / agent. **Size:** L. **Deps:** T-006.
- **Spec refs:** `S02/data-and-protocol.md` §11.1–§11.4; A3-02 to A3-11, A3-36; F1-06, F1-07; `@x402/*` 2.28.0, `@circle-fin/x402-batching` 3.5.0.
- **Outputs:** `packages/x402/`.
- **Inputs:** `packages/schemas` from T-006; npm `@x402/core`, `@x402/evm`, `@x402/extensions` 2.28.0 and `@circle-fin/x402-batching` 3.5.0.
- **Steps:**
  - Implement buyer parsing for v2 headers and the v1 body fallback.
  - Implement seller helpers for `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`.
  - Implement extension sanitizing and size caps per 02 §11.3.
- **Acceptance tests:**
  - `pnpm --filter @czar/x402 test` passes a 402 corpus: v2 header, v1 body, Gateway offer, `upto` (refused), `batch-settlement` (refused), cross-chain (refused), malformed, oversized header (> 16 KiB, dropped), extension with external `$ref` (dropped).
  - `PAYMENT-RESPONSE` then `X-PAYMENT-RESPONSE` fallback; `settlement_pending` decoded as non-terminal.

### T-043 Merchant czar-search vanilla x402 route with Facilitator keyless trial and payment-identifier store
- **Milestone / group / who:** M3 / M3-b / agent. **Size:** M. **Deps:** T-042, T-040, G0-04.
- **Spec refs:** `S04/server-supply-side.md` CZ-20 §5.1, §5.2, §5.4, §5.5; `S02/data-and-protocol.md` §11.1; D14, D49; A1-15, p1-F4.
- **Outputs:** `apps/merchants/src/search/` (vanilla route only), payout key K10 via the signer.
- **Inputs:** `packages/x402` from T-042; testnet hosting from T-040; Facilitator record `specs/05-build-plan/gate-0-results/G0-04.md`.
- **Steps:**
  - Implement the `czar-search` handler and the vanilla 402.
  - Call Facilitator `/verify` before the handler and `/settle` after it succeeds.
  - Add the `payment-identifier` idempotency store.
- **Acceptance tests:**
  - Local: a 402 decodes to the §11.1 field table; a handler failure means no `/settle` call (mocked Facilitator).
  - Same `payment-identifier` + same payload → cached response; different payload → `409`.
  - Testnet: `curl` without payment returns `402` with a valid `PAYMENT-REQUIRED` header.

### T-044 Payment router CZ-14 (pure policy) with measured gas table
- **Milestone / group / who:** M3 / M3-b / agent. **Size:** M. **Deps:** T-024, T-004.
- **Spec refs:** `S04/server-planning-and-payment.md` CZ-14 §5; `S03/czar-vault.md` §13; D37, D38, D39, D48.
- **Outputs:** `apps/server/src/router/`.
- **Inputs:** `packages/config/gas-table.json` from T-024; `packages/config` from T-004.
- **Steps:**
  - Encode the decision order from CZ-14 §5 as a pure function.
  - Read gas inputs from `gas-table.json` and the live gas price with the 20 Gwei floor.
  - Return `kind` and `routingReason`.
- **Acceptance tests:**
  - Table-driven tests for every branch in CZ-14 §5, including `unitAmount == pocketThreshold(n)`.
  - Property test: no route ever has on-chain cost greater than the payment (D37 hard rule) for random inputs.

### T-045 Planner core CZ-13: rule-based plan, live probe, caps, alternates, payee leaves, payeeRoot, planHash (Czar-registered candidates only)
- **Milestone / group / who:** M3 / M3-b / agent. **Size:** L. **Deps:** T-041, T-042, T-044, T-007.
- **Spec refs:** `S04/server-planning-and-payment.md` CZ-13 §5 (steps 1–3, 5–11), §6 (rule-based fallback); `S02/data-and-protocol.md` §4.5–§4.7, §5.2, §5.3; D36, D43.
- **Outputs:** `apps/server/src/planner/` (no P-03 yet; T-092 adds it), `shadowQuote` reuses it later.
- **Inputs:** `apps/server/` from T-041; `packages/x402` (T-042); `apps/server/src/router/` (T-044); `packages/hashing` (T-007).
- **Steps:**
  - Map capabilities to task classes and fetch Czar-registered candidates.
  - Probe live 402s and drop drifted candidates.
  - Compute caps, alternates, payee leaves, `payeeRoot` and `planHash`.
  - Use the rule-based plan (P-03 comes in T-092).
- **Acceptance tests:**
  - Property test: every payee and alternate has a leaf with its `stepIndex` and `stepCap`, and `payeeRoot` verifies each leaf with the T-007 rules.
  - `planHash` recomputes from the stored plan.
  - A probe that shows price drift above the step budget drops the candidate.

### T-046 Injection boundary: P-01 screen, P-02 reader, StepResult pipeline, eval suites
- **Milestone / group / who:** M3 / M3-b / agent. **Size:** L. **Deps:** T-006, T-005.
- **Spec refs:** `S04/server-planning-and-payment.md` CZ-15 §5.6; `S04/ai-prompts.md` P-01, P-02 (system prompts, schemas, post-validation, eval cases); `S02/data-and-protocol.md` §4.15; C3-04, C3-09.
- **Outputs:** `models/P-01.md`, `models/P-02.md`, `models/evals/P-01/`, `models/evals/P-02/`, `apps/server/src/boundary/`.
- **Inputs:** `packages/schemas` (T-006); `packages/logging` (T-005); prompt texts in `specs/04-components/ai-prompts.md`.
- **Steps:**
  - Add the regex pre-screen and the P-01 call.
  - Add the P-02 call with post-validation.
  - Build `StepResult` objects and wrap them for the planner.
  - Wire the eval suites into CI.
  - Read the current model prices from the provider's pricing page and record them in the task report; file an SCR to add money figures to `S04/cross-cutting.md` §6.2. Until that SCR is applied, budgets stay in tokens and request counts (D68).
- **Acceptance tests:**
  - The task report lists the model prices with source and date, and the SCR ID (D68).
  - `pnpm --filter @czar/server eval P-01 P-02` passes every listed eval case, including all injection cases; CI fails if any injection case changes a protected field.
  - The regex pre-screen alone (model disabled) flags eval cases 2–6 and 9 of P-01.

### T-047 Acceptance checker minimal: delivery and structural in a sandbox, AcceptanceReport, reportHash
- **Milestone / group / who:** M3 / M3-b / agent. **Size:** M. **Deps:** T-006, T-007.
- **Spec refs:** `S04/server-acceptance-evidence-selection.md` CZ-16 §5.1–§5.4, §5.8; `S02/data-and-protocol.md` §4.14, §5.2; D55.
- **Outputs:** `apps/server/src/acceptance/` (sandbox without network).
- **Inputs:** `packages/schemas` (T-006); `packages/hashing` (T-007).
- **Steps:**
  - Run checks in a sandbox without network access.
  - Implement `delivery` and `structural` with the D55 rule.
  - Build the `AcceptanceReport` and `reportHash`.
- **Acceptance tests:**
  - Fixtures: 2xx JSON matching a schema → `pass`; body over `acceptance.maxBodyBytes` → `delivery` fail; no schema and no history → `inconclusive` (D55).
  - A check script that tries `fetch` inside the sandbox fails.
  - `reportHash` recomputes from the stored report.

### T-048 Paying agent vault-direct loop with step_executions and crash recovery
- **Milestone / group / who:** M3 / M3-c / agent. **Size:** L. **Deps:** T-045, T-046, T-047, T-034, T-036.
- **Spec refs:** `S04/server-planning-and-payment.md` CZ-15 §5.1, §5.2, §5.5, §6, §10, §12; `S03/czar-vault.md` §5.3, §6.1; `S02/data-and-protocol.md` §7.4, §7.5; A3-11, F1-06.
- **Outputs:** `apps/server/src/payer/vault-direct.ts`, `apps/server/src/payer/executions.ts`, executor leases.
- **Steps:**
  - Tests first on `arc-anvil` with mocked Facilitator and a local seller.
  - Persist each phase before and after its external call; one executor per envelope.
  - Agent-opened envelope within allowance for this milestone (the owner sets limits with a test-keystore owner fixture: testnet only, M3–M4 only, removed in M6 by T-082; D64).
- **Inputs:** planner (T-045), boundary (T-046), acceptance (T-047), indexer query API (T-034), testnet signer policies (T-036).
- **Acceptance tests:**
  - Integration test: reserve → sign → call → settle → finalize; `Envelope.spent` equals the payment.
  - Kill-and-resume test kills the executor after each persisted phase (`reserve.sent`, `reserve.mined`, `auth.signed`, `call.sent`, `call.result`, before `finalize`) and asserts no second authorization is signed and the final state is correct.
  - `settlement_pending` fixture reconciles through `authorizationState` without re-signing.

### T-049 Receipts under SL_RECEIPT and evidence store (no publishing yet)
- **Milestone / group / who:** M3 / M3-c / agent. **Size:** M. **Deps:** T-048.
- **Spec refs:** `S02/data-and-protocol.md` §4.12, §4.13, §6.3.3 (job receipts too, AM-10); CZ-15 §5.2 step 9; CZ-17 §5.1, §5.5.
- **Outputs:** `apps/server/src/evidence/receipts.ts`, evidence tables.
- **Inputs:** `apps/server/src/payer/vault-direct.ts` from T-048.
- **Steps:**
  - Build `PaymentRef` and `Receipt` objects for each settled step.
  - Sign receipts with K3 under the `SL_RECEIPT` envelope through the signer.
  - Store receipts and reports in the evidence tables.
- **Acceptance tests:**
  - A receipt signed by K3 under the `SL_RECEIPT` envelope makes the vault's `isValidSignature` return `0x1626ba7e` on `arc-anvil`.
  - `paymentRefHash` excludes `reservationId` and `index` and matches the SL definition.

### T-050 Thin slice on testnet: one real reserve → x402 → settle → finalize against czar-search, evidence recorded
- **Milestone / group / who:** M3 / M3-d / agent, after Zaryab approves funds. **Size:** M. **Deps:** T-049, T-043.
- **Spec refs:** `S04/phase-1-acceptance-scenario.md` Stage 4; `S01/system-architecture.md` §8.3; A1-17.
- **Outputs:** run report `reports/m3-thin-slice.md` (tx hashes, events, no keys).
- **Inputs:** receipts and evidence store from T-049; `czar-search` route from T-043; Zaryab's funds approval.
- **Steps:**
  - Fund a test vault after Zaryab approves and set limits with the test owner fixture.
  - Run one vault-direct step against `czar-search` on testnet.
  - Write the run report with every tx hash and event.
- **Acceptance tests:**
  - On testnet: `Reserved`, `AuthorizationUsed(vault, nonce_0)`, `Settled`, `ReservationFinal(1, 0)` all present (`arc-cast logs`).
  - The stored receipt verifies under `SL_RECEIPT` against the live vault (`arc-cast call <vault> "isValidSignature(bytes32,bytes)(bytes4)"` returns `0x1626ba7e`).

---

## M4 All money paths

### T-051 Merchants complete: czar-spot, czar-extract, Gateway routes for all three, sweeps, refunds (D50), index entries
- **Milestone / group / who:** M4 / M4-a / agent. **Size:** L. **Deps:** T-050.
- **Spec refs:** `S04/server-supply-side.md` CZ-20 §5.1–§5.9; `S02/data-and-protocol.md` §11.1, §12.2 (`extensions.czar.rail`, AM-17); D49, D50; p1-G11, A2-17, A2-28.
- **Outputs:** `apps/merchants/src/{spot,extract,search}/` with vanilla and Gateway routes, sweep job, refund job.
- **Inputs:** `apps/merchants/src/search/` and the M3 exit report `reports/m3-thin-slice.md` from T-050.
- **Steps:**
  - Add `czar-spot` and `czar-extract` handlers with vanilla routes.
  - Add Gateway routes for all three services with an explicit testnet facilitator URL.
  - Add the daily sweep, the refund job and the index entries.
- **Acceptance tests:**
  - Each service returns a valid vanilla 402 and a valid Gateway 402 (both decode with `@czar/x402`).
  - `czar-spot` responses always carry `source` (public or synthetic, D49).
  - `czar-extract` refuses private IP ranges and non-allowlisted hosts.
  - Refund job respects `merchants.refundDailyAtomic` (D50).
  - Index items validate against the §12.2 shape for both readers.

### T-052 Paying agent pocket loop
- **Milestone / group / who:** M4 / M4-b / agent. **Size:** L. **Deps:** T-050, T-037.
- **Spec refs:** CZ-15 §5.3 steps 1–6, §10, §12; `S03/czar-vault.md` §5.4; D22, D48; A2-24 to A2-26, A2-29.
- **Outputs:** `apps/server/src/payer/pocket.ts`.
- **Inputs:** payer from T-050; pocket-key API from T-037.
- **Steps:**
  - Write the pocket loop tests first, including kill-and-resume.
  - Implement register, gas, delegate and fund steps.
  - Implement nanopayment calls and status tracking.
- **Acceptance tests:**
  - Fork integration: register → gas → `addDelegate` → fund → four nanopayments to a local Gateway seller; ledger shows `pending` then `completed` from a recorded Gateway fixture.
  - Kill-and-resume after `pocket.registered`, gas sent, `fundPocket` sent, and a nanopayment sent: no double funding, no double charge.

### T-053 Pullback: burn intent, /v1/transfer, relayer gatewayMint, confirm, cancel and re-request, API-down fallback
- **Milestone / group / who:** M4 / M4-b / agent. **Size:** L. **Deps:** T-052, G0-05.
- **Spec refs:** CZ-15 §5.3 steps 7–8 and crash table; `S03/czar-vault.md` §5.4, §6.2; `S02/data-and-protocol.md` §6.3.2; D41, D62; A2-16 to A2-19, A2-31.
- **Outputs:** `apps/server/src/payer/pullback.ts` (hand-built burn intents, never `GatewayClient.withdraw()`).
- **Inputs:** `apps/server/src/payer/pocket.ts` from T-052; pullback record `specs/05-build-plan/gate-0-results/G0-05.md`.
- **Steps:**
  - Write pullback tests first, including the expired attestation path.
  - Build the burn intent and the `GATEWAY_BURN` envelope by hand.
  - Call `/v1/transfer`, mint with the KMS relayer and confirm.
  - Add cancel, re-request and the API-down fallback.
- **Acceptance tests:**
  - Fork test with mocked Gateway API: `requestPullback` → signed envelope accepted by the vault's `isValidSignature` → mocked attestation → `gatewayMint` from the KMS relayer → `confirmPullback`.
  - Expired attestation path: `cancelPullback` after `PULLBACK_CANCEL_DELAY_BLOCKS`, new request with a new salt succeeds.
  - Kill-and-resume between `/v1/transfer` and `gatewayMint`.

### T-054 Paying agent job loop on Circle's instance
- **Milestone / group / who:** M4 / M4-b / agent. **Size:** L. **Deps:** T-050.
- **Spec refs:** CZ-15 §5.4; `S03/czar-vault.md` §5.5; `S03/job-escrow-adapter.md` §3–§6; D27; A4-06, A4-07.
- **Outputs:** `apps/server/src/payer/job.ts`.
- **Inputs:** payer from T-050; job adapter in `contracts/src/JobEscrowAdapter.sol` (T-018).
- **Steps:**
  - Write job-loop tests first on the forked Circle instance.
  - Implement open, wait for budget, fund and sync.
  - Implement the refund paths and `claimJobRefund`.
- **Acceptance tests:**
  - Fork test on Circle's instance: open → provider `setBudget` → fund → submit → (evaluator fixture) complete → `syncJob`; and reject and expiry paths with `claimJobRefund`.
  - Kill-and-resume at each step re-reads `getJob` and ends in the right state.

### T-055 ERC-8183 evaluator service with K7 and the .well-known deliverable (D53)
- **Milestone / group / who:** M4 / M4-c / agent. **Size:** M. **Deps:** T-054, T-056.
- **Spec refs:** `S04/server-acceptance-evidence-selection.md` CZ-16 §5.5, §5.6; `S02/data-and-protocol.md` §4.11 (`deliverableUri`, AM-08); D27, D53.
- **Outputs:** `apps/server/src/evaluator/`.
- **Inputs:** `apps/server/src/payer/job.ts` from T-054; profiles from T-056.
- **Steps:**
  - Fetch the deliverable from the `.well-known` URI and check its hash.
  - Run the acceptance profile in the sandbox.
  - Call `complete` or `reject` with K7 and `reportHash`.
- **Acceptance tests:**
  - A deliverable whose content keccak256 equals `deliverable` passes and calls `complete(jobId, reportHash, "")` with K7; a mismatch calls `reject`.
  - An unreachable deliverable stays `inconclusive` until `expiredAt`, then the job is refunded via `claimJobRefund`.
  - K3 is never used for `complete`/`reject` (signer audit log).

### T-056 Acceptance profiles complete: requirement check, D55 inconclusive rule, report vocabulary
- **Milestone / group / who:** M4 / M4-a / agent. **Size:** M. **Deps:** T-047.
- **Spec refs:** CZ-16 §5.2, §5.3; `S02/data-and-protocol.md` §4.6 (`expectedKeys`, AM-09), §4.14 (vocabulary, AM-11); D55.
- **Outputs:** profile set in `apps/server/src/acceptance/profiles/`.
- **Inputs:** `apps/server/src/acceptance/` from T-047.
- **Steps:**
  - Add the `requirement` check over `expectedKeys`.
  - Apply the report vocabulary from 02 §4.14.
  - Add fixtures for each outcome.
- **Acceptance tests:**
  - `requirement` fails when an `expectedKeys` key is missing; `limits` values match the §4.14 vocabulary exactly.

### T-057 Evidence publisher CZ-17: leaves, czar-merkle-v1 batches, archives on server (D54), OpenEvidenceLog commit
- **Milestone / group / who:** M4 / M4-a / agent. **Size:** L. **Deps:** T-049, T-036.
- **Spec refs:** CZ-17 §5.1, §5.2, §5.5, §5.6, §10; `S03/open-evidence-log.md` §11; `S02/data-and-protocol.md` §4.17, §4.18, §4.20 (`archiveUri`), §5.3; D54.
- **Outputs:** `apps/server/src/evidence/publisher.ts`, public archive route on the object store.
- **Inputs:** receipts and evidence tables from T-049; KMS publisher and relayer keys from T-036.
- **Steps:**
  - Create leaves when envelopes close and soul versions arrive.
  - Build batches with `czar-merkle-v1` and store archives on the server.
  - Commit roots to `OpenEvidenceLog` with the KMS publisher key.
- **Acceptance tests:**
  - A batch built twice from the same leaves gives the same root.
  - On `arc-anvil`, `commit(EVIDENCE_BATCH, root, prev, keccak256(utf8(archiveUri)), archiveUri)` lands; a stale `prev` reverts `PrevMismatch` and the publisher retries with the latest root.
  - No IPFS call anywhere in Phase 1 code (grep test).

### T-058 Third-party verification script (recompute from Committed event)
- **Milestone / group / who:** M4 / M4-c / agent. **Size:** M. **Deps:** T-057.
- **Spec refs:** CZ-17 §5.3, §5.4; `S04/phase-1-acceptance-scenario.md` Stage 8.2; p1-G10.
- **Outputs:** `tools/verify-demand-proof/` (needs only an RPC URL and the archive URL).
- **Inputs:** `apps/server/src/evidence/publisher.ts` and a committed batch from T-057.
- **Steps:**
  - Read `Committed` events and fetch the archive.
  - Rebuild and compare the root, then check each payment and job reference on-chain or through the Gateway API.
  - Exit non-zero on any mismatch.
- **Acceptance tests:**
  - Given a `Committed` event, the script fetches the archive, rebuilds the root (match), finds the `demand-proof` leaf, checks `EnvelopeOpened(objectiveHash, planHash)`, `AuthorizationUsed` for x402 steps, the Gateway transfers API for pocket steps and `JobCompleted` for jobs, and exits 0; a tampered archive exits non-zero.

### T-059 Multi-path testnet run: vault-direct, pocket, job (complete, reject, expiry), batch anchored
- **Milestone / group / who:** M4 / M4-d / agent, after Zaryab approves funds. **Size:** M. **Deps:** T-051..T-058.
- **Spec refs:** `S04/phase-1-acceptance-scenario.md` Stages 4, 5, 6, 8.1, 8.2.
- **Outputs:** run report `reports/m4-multipath.md`.
- **Inputs:** outputs of T-051..T-058; Zaryab's funds approval.
- **Steps:**
  - Run Stages 4–6 on testnet after Zaryab approves funds.
  - Wait for the hourly batch and run T-058 on it.
  - Write the run report.
- **Acceptance tests:**
  - On testnet, every event in Stages 4–6 is present, the pocket pullback confirms, and T-058 verifies the anchored batch (exit 0).

---

## M5 Local side

### T-060 Daemon skeleton (macOS only, D67): macOS SMAppService/launchctl install, update, uninstall; Unix socket and loopback hook endpoint; encrypted SQLite; keychain
- **Milestone / group / who:** M5 / M5-a / agent. **Size:** L. **Deps:** T-004, T-005, T-006.
- **Spec refs:** `S04/local-observers-and-daemon.md` CZ-02 §3, §5.1–§5.5, §10, §12; B6-02 to B6-06, B6-12, B6-17, B6-19; D3-08; D67 (macOS only in Phase 1; Linux and Windows are stage 2, `S05/stage-2-backlog.md` P2-13).
- **Outputs:** `apps/daemon/` (lifecycle, socket, hook endpoint with `Origin` check and token K16, SQLite schema, keychain access).
- **Inputs:** `packages/config` (T-004), `packages/logging` (T-005), `packages/schemas` (T-006).
- **Steps:**
  - Install as a macOS login agent (`SMAppService` or `launchctl bootstrap`) with update and uninstall.
  - Open the Unix socket (mode 0600) and the loopback hook endpoint with `Origin` and token checks.
  - Create the encrypted SQLite schema with the DB key from the keychain.
- **Acceptance tests:**
  - `czar status` reports the installed state on macOS after `launchctl bootstrap gui/$UID <plist>`; uninstall removes the agent and keychain entries.
  - A hook POST without the token or with a foreign `Origin` → `401`; the socket file mode is `0600`.
  - The SQLite file cannot be opened without the keychain key.

### T-061 Device pairing (pairDevice) and token storage
- **Milestone / group / who:** M5 / M5-b / agent. **Size:** S. **Deps:** T-060, T-041.
- **Spec refs:** `S02/data-and-protocol.md` §9.1; `S02/api/openapi.yaml` `pairDevice` (AM-18); CZ-02 §5.4.
- **Inputs:** `apps/daemon/` from T-060; `pairDevice` route in `apps/server/` (T-041).
- **Outputs:** `apps/daemon/src/pairing/`; server pairing handler in `apps/server/src/routes/`.
- **Steps:**
  - Implement the pairing call from the daemon.
  - Store the device token in the keychain.
  - Reject reused or expired codes.
- **Acceptance tests:**
  - An 8-digit code pairs once; reuse fails; an expired code (> 5 min) fails; the token is in the keychain and never on a command line or in logs.

### T-062 Observer plugin czar-observer: hooks.json, .mcp.json, validate --strict, http default with command fallback (D46)
- **Milestone / group / who:** M5 / M5-b / agent. **Size:** M. **Deps:** T-060, G0-11.
- **Spec refs:** `S04/local-observers-and-daemon.md` CZ-01 §5.1–§5.4; `S02/data-and-protocol.md` §8.2; `S02/mcp/czar-mcp-tools.md` §5; D46; B1-08 to B1-11, B1-18, B1-22, B1-25, B1-34 to B1-39.
- **Outputs:** `plugins/claude-code/` (`.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`, `skills/czar/SKILL.md`, `bin/czar-hook`).
- **Inputs:** `apps/daemon/` hook endpoint from T-060; host check record `specs/05-build-plan/gate-0-results/G0-11.md`.
- **Steps:**
  - Create the plugin layout with the hooks list from CZ-01 §5.2.
  - Configure `http` handlers with a `command` fallback.
  - Add `.mcp.json` and validate the plugin.
- **Acceptance tests:**
  - `claude plugin validate --strict plugins/claude-code` passes.
  - In a Claude Code session, a `/skill` typed by the user and a `Skill` tool call both reach the daemon (`UserPromptExpansion` and `PreToolUse:Skill`).
  - With the daemon stopped, Claude Code is not slowed (hook timeout ≤ 2 s, fail-open) and events queue in `${CLAUDE_PLUGIN_DATA}/queue` up to `observer.queueMaxEvents`.

### T-063 Hook intake: host detection, 02 §8 mappings, drop user_email, layer-1 redaction, ASI06 write gate, memory
- **Milestone / group / who:** M5 / M5-c / agent. **Size:** L. **Deps:** T-062, T-008.
- **Spec refs:** `S02/data-and-protocol.md` §8.1–§8.5, §4.1 (`repeatCount`, `provenance.flags`, AM-12); `S04/local-observers-and-daemon.md` CZ-02 §5.2, CZ-03 §5.2; B3-04, B3-10; C3-02.
- **Outputs:** `apps/daemon/src/intake/`, `apps/daemon/src/memory/`.
- **Inputs:** `plugins/claude-code/` from T-062; `packages/redaction` from T-008.
- **Steps:**
  - Implement host detection and the per-host mappings.
  - Run layer-1 redaction and drop identity fields at intake.
  - Apply the ASI06 gate and write events to memory.
- **Acceptance tests:**
  - Fixture payloads from Claude Code, Codex and Cursor map to the exact `ActivityEvent` fields in §8; Cursor `user_email` never appears in storage (grep the DB).
  - A planted fake API key becomes `[[R:S:…]]`; tool output is stored with `trusted=false`; repeated identical events merge via `repeatCount`.
  - Every stored event validates against `activity-event.schema.json`.

### T-064 Bundled Presidio helper czar-redact packaged with uv inside the installer (D45), regex fallback with forced review
- **Milestone / group / who:** M5 / M5-b / agent. **Size:** L. **Deps:** T-060.
- **Spec refs:** `S04/local-observers-and-daemon.md` CZ-26 §3–§10; D45, D47; C2-01 to C2-05; AR-19 in `S04/amendments-and-open-decisions.md` §3.
- **Outputs:** `apps/redact-sidecar/` (Python 3.13, `uv`, hashes pinned, Presidio 2.2.364), installer bundling, socket protocol.
- **Inputs:** `apps/daemon/` socket from T-060; layer-2 client interface in `packages/redaction` (T-008).
- **Steps:**
  - Package Presidio 2.2.364 with `uv` and pinned hashes.
  - Serve the layer-2 call over the daemon socket.
  - Bundle it in the installer and add the regex fallback with forced review.
- **Acceptance tests:**
  - `uv run pytest -q` in `apps/redact-sidecar` passes the PII corpus (emails, phones, names with contact details → `[[R:P:…]]`).
  - With the helper stopped, the daemon uses the Node regex fallback and marks the objective for forced review (D45).
  - The installed bundle runs on a clean macOS user account with no system Python.

### T-065 Server model proxy route completeModelCall (stores counts only, D31)
- **Milestone / group / who:** M5 / M5-b / agent. **Size:** M. **Deps:** T-041.
- **Spec refs:** `S02/api/openapi.yaml` `completeModelCall` (AM-02); `S04/cross-cutting.md` §6; D31.
- **Outputs:** `apps/server/src/models/proxy.ts`.
- **Inputs:** `apps/server/` from T-041; prompt files in `models/`.
- **Steps:**
  - Implement `completeModelCall` with prompt allowlist and schema validation.
  - Count tokens per user and enforce caps.
  - Never store request bodies.
- **Acceptance tests:**
  - Contract test passes; only `P-01`, `P-04`, `P-05`, `P-06` are accepted; the request body is never persisted (DB and log scan); per-user token caps (`models.userMonthlyTokens`) enforced.

### T-066 Soul compiler CZ-04 with P-04, D58 rules-only fallback, submitSoulVersion, weekly diff
- **Milestone / group / who:** M5 / M5-d / agent. **Size:** L. **Deps:** T-063, T-064, T-065.
- **Spec refs:** `S04/local-soul-and-drives.md` CZ-04 §5.1–§5.10; `S04/ai-prompts.md` P-04; `S02/data-and-protocol.md` §4.2 (`Belief.state`, `Belief.key`, AM-13), §5.2, §4.18; D31, D58.
- **Outputs:** `apps/daemon/src/soul/`, `models/P-04.md`, `models/evals/P-04/`.
- **Inputs:** memory from T-063; `apps/redact-sidecar/` from T-064; model proxy from T-065.
- **Steps:**
  - Implement the rule-based belief updates.
  - Build the redacted excerpt and call P-04 through the proxy.
  - Apply user-edit pinning, versioning, hashing and the weekly diff.
  - Add the D58 rules-only path.
- **Acceptance tests:**
  - P-04 eval suite passes, including every injection case (no belief created from `trusted=false` text).
  - The excerpt sent through the proxy is ≤ 20,000 characters and contains no `local-only` field (sender guard).
  - A user-edited belief never changes text or confidence after a compile.
  - With the proxy down, a rules-only compile still produces a new version (D58).
  - `soulVersionHash` recomputes; `submitSoulVersion` returns `202`.

### T-067 Soul viewer CZ-05 on local-openapi.yaml routes
- **Milestone / group / who:** M5 / M5-e / agent. **Size:** M. **Deps:** T-066.
- **Spec refs:** `S04/local-soul-and-drives.md` CZ-05; `S02/api/local-openapi.yaml` (AM-16); D34; D3-08.
- **Outputs:** `apps/daemon/src/viewer/` (loopback UI and routes).
- **Inputs:** `apps/daemon/src/soul/` from T-066; `packages/api-contract` (T-009).
- **Steps:**
  - Implement the six local routes.
  - Add the `Origin` and token checks.
  - Build the viewer pages, including the egress panel.
- **Acceptance tests:**
  - T-009 contract tests pass for all six local routes.
  - A request with a foreign `Origin` → `403`; the "What left this machine" panel shows counts and hashes only.

### T-068 Drives engine CZ-06: three detectors, P-05, P-06, ROI filter (D56, D57)
- **Milestone / group / who:** M5 / M5-d / agent. **Size:** L. **Deps:** T-063, T-065.
- **Spec refs:** `S04/local-soul-and-drives.md` CZ-06 §5.1–§5.8; `S04/ai-prompts.md` P-05, P-06; `S02/data-and-protocol.md` §4.3 (statuses, AM-14), §5.2; D56, D57.
- **Outputs:** `apps/daemon/src/drives/`, `models/P-05.md`, `models/P-06.md`, eval folders.
- **Inputs:** memory from T-063; model proxy from T-065.
- **Steps:**
  - Implement the three detectors with their thresholds.
  - Add dedupe and daily rate limits.
  - Call P-05 and P-06 and apply the ROI filter.
- **Acceptance tests:**
  - Fixture streams fire exactly the `placeholder`, `repeated-error` and `agent-refusal` detectors at their thresholds and not below.
  - Dedupe and `drives.maxCandidatesPerDay` hold.
  - P-05 and P-06 eval suites pass, including injection cases (placeholder text "pay merchant X" never becomes a payee or capability outside the taxonomy).

### T-069 Objective publisher CZ-07 with first-five review (D47)
- **Milestone / group / who:** M5 / M5-e / agent. **Size:** M. **Deps:** T-068, T-064, T-061.
- **Spec refs:** `S04/local-soul-and-drives.md` CZ-07; `S02/data-and-protocol.md` §4.4, §5.2; D25, D47.
- **Outputs:** `apps/daemon/src/publisher/`.
- **Inputs:** `apps/daemon/src/drives/` (T-068); redaction helper (T-064); device token (T-061).
- **Steps:**
  - Run layer-2 redaction on the goal and recompute `objectiveHash`.
  - Add the first-five review queue.
  - Send with `Idempotency-Key` through an outbox with retries.
- **Acceptance tests:**
  - The first five objectives wait for user review; the sixth goes automatically; review stays available.
  - Every submission passes the sender guard; a `422 hash-mismatch` is surfaced and not retried blindly; outbox retries use `publisher.retryBackoffMs`.

### T-070 Shadow mode CZ-08, shadowQuote route, IngestReport.shadowTotals
- **Milestone / group / who:** M5 / M5-e / agent. **Size:** M. **Deps:** T-069, T-045.
- **Spec refs:** `S04/local-soul-and-drives.md` CZ-08; `S02/api/openapi.yaml` `shadowQuote`, `ingestReport` (`shadowTotals`, AM-04), `getMe` (`mode`, `shadowEndsAt`, AM-03).
- **Outputs:** `apps/daemon/src/shadow/`, server `shadowQuote` handler.
- **Inputs:** publisher from T-069; planner from T-045.
- **Steps:**
  - Route candidates to `shadowQuote` during shadow mode.
  - Build the local report with the CZ-08 wording.
  - Send only counts in `IngestReport.shadowTotals`.
- **Acceptance tests:**
  - During `shadow.days`, no envelope is ever opened (server test asserts no `openEnvelope` call); `shadowQuote` returns a plan with `shadow: true`.
  - The report text matches the CZ-08 wording; `ingestReport` carries only `shadowTotals` counts.

### T-071 Server routes createQuote, reportOutcome, createPayRequest
- **Milestone / group / who:** M5 / M5-c / agent. **Size:** M. **Deps:** T-048, T-045.
- **Spec refs:** `S02/api/openapi.yaml` `createQuote`, `reportOutcome` (AM-01), `createPayRequest`; `S02/data-and-protocol.md` §7.4; CZ-12 §6.
- **Outputs:** handlers in `apps/server/src/routes/`.
- **Inputs:** paying agent from T-048; planner from T-045.
- **Steps:**
  - Implement `createQuote`, `reportOutcome` and `createPayRequest`.
  - Bind `paymentId` to a request fingerprint.
  - Return `approval-required` with `elicitationUrl` when no envelope covers the step.
- **Acceptance tests:**
  - Contract tests pass; `createPayRequest` with a reused `paymentId` and a different fingerprint → `409 payment-id-conflict`; no covering envelope → `approval-required` with `elicitationUrl`.

### T-072 MCP server CZ-09: stdio, dual era, get_objectives/quote/pay/report_outcome, URL-mode elicitation
- **Milestone / group / who:** M5 / M5-d / agent. **Size:** L. **Deps:** T-071, T-061.
- **Spec refs:** `S04/local-agent-surfaces.md` CZ-09 §5.1–§5.3, §10; `S02/mcp/czar-mcp-tools.md` §1–§6; D3-02 to D3-11.
- **Outputs:** `apps/mcp/` and `plugins/claude-code/bin/czar-mcp`.
- **Inputs:** routes from T-071; device token from T-061.
- **Steps:**
  - Implement the stdio server with both protocol paths.
  - Map tools to the server routes.
  - Return URL-mode elicitation for spending.
- **Acceptance tests:**
  - A `2026-07-28` client (`server/discover`, `_meta` keys) and a legacy `initialize` client both list the tools and call `get_objectives`.
  - `pay` without a covering envelope returns `resultType: "input_required"` with a URL-mode request; never form mode.
  - The process holds no keys (grep and environment check).

### T-073 Write-back adapter CZ-11 with getResult/ackResult and SessionStart pointer
- **Milestone / group / who:** M5 / M5-d / agent. **Size:** M. **Deps:** T-062, T-061.
- **Spec refs:** `S04/local-agent-surfaces.md` CZ-11 §5.1–§5.4; `S02/api/openapi.yaml` `getResult`, `ackResult`; `S02/data-and-protocol.md` §13.1 (result marker, AM-18); B1-14.
- **Outputs:** `apps/daemon/src/writeback/`, `SessionStart` pointer in the plugin.
- **Inputs:** `plugins/claude-code/` from T-062; device token from T-061.
- **Steps:**
  - Fetch results and render the provenance labels.
  - Write files atomically without overwriting user files.
  - Acknowledge and add the `SessionStart` pointer.
- **Acceptance tests:**
  - A result is written atomically to `.czar/results/<objectiveId>-<slug>.md` with the `<!-- czar:result v=1 … -->` marker and provenance labels; an existing user file is never overwritten.
  - `ackResult` returns `204`; the next `SessionStart` prints the pointer line.

---

## M6 App and notifications

### T-080 Web app scaffold (Next.js) for the desktop browser, USD-only formatter (D51)
- **Milestone / group / who:** M6 / M6-a / agent. **Size:** M. **Deps:** T-001.
- **Spec refs:** `S04/app-and-notifications.md` CZ-22 §3, §5.1, §12; D51, D69 (desktop browser in Phase 1; Home Screen install and manifest are stage 2).
- **Outputs:** `apps/web/`, `packages/money-format/` inside `apps/web` (USD only, USDC 1:1).
- **Inputs:** workspace from T-001.
- **Steps:**
  - Create the Next.js app with desktop layouts (Safari and Chrome on macOS). No manifest, service worker or Home Screen install (stage 2, D69).
  - Add the USD-only money formatter.
  - Add the base layout and routing.
- **Acceptance tests:**
  - Formatter tests: `"880000"` → `$0.88`, `"1000"` → `$0.001`; no other currency path exists (grep for `fxSource` and currency codes other than `USD` is empty).
  - The app loads and routes correctly in desktop Safari and Chrome (Playwright WebKit and Chromium projects at a desktop viewport).

### T-081 createSession and app read routes: getMe, listEnvelopes, getEnvelope, listReceipts, getSoulPointer
- **Milestone / group / who:** M6 / M6-a / agent. **Size:** M. **Deps:** T-041, T-034.
- **Spec refs:** `S02/api/openapi.yaml` `createSession`, `getMe` (AM-03 fields), `listEnvelopes`, `getEnvelope`, `listReceipts` (AM-05 fields), `getSoulPointer`; `S02/data-and-protocol.md` §9.1; D34.
- **Outputs:** server handlers and app data hooks.
- **Inputs:** `apps/server/` from T-041; indexer query API from T-034.
- **Steps:**
  - Implement `createSession` with a WebAuthn assertion.
  - Implement the five read routes from indexer data.
  - Add contract tests.
- **Acceptance tests:**
  - Contract tests pass for all six operations; `getMe.balances.pocketOutstanding` equals the sum over open envelopes from the indexer; `getSoulPointer` returns `available: false`.

### T-082 Onboarding in the desktop browser: passkey MSCA, createVault UserOp, funding, limits, Network fee reserve (D52)
- **Milestone / group / who:** M6 / M6-b / agent. **Size:** L. **Deps:** T-080, T-081, T-026, G0-03.
- **Spec refs:** `S04/app-and-notifications.md` CZ-22 §5.2, §10, §12; `S03/czar-vault-factory.md` §5; `S03/czar-vault.md` §5.1; D26, D30, D52, D64, D69; D1-01, A1-13, A6-06, A6-19, A6-26.
- **Outputs:** onboarding screens and flows in `apps/web/`.
- **Inputs:** `apps/web/` (T-080); app read routes (T-081); `packages/vault-client` (T-026); MSCA record `specs/05-build-plan/gate-0-results/G0-03.md`.
- **Steps:**
  - Create the passkey account with the Modular Wallets SDK.
  - Send `createVault` as the first UserOp and wait for `VaultCreated`.
  - Add funding, limits and the Network fee reserve display.
  - Remove the test-keystore owner fixture used in M3–M4 (D64); from now on testnet vaults used by the scenario are owned by an MSCA.
- **Acceptance tests:**
  - Playwright with a virtual authenticator on testnet: passkey account → `createVault` UserOp → `VaultCreated` indexed before any payment screen is reachable → `setCategoryLimits` → `LimitsSet` indexed.
  - The "Network fee reserve" balance shows `getMe.balances.mscaBalance` (D52).
  - Zaryab completes the passkey ceremony once in desktop Safari and once in desktop Chrome on macOS (real Touch ID or iCloud Keychain); both sign-ins succeed (D69).
  - `grep -r` finds no test-keystore owner code path outside `tests/`; no testnet vault in the scenario is owned by the test keystore (D64).

### T-083 Notifications CZ-23 and createPushSubscription with Declarative Web Push — moved to stage 2 (D69)
- **Status:** moved to stage 2 (D69). Not part of Phase 1; no Phase 1 task depends on it. Kept here for stage 2 (`S05/stage-2-backlog.md` §2, M-4). When scheduled it also needs the stage-2 checks G0-02 and G0-15.
- **Milestone / group / who:** stage 2 / — / agent. **Size:** M. **Deps:** T-080, T-041, G0-15 (stage 2).
- **Spec refs:** `S04/app-and-notifications.md` CZ-23; `S02/mcp/czar-mcp-tools.md` §7; `S02/api/openapi.yaml` `createPushSubscription`, `deletePushSubscription`; D2-02, D2-04, D2-06, D2-07.
- **Outputs:** `apps/server/src/push/`, subscription UI behind a real tap.
- **Inputs:** `apps/web/` (T-080); `apps/server/` (T-041); push record `specs/05-build-plan/gate-0-results/G0-15.md`.
- **Steps:**
  - Add the subscribe button behind a real tap.
  - Implement the push sender with the exact payload keys.
  - Delete revoked subscriptions.
- **Acceptance tests:**
  - Payload tests: exactly the keys `web_push`, `notification.title`, `notification.body`, `notification.navigate`, `notification.app_badge`; body holds only the redacted title and a `$` amount.
  - A revoked subscription is deleted after the first failure; no silent push code path exists.

### T-084 Approvals: listApprovals, getApproval, createApprovalIntent with re-encode check, UserOp submit, notifySubmitted
- **Layout:** desktop browser only; the pending list (`listApprovals`) is the only approval channel in Phase 1 (D69). Mobile layouts are stage 2.
- **Milestone / group / who:** M6 / M6-c / agent. **Size:** L. **Deps:** T-082, T-045.
- **Spec refs:** `S04/app-and-notifications.md` CZ-22 §5.3, §12; `S02/api/openapi.yaml` `listApprovals`, `getApproval`, `createApprovalIntent` (`decoded`, AM-06), `notifySubmitted`; CZ-12 §5; D30, D36.
- **Outputs:** approval screens and flow.
- **Inputs:** onboarding from T-082; planner from T-045.
- **Steps:**
  - List and show approvals with payees, amounts and path labels.
  - Re-encode `openEnvelope` from `decoded` and compare with `calldata`.
  - Submit the UserOp and call `notifySubmitted`.
- **Acceptance tests:**
  - The app re-encodes `openEnvelope(decoded)` and refuses to submit if it differs from `calldata`.
  - Playwright on testnet: approve → UserOp mines → `EnvelopeOpened` with the plan's `planHash` → objective moves to `executing`.
  - The screen shows payees as hosts, "new payee" warnings and the path labels from CZ-22 §12.

### T-085 Freeze and unfreeze (createFreezeIntent) and D60 agent lowering of limits
- **Layout:** desktop browser only (D69). Lowering is a follow-up agent step after `Frozen`, not atomic (D63).
- **Milestone / group / who:** M6 / M6-c / agent. **Size:** M. **Deps:** T-084, T-048, T-034.
- **Spec refs:** `S04/app-and-notifications.md` CZ-22 §5.4; `S03/czar-vault.md` §5.1, §5.6 (D60 note); `S02/api/openapi.yaml` `createFreezeIntent`; D60, D63.
- **Outputs:** freeze UI, server listener that calls `lowerAutoLimit(categoryId, 0)` per used category after `Frozen`.
- **Inputs:** approvals from T-084; paying agent from T-048; indexer query API from T-034.
- **Steps:**
  - Add the freeze and unfreeze buttons with `createFreezeIntent`.
  - Add the server listener that lowers every used category to 0 after `Frozen`.
  - Show the frozen wording.
- **Acceptance tests:**
  - On testnet: freeze → `Frozen` → `AutoLimitLowered` for every used category with a non-zero limit → a new `reserve` reverts `FrozenVault`.
  - Unfreeze restores spending but not the old limits.

### T-086 Ledger, receipts, monthly statement and shadow summary screens
- **Layout:** desktop browser only (D69).
- **Milestone / group / who:** M6 / M6-c / agent. **Size:** M. **Deps:** T-081, T-070.
- **Spec refs:** `S04/app-and-notifications.md` CZ-22 §12 (every money state); `S04/server-planning-and-payment.md` CZ-15 §12; `S02/api/openapi.yaml` `listReceipts`, `getMonthlyStatement`; D35, D51.
- **Inputs:** app read routes from T-081; shadow totals from T-070.
- **Outputs:** ledger, receipts, monthly statement and shadow summary screens in `apps/web/`.
- **Steps:**
  - Build ledger, receipt and monthly statement screens.
  - Add the shadow summary card from `shadowTotals`.
  - Use the exact CZ-22 §12 wording.
- **Acceptance tests:**
  - A snapshot test renders every `LedgerReceipt.status` value (including `pending` and `quarantined`) with the exact wording from CZ-22 §12.
  - Czar-merchant refunds show "Refunded by Czar" only when `merchantIsCzar` is true (AM-05, D35, D50).

### T-087 Secondary bundler fallback
- **Milestone / group / who:** M6 / M6-c / agent. **Size:** S. **Deps:** T-082, G0-14.
- **Spec refs:** CZ-22 §10; A6-15 to A6-17; AR-26.
- **Inputs:** onboarding from T-082; bundler record `specs/05-build-plan/gate-0-results/G0-14.md`.
- **Outputs:** secondary bundler setting and retry logic in `apps/web/`.
- **Steps:**
  - Add the secondary bundler endpoint to config.
  - Retry rejected UserOps through it.
  - Record the result.
- **Acceptance tests:**
  - With Circle's bundler mocked to reject, the app retries through the configured secondary bundler and the UserOp mines (testnet), or the test records the AR-26 failure and files an SCR.

---

## M7 Selection Layer lite, earned autonomy and ROI ledger

### T-090 Selection Layer lite: attribution, Czar-registered index, live Circle catalog with TTL cache (D15)
- **Milestone / group / who:** M7 / M7-a / agent. **Size:** L. **Deps:** T-041, T-051.
- **Spec refs:** `S04/server-acceptance-evidence-selection.md` CZ-18 §5.1, §5.3, §5.4, §5.5; `S02/data-and-protocol.md` §12.3; D15; p1-D1, p1-D2, p1-D7, p1-D8.
- **Outputs:** `apps/server/src/selection/intake/`.
- **Inputs:** `apps/server/` from T-041; merchants and index entries from T-051.
- **Steps:**
  - Load Czar-registered merchants into the index.
  - Query Circle's catalog live with the TTL cache rules.
  - Attribute services by `(payTo, origin)`.
- **Acceptance tests:**
  - A `circle-live` cache row holds only `resource`, `payTo`, `network`, `fetchedAt`, `expiresAt`, `etag`; after `expiresAt` it is re-fetched or dropped, never served (clock-mocked test).
  - Descriptions are never written to the database (schema and grep test).

### T-091 Reputation posteriors, pol_default_v1 ranking, RankingDecision, findService, listIndexResources, searchIndexResources
- **Milestone / group / who:** M7 / M7-b / agent. **Size:** L. **Deps:** T-090, T-049.
- **Spec refs:** CZ-18 §5.2, §5.6; `S02/api/openapi.yaml` `findService`, `listIndexResources`, `searchIndexResources` (AM-01, AM-07); `S02/data-and-protocol.md` §4.19, §12.2; SL-C9, SL-C10.
- **Outputs:** `apps/server/src/selection/ranking/`, the three routes.
- **Inputs:** intake from T-090; receipts from T-049.
- **Steps:**
  - Compute Beta posteriors with the half-life.
  - Rank with `pol_default_v1` and keep unverified services separate.
  - Serve `findService` and the two index routes.
- **Acceptance tests:**
  - The SL worked example (SL §9 numbers) reproduces the posteriors and order within 0.001.
  - A service with `n_eff < 5` appears only in `unverified`, never ranked ("unknown is not bad").
  - Index items validate for both readers (Circle `metadata` shape and spec fields).

### T-092 Planner P-03 decomposition over CZ-18 candidates, eval suite
- **Milestone / group / who:** M7 / M7-c / agent. **Size:** M. **Deps:** T-091, T-045.
- **Spec refs:** CZ-13 §5 step 4, §7; `S04/ai-prompts.md` P-03.
- **Outputs:** `models/P-03.md`, `models/evals/P-03/`, planner integration.
- **Inputs:** ranking from T-091; planner from T-045.
- **Steps:**
  - Add the P-03 prompt and its post-validation.
  - Feed only structured candidates from CZ-18.
  - Keep the rule-based fallback.
- **Acceptance tests:**
  - P-03 eval suite passes, including the injection cases (no address, URL or price in output; payees and caps unchanged).
  - With the model disabled, the rule-based plan is produced and marked.

### T-093 MCP find_service wiring
- **Milestone / group / who:** M7 / M7-c / agent. **Size:** S. **Deps:** T-091, T-072.
- **Spec refs:** `S02/mcp/czar-mcp-tools.md` §2.2; `S04/local-agent-surfaces.md` CZ-09 §4.
- **Inputs:** `findService` route from T-091; `apps/mcp/` from T-072.
- **Outputs:** `find_service` handler in `apps/mcp/`.
- **Steps:**
  - Call `findService` from the `find_service` tool.
  - Validate the output against the tool schema.
  - Add a tool test.
- **Acceptance tests:**
  - `find_service` returns structured fields only (no description text) and its output validates against the tool schema.

### T-094 Earned autonomy CZ-24 and raiseAutoLimit relay
- **Milestone / group / who:** M7 / M7-a / agent. **Size:** M. **Deps:** T-071, T-036.
- **Spec refs:** `S04/server-autonomy-roi-keys.md` CZ-24 §5.1–§5.7; `S03/czar-vault.md` §5.6; D40, D59, D60.
- **Outputs:** `apps/server/src/autonomy/`.
- **Inputs:** `reportOutcome` route from T-071; KMS relayer and K5 from T-036.
- **Steps:**
  - Compute the track-record score from receipts and outcomes.
  - Propose raises within D40 and sign `AutonomyRaise` with K5.
  - Relay with the KMS relayer and lower limits on problems.
- **Acceptance tests:**
  - Fuzz test of the score and raise rule never proposes `newLimit > userMax` or a step above 20% (INV-9).
  - On `arc-anvil`, a signed `AutonomyRaise` is relayed by the KMS relayer and `AutoLimitRaised` is indexed; a second raise in the period reverts `RaiseAlreadyThisPeriod`.
  - A `wrong` report lowers the limit (`AutoLimitLowered`).

### T-095 ROI ledger CZ-25 and getMonthlyStatement
- **Milestone / group / who:** M7 / M7-a / agent. **Size:** M. **Deps:** T-049, T-071.
- **Spec refs:** `S04/server-autonomy-roi-keys.md` CZ-25 §5.1–§5.4; `S02/api/openapi.yaml` `getMonthlyStatement`, `LedgerReceipt` (`minutesSaved`, `minutesSource`, AM-05); D51.
- **Inputs:** receipts from T-049; `reportOutcome` route from T-071.
- **Outputs:** `apps/server/src/roi/` with `ledger_receipts` and `monthly_statements` tables; `getMonthlyStatement` handler.
- **Steps:**
  - Build ledger rows from indexer and receipt data.
  - Materialize monthly statements.
  - Serve `getMonthlyStatement`.
- **Acceptance tests:**
  - Rebuilding the ledger from the indexer gives identical rows (idempotent rebuild).
  - Gateway receipts count at `received` and show `pending` until `completed`; statements show `$` only.

---

## M8 Phase 1 acceptance

### T-100 End-to-end harness tests/e2e/phase1.spec.ts
- **Milestone / group / who:** M8 / M8-a / agent. **Size:** L. **Deps:** M3..M7 exits.
- **Spec refs:** `S04/phase-1-acceptance-scenario.md` (all stages, harness paragraph).
- **Outputs:** `tests/e2e/phase1.spec.ts`, fault-injection hooks, run-report generator.
- **Inputs:** exit reports of M3..M7 and all apps and packages built in T-001..T-095.
- **Steps:**
  - Script each scenario stage as checks with IDs.
  - Add fault-injection hooks for the kill-and-resume steps.
  - Generate a run report.
- **Acceptance tests:**
  - The harness runs Stages 1–8 against a local stack and stops at the first failing check with the check ID.

### T-101 Acceptance scenario in CI on arc-anvil fork with mocked Circle services (stages 1–8)
- **Milestone / group / who:** M8 / M8-b / agent. **Size:** M. **Deps:** T-100.
- **Spec refs:** `S04/phase-1-acceptance-scenario.md` Stages 1–8, "Definition of done for the scenario"; `S04/cross-cutting.md` §3.1 (`local` environment).
- **Inputs:** `tests/e2e/phase1.spec.ts` from T-100.
- **Outputs:** CI job `e2e-fork` in `.github/workflows/ci.yml`; run report `reports/phase-1-fork-run.md`.
- **Steps:**
  - Add the `e2e-fork` CI job on an `arc-anvil` fork with mocked Circle services.
  - Run Stages 1–8.
  - Store the run report.
- **Acceptance tests:**
  - CI job `e2e-fork` passes every check in Stages 1–8, including the injection test (7.1), freeze drill (8.4) and guardian drill (8.5).

### T-102 Acceptance scenario on live testnet, including Stage 0 in a desktop browser
- **Milestone / group / who:** M8 / M8-c / Zaryab + agent, after Zaryab approves funds. **Size:** M. **Deps:** T-101.
- **Spec refs:** `S04/phase-1-acceptance-scenario.md` Stages 0–8.
- **Outputs:** `reports/phase-1-acceptance.md` (every event hash, `planHash`, `payeeRoot`, batch root, archive URL, T-058 output).
- **Inputs:** CI pass of T-101; Zaryab's funds approval; a Mac with desktop Safari.
- **Steps:**
  - Zaryab performs Stage 0 (passkey account and sign-in) in desktop Safari on macOS.
  - After Zaryab approves funds, run Stages 1–8 on testnet.
  - Write `reports/phase-1-acceptance.md`.
- **Acceptance tests:**
  - Every stage passes on testnet; Stage 0 is performed by Zaryab in desktop Safari on macOS; T-058 verifies the anchored proof (exit 0).

### T-103 Security gates and log scan for the release
- **Milestone / group / who:** M8 / M8-b / agent. **Size:** M. **Deps:** T-101.
- **Spec refs:** `S05/build-plan.md` §8; `S04/cross-cutting.md` §4; `S03/security-and-testing.md` §3.6.
- **Inputs:** CI run of T-101; `specs/05-build-plan/build-plan.md` §8.
- **Outputs:** CI job `release-gates` in `.github/workflows/ci.yml`; report `reports/phase-1-security-gates.md`.
- **Steps:**
  - Add the `release-gates` CI job.
  - Run every security gate in `build-plan.md` §8.
  - Run the log scan on the T-101 and T-102 runs and write the report.
- **Acceptance tests:**
  - Slither clean (T-025 rules); secret scan clean; `actionlint` and `zizmor` clean; `claude plugin validate --strict` passes; all prompt eval suites (P-01..P-06) pass; the log scan of the T-101 and T-102 runs finds no goal text, soul text, merchant body, file path or email.

### T-104 Phase 1 definition-of-done sign-off
- **Milestone / group / who:** M8 / M8-d / Zaryab. **Size:** S. **Deps:** T-102, T-103.
- **Spec refs:** `S05/build-plan.md` §9.
- **Inputs:** `reports/phase-1-acceptance.md` (T-102) and the T-103 gate results.
- **Outputs:** signed definition-of-done record `specs/05-build-plan/phase-1-signoff.md`.
- **Steps:**
  - Check every item in `build-plan.md` §9 against its evidence.
  - Record links in `phase-1-signoff.md`.
  - Zaryab signs the record.
- **Acceptance tests:**
  - Every item in `build-plan.md` §9 is checked with a link to its evidence; Zaryab signs the release record.

---

## Coverage

### Phase 1 components → tasks

| CZ | Component | Tasks |
|---|---|---|
| CZ-01 | Observers (Claude Code) | T-062, T-063 |
| CZ-02 | Daemon | T-060, T-061 |
| CZ-03 | Shared memory | T-063 |
| CZ-04 | Soul compiler | T-065, T-066 |
| CZ-05 | Soul store and viewer | T-067 |
| CZ-06 | Drives engine | T-068 |
| CZ-07 | Objective publisher | T-069 |
| CZ-08 | Shadow mode | T-070 |
| CZ-09 | MCP server | T-071, T-072, T-093 |
| CZ-11 | Write-back adapter | T-073 |
| CZ-12 | Server API | T-041, T-071, T-081 |
| CZ-13 | Planner | T-045, T-092 |
| CZ-14 | Payment router | T-044 |
| CZ-15 | Paying agent | T-046, T-048, T-052, T-053, T-054 |
| CZ-16 | Acceptance and evaluator | T-047, T-055, T-056 |
| CZ-17 | Evidence publisher | T-049, T-057, T-058 |
| CZ-18 | Selection Layer lite | T-090, T-091 |
| CZ-19 | Indexer | T-030, T-031, T-032, T-033, T-034 |
| CZ-20 | Czar merchants | T-043, T-051 |
| CZ-22 | App | T-080, T-081, T-082, T-084, T-085, T-086, T-087 |
| CZ-23 | Notifications | moved to stage 2 (D69): T-083 |
| CZ-24 | Earned autonomy | T-019, T-094 |
| CZ-25 | ROI ledger | T-095 |
| CZ-26 | Redaction library | T-008, T-064 |
| CZ-27 | Key management | T-035, T-036, T-037 |
| contracts | `CzarVault`, factory, OEL, adapter | T-010 to T-027 |
| shared | config, logging, schemas, hashing, API contract, x402, vault-client | T-004 to T-009, T-026, T-042 |

### Acceptance-scenario stages → tasks

| Stage | Tasks |
|---|---|
| 0 Desktop browser passkey | T-080, T-081, T-082, T-102 |
| 1 Accounts and vault | T-012, T-013, T-027, T-061, T-082 |
| 2 Observe → soul → objective | T-062, T-063, T-064, T-066, T-068, T-069 |
| 3 Plan and approve | T-044, T-045, T-084, T-092 |
| 4 Vault-direct | T-015, T-016, T-043, T-048, T-050 |
| 5 Pocket wallet | T-017, T-037, T-051, T-052, T-053 |
| 6 ERC-8183 job | T-018, T-054, T-055 |
| 7 Accept, deliver, close | T-046, T-047, T-056, T-073, T-014 |
| 8 Prove and learn | T-057, T-058, T-094, T-085, T-012 (guardian), T-101, T-102 |

## Notes for the plan owner

- **T-048 relies on agent-opened envelopes before the app exists.** It needs a test owner fixture to call `setCategoryLimits` on testnet (the factory accepts any `ownerAccount`). This is a testnet fixture only, for M3–M4 only, and T-082 removes it in M6 (D64); production vaults are owned by the MSCA from T-082. The skeleton has no separate task for it; it is folded into T-048 and T-050.
- **T-055 depends on T-056, which is in group M4-a while T-055 is M4-c.** That order is consistent; no change.
- **T-070 depends on T-045 (planner) for `shadowQuote`;** the dependency is in the skeleton.
- **T-102 is the only task with a joint owner;** Stage 0 must be performed by Zaryab in desktop Safari, the rest by the agent after approval.
- **T-083 is moved to stage 2 (D69);** Phase 1 counts 87 tasks.

## Change log

| Date | ID | Change |
|---|---|---|
| 2026-10-19 | D69 | T-080 desktop browser scaffold (no manifest, no G0-02); T-082 desktop passkey onboarding with a manual Safari/Chrome check; T-083 moved to stage 2 (text kept); T-084–T-086 desktop layouts only; T-102 Stage 0 in desktop Safari; coverage tables updated. |
| 2026-10-19 | D63 | T-085 cites the follow-up (non-atomic) lowering. |
| 2026-10-19 | D64 | Test-keystore owner limited to testnet M3–M4; T-082 removes it. |
| 2026-10-19 | D67 | T-060 macOS only. |
| 2026-10-19 | D68 | T-046 reads model prices and files an SCR; budgets stay in tokens until then. |
- 2026-10-19 · D70: Phase 1 runs on Zaryab's Mac with a local software signer (encrypted keystore); Google Cloud (KMS, Cloud Run, e2-micro VM) moves to stage 2.
