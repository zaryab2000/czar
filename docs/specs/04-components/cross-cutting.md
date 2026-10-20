# Cross-cutting conventions (spec 04)

- **Date:** 2026-10-18. **Status:** draft for review. Every component file in this folder follows these conventions. Data shapes come only from `docs/specs/02-data-and-protocol/` (cited as "02 §n", schema files by name, OpenAPI by `operationId`) and `docs/specs/03-smart-contracts/` (cited as "03 `<file>` §n").
- **Citation conventions:** as in specs 01–03 (`p1-` for part 1 facts, `FD-n` for forced-design items, `AR-n` for spec 01 assumptions, `K1–K20` keys, `CZ-nn` components, `OD-nn` open decisions).
- **Status wording:** Czar is a production system that moves user funds.

## 1. Monorepo layout and package names

One `pnpm` workspace (Node 22 LTS, ESM only, TypeScript strict; spec 01 §17). Contracts live in a Foundry project inside the same repo.

| Path | Package | What it is | Runs where |
|---|---|---|---|
| `apps/daemon` | `@czar/daemon` | CZ-02 daemon, CZ-03 memory, CZ-04 soul compiler, CZ-05 soul store/viewer, CZ-06 drives, CZ-07 publisher, CZ-08 shadow, CZ-11 write-back | user machine |
| `apps/redact-sidecar` | `czar-redact` (Python 3.13, `uv`) | layer 2 of CZ-26 (Presidio) | user machine, child of the daemon |
| `apps/mcp` | `@czar/mcp` | CZ-09 local MCP server (stdio) | user machine, child of the agent host |
| `plugins/claude-code` | `czar-observer` (Claude Code plugin) | CZ-01 observer: `hooks/hooks.json`, `.mcp.json`, `skills/`, `bin/` | inside Claude Code (and Cursor, Codex) |
| `apps/server` | `@czar/server` | CZ-12 API, CZ-13 planner, CZ-14 router, CZ-15 paying agent, CZ-16 acceptance/evaluator, CZ-17 evidence, CZ-18 Selection Layer, CZ-23 push (stage 2, D69), CZ-24 autonomy, CZ-25 ROI | Czar server |
| `apps/indexer` | `@czar/indexer` | CZ-19 Ponder project | Czar server |
| `apps/merchants` | `@czar/merchants` | CZ-20 Czar's x402 sellers | Czar server |
| `apps/claim-server` | `@czar/claim-server` | CZ-21 (Phase 2) | Czar server |
| `apps/web` | `@czar/web` | CZ-22 web app (Next.js); desktop layouts only in Phase 1; Home Screen install and mobile layouts are stage 2 (D69) | desktop browser (Safari or Chrome on macOS) |
| `packages/schemas` | `@czar/schemas` | the 19 JSON Schemas from 02 compiled to TypeScript types and validators (Ajv 8, 2020-12); nothing else defines a shape | all |
| `packages/hashing` | `@czar/hashing` | 02 §5: JCS canonicalization, `H()`, named hashes, `czar-merkle-v1` trees and proofs, nonce and salt derivation (02 §7.2, §7.3) | all |
| `packages/redaction` | `@czar/redaction` | layer 1 (gitleaks rules in TypeScript) and the marker format (02 §3.1); the layer-2 client for the sidecar | daemon, server (layer 1 only) |
| `packages/x402` | `@czar/x402` | buyer and seller helpers over `@x402/core` / `@x402/evm` 2.28.0 and `@circle-fin/x402-batching` 3.5.0, exactly as 02 §11 | server, merchants |
| `packages/vault-client` | `@czar/vault-client` | typed calls to `ICzarVault` / `ICzarVaultFactory` (viem), signature-envelope encoders (02 §6.3), WebAuthn helpers for the D30 fallback | server, web |
| `packages/config` | `@czar/config` | the named-parameter registry (§3) with defaults, env overlay and a printable dump | all |
| `packages/logging` | `@czar/logging` | JSON logs with the field allowlist (§4) | all |
| `contracts/` | Foundry project (`arc-forge`) | `CzarVault`, `CzarVaultFactory`, `OpenEvidenceLog`, Phase 2 contracts, tests | Arc |
| `models/` | prompt files for `ai-prompts.md` (`P-01` … `P-06`), versioned; prompt hash is logged with every call | server, daemon |

- Package boundaries follow privacy: `apps/daemon` depends on `@czar/schemas`, `@czar/hashing`, `@czar/redaction`; it never imports `@czar/vault-client` or `@czar/x402` (it holds no keys and pays nothing, D25).
- Absolute imports only (`@czar/...`); no relative `..` paths.

## 2. Shared libraries: what each guarantees

| Library | Guarantee | Tests |
|---|---|---|
| `@czar/schemas` | a value that passes `validate<Name>()` is exactly the 02 object; `privacyClassOf(name, field)` reads the `x-privacyClass` annotation so senders can assert nothing `local-only` crosses a link | property tests: every schema example in 02 §4 validates; every `local-only` field is rejected by the `ObjectiveSubmission` sender guard |
| `@czar/hashing` | reproduces the six digests and the derived nonce in `02/vectors/eip712-vectors.json` byte for byte; Merkle roots verify with OpenZeppelin `MerkleProof` | the vectors file is the fixture; a Foundry test consumes the same fixture (03 `security-and-testing.md` §3.1) |
| `@czar/redaction` | layer 1 replaces every match of the pinned gitleaks rule set with a `[[R:S:<rule>]]` marker; markers are never reversible; idempotent | the gitleaks test corpus at the pinned tag; mutation tests |
| `@czar/x402` | parses v2 headers and the v1 fallback per 02 §11.2; refuses `upto`, `batch-settlement`, cross-chain offers, and any `accepts[]` entry whose network is not in `x402.allowedPaymentNetworks` (Phase 1: `[eip155:5042002]`, D83); sanitizes extensions per 02 §11.3; owns `safeFetch`, the only way any Czar server process fetches an outside URL (§2.1, RV-022) | fixtures from `x402-flow.mjs` (A1-17) and the A2 seller logs; the §2.1 SSRF corpus |
| `@czar/vault-client` | every encoder output matches 03 `czar-vault.md` §6 and reverts are decoded to the custom-error names | `arc-anvil` fork tests against the compiled interfaces |
| `@czar/config` | every parameter in this folder exists in the registry with its default; unknown keys fail at startup | snapshot test of the dump |
| `@czar/logging` | a log line cannot contain a field outside the allowlist (§4); a redaction marker may appear, raw text may not | unit test with a corpus of forbidden strings |

### 2.1 `safeFetch`: the shared SSRF-safe fetcher (RV-022)

Every outbound fetch of a URL that came from outside Czar's own code goes through `safeFetch` in `@czar/x402`. Under D70 the server, signer, Postgres and indexer share one Mac, so an unguarded fetch could reach them.

| Rule | Value |
|---|---|
| Scheme and port | `https` on port 443 only. The one exception is `fetch.localMerchantOrigins` (below) |
| DNS | resolved once per request; every resolved address checked; the connection goes to the checked address (pinned), with the original host in SNI and `Host`; no second lookup (no DNS rebinding) |
| Blocked addresses | loopback (127.0.0.0/8, ::1), RFC 1918, link-local (169.254.0.0/16 including 169.254.169.254, fe80::/10), ULA (fc00::/7), CGNAT (100.64.0.0/10), multicast, broadcast, 0.0.0.0/8, ::, IPv4-mapped and IPv4-compatible forms of any of these, and any address of the machine's own interfaces |
| Redirects | at most `fetch.maxRedirects` 3; each target is re-checked by every rule above before connecting |
| Limits | response ≤ the caller's byte cap (default `fetch.maxBytes` 2 MiB; deliverables `acceptance.deliverableMaxBytes`); timeout ≤ the caller's (default `fetch.timeoutMs` 8,000) |
| Request hygiene | no cookies, no credentials, no `Authorization` header unless the caller passes one for that exact origin; fixed `User-Agent: Czar/<version>` |
| Local merchants (Phase 1) | `fetch.localMerchantOrigins` lists the exact `http://127.0.0.1:<port>` origins of Czar's own merchants (CZ-20) running on the Mac (D70). Only those origins bypass the loopback rule; the list comes from `@czar/config`, never from a catalog entry, a 402 body, an MCP input or a user. The signer has no TCP port (CZ-27 §3) and Postgres's port is never in the list |
| Failure | `StepError` / `czarCode` `fetch-blocked` (not retryable) with the rule name; logged without the URL query string |

**Callers (all must use it):** CZ-13 planner probes; CZ-14/CZ-15 pre-pay probes and merchant calls; `createQuote` probes (including an optional `resourceUrl`); CZ-16 deliverable fetches; CZ-18 catalog crawls and live Circle catalog reads; CZ-20 `czar-extract` (which adds its domain allowlist on top). **Superseded by RV-022:** the private-range block living only in `czar-extract`.

**Tests (`@czar/x402`):** a corpus of URLs and DNS answers that must be refused: `http://` scheme, port 8443, `localhost`, `127.1`, `0x7f000001`, `[::ffff:127.0.0.1]`, a public name resolving to 10.0.0.5, a redirect from a public host to 169.254.169.254, a name whose second resolution would change (pinning test); and the configured local merchant origin, which must pass.

## 3. Configuration and environments

### 3.1 Environments

| Name | Chain | RPC | Contracts | Circle services | Use |
|---|---|---|---|---|---|
| `local` | `arc-anvil --network arc --chain-id 5042002`, or a fork of testnet at a pinned block | `http://127.0.0.1:8545` | deployed by the test script; USDC, GatewayWallet, ERC-8183 from the fork (A9-13, A9-14) | mocked (`/verify`, `/settle`, Gateway API) by the test harness | unit, integration, CI |
| `testnet` (hosted on Zaryab's Mac in Phase 1, D70) | `5042002` | `https://rpc.testnet.arc.io` primary, one keyed provider secondary (A9-07, A9-08); never `rpc.testnet.arc.network` | factory and OEL at their CREATE2 addresses; Circle's ERC-8183 `0x0747…4583`; GatewayWallet `0x0077…19B9`, Minter `0x0022…475B` | Facilitator `https://api.circle.com/v1/facilitator/x402/*` with `network: eip155:5042002` (A1-15); Gateway `https://gateway-api-testnet.circle.com` (A2-30); Discovery `https://api.circle.com/v2/x402/discovery/resources` (p1-D1) | the running product |
| `mainnet` | `5042` | `https://rpc.mainnet.arc.io` + keyed | per 03 `czar-vault.md` §14 | mainnet Gateway API, Facilitator with a Console key (p1-F4) | **not a step Czar takes in this spec** (§8) |

### 3.2 Parameter registry (`@czar/config`)

- Every threshold, timeout, retry count and limit named in this folder is a key in one registry, with a default, a unit and a one-line reason. Components reference keys by name (for example `routing.maxFeeRatioBps`).
- Overlay order: built-in defaults → environment file (`local`, `testnet`) → process environment variables (`CZAR_<SECTION>_<KEY>`) → nothing else. There is no remote config in Phase 1.
- **No secrets in config (D78, RV-028):** the loader refuses to start if any configuration key or `CZAR_*` environment variable name contains `passphrase`, `secret`, `private`, `mnemonic` or `seed`, and no command accepts such a value as an argument. Secrets reach a process only from the OS keychain (§3.3).
- The registry dump (`czar config dump`) is attached to every incident report.
- Naming: `<component>.<name>`; units in the name when ambiguous (`...Ms`, `...Blocks`, `...Bps`, `...Atomic`).
- Contract constants (03 `czar-vault.md` §3) are **not** configurable; the registry only mirrors them read-only (`vault.maxAuthorizationsPerReservation = 128`, D39) so routing math uses the deployed values.

### 3.3 Secrets

- Server keys sit behind the signer service (D61, D62). **Phase 1 (D70, D78):** backend `local-keystore` on Zaryab's Mac: an encrypted keystore at `signer.keystorePath` (`~/Library/Application Support/Czar/signer/keystore/`), always **outside the repository**, whose passphrase lives only in the macOS keychain item `signer.keychainService` and is read by the signer process itself, never passed through argv, environment variables or files (CZ-27 §3). Testnet keys only. **Superseded by D78:** "keystore files are gitignored" (inside the repository). **Stage 2:** backend `gcp-kms` (Google Cloud KMS). The HSM question is settled at the pre-mainnet audit.

- Server secrets (K3–K13, K17–K20) live in the signer backend or the secret store (spec 01 §7.2); process environment holds only references (`CZAR_KMS_KEY_ID_AGENT`), never key material. In Phase 1 the secret store for K11, K12, K18, K19 is the macOS keychain (D70).
- Machine secrets (K14 DB key, K15 device token, K16 hook token) live in the OS keychain through `@napi-rs/keyring` 2.1.1, Linux pinned to Secret Service (B6-17); never on a command line (B6-19).
- `.env` files are for `local` only and are gitignored.

## 4. Logging, metrics and audit (no personal data)

- Format: one JSON object per line (pino-style), UTC timestamps, `service`, `component` (`CZ-nn`), `event` (snake_case), `traceId`, `spanId`.
- **Field allowlist** (anything else is dropped by `@czar/logging`): ids with Czar prefixes (`obj_`, `pln_`, `stp_`, `pay_`, `res_`, `dev_`, `bat_`), `envelopeRef`, `reservationId`, `pullbackId`, `jobKey`, hashes (`Hash32`), addresses, amounts (`Amount6`), counts, durations, enum states, `czarCode`, HTTP status, chain block numbers and tx hashes, origin hosts (never full URLs with query strings), model name and prompt hash, token counts.
- **Never logged:** objective `goal` text, soul text, merchant bodies, `StepResult.fields[].value`, hook payloads, file paths, emails, IPs beyond a /24 or /48 truncation (SL §11), push bodies (stage 2, D69).
- Daemon logs stay on the machine (`~/Library/Logs/Czar/` on macOS, rotated, 14 days) and are shown in the viewer's "What left this machine" panel as counts and hashes (spec 01 §16.3).
- Metrics (server): Prometheus-style counters and histograms named `czar_<component>_<metric>`; labels limited to enums.
- Audit log (server, append-only table `audit`): actor key id (`K3`…), action, object ids, amounts, tx hashes, timestamp, outcome (spec 01 §16.3). Retained 1 year.

## 5. Error-code catalogue

### 5.1 API `czarCode` (02 §9.4)

`validation`, `idempotency-conflict`, `replay-not-stored` (RV-043), `device-revoked`, `session-expired`, `hash-mismatch`, `plan-expired`, `envelope-not-open`, `approval-required`, `payment-id-conflict`, `plan-not-approved`, `step-not-in-plan`, `step-calls-exhausted`, `step-cap-exhausted`, `input-not-in-template`, `input-redaction-hit`, `resource-not-indexed` (RV-019, RV-021), `fetch-blocked` (RV-022), `network-not-payable` (D83), `rate-limited`, `upstream-unavailable` (retryable), `frozen`, `paused`.

### 5.2 `StepError.code` (02 §4.16; used by MCP tools and the paying agent)

| Code | Meaning | Retryable |
|---|---|---|
| `price-or-payee-drift` | live 402 amount above the step cap or `payTo` not in the step's leaves (02 §11.2 step 4) | no (re-plan) |
| `unsupported-offer` | only `upto`, `batch-settlement`, SIWX-only, or a foreign-chain offer (02 §11.2 step 3) | no |
| `flow-refused` | `upfront` flow from an untrusted payee (02 §11.2 step 5) | no |
| `reserve-failed` | vault reverted (`CapExceeded`, `PayeeNotInPlan`, `FrozenVault`, `Paused`, …; decoded name attached as `detail`) | depends |
| `verify-rejected` | merchant or Facilitator returned a 4xx after `PAYMENT-SIGNATURE` | once, same header |
| `settlement-pending` | `errorReason: settlement_pending` (A3-11); reconciliation running | automatic |
| `unpaid` | settlement failed; nothing moved | re-plan |
| `delivery-failed` | 2xx missing or body over limit (acceptance `delivery` fail) | re-plan |
| `structural-failed` | acceptance `structural` fail | re-plan |
| `injection-quarantined` | screen flagged the body, or the screen was unavailable (D76); shown to the user; recorded `inconclusive` (RV-042) | no |
| `fetch-blocked` | `safeFetch` refused the URL (§2.1, RV-022) | no |
| `network-not-payable` | a service or network outside `selection.paymentNetwork` was named for search, quote or pay (D83) | never; the market view is rank-only in Phase 1 |
| `step-calls-exhausted` / `step-cap-exhausted` | the step's approved call budget or cap is used (RV-019) | after a new approval |
| `pocket-funding-failed` | `DelegateNotSet`, `PocketCapExceeded`, Gateway API error | depends |
| `pullback-pending` | pullback requested, not yet minted | automatic |
| `job-budget-too-high` | `BudgetExceedsReserved` | re-plan or renegotiate |
| `job-fees-changed` | `UnexpectedFees` | re-plan |
| `approval-required` | no open envelope covers the step | after approval |
| `frozen` / `paused` | vault frozen or guardian pause | after unfreeze |
| `upstream-unavailable` | RPC, Facilitator, Gateway or model down | automatic with backoff |

### 5.3 Contract errors

Decoded by `@czar/vault-client` to the names in 03 `czar-vault.md` §9.2 and `czar-vault-factory.md` §7; never surfaced to the user raw (see §12 wording in each component).

## 6. Models and the overall model budget

### 6.1 Model classes

| Prompt | Role | Model class | Why | Spec |
|---|---|---|---|---|
| P-01 `screen` | injection screen on every untrusted text before any other model sees it | smallest current Claude model (`claude-haiku-5-5`, the class named in C3-04 for screening tool results) | cheap, fast, structured output only | `ai-prompts.md` |
| P-02 `reader` | turns untrusted merchant output into a `StepResult` (02 §4.15) | small model, no tools | the only model that sees seller text; it has no money and no tools (C3-09 split) | `ai-prompts.md` |
| P-03 `planner` | decomposes an objective into steps over structured inputs only | mid-size current Claude model (`claude-sonnet-5-5`) | quality on decomposition; never sees raw text | `ai-prompts.md` |
| P-04 `soul-compiler` | updates beliefs from redacted excerpts (D31) | mid-size model via the Czar proxy | quality; structured output | `ai-prompts.md` |
| P-05 `drives-helper` | writes the plain-language goal and capability tags for a detected open loop | small model (local call via the proxy) | low stakes, cheap | `ai-prompts.md` |
| P-06 `refusal-classifier` | labels `last_assistant_message` text as refusal / not (observer helper) | regex first; small model only when regex is inconclusive | keeps the daemon cheap | `ai-prompts.md` |

- Model ids above are the Claude platform ids current on 2026-10-18 (environment-provided; STRONG SIGNAL). Prices were not read this session: **GAP**. Model prices are read in build task T-046 (D68); until then every budget stays in tokens and request counts, and T-046 converts them to money from the platform pricing page.
- All model calls use structured outputs (JSON schema) and the system prompts in `models/`; the prompt file hash is logged with every call.
- No model ever receives: keys, raw hook payloads, soul text outside the redacted excerpt, merchant bodies (except P-01 and P-02), or user text outside the goal and the `TaskSpec` (D84).

### 6.2 Token budget per user per month (defaults, `models.*`)

| Prompt | Calls / month (typical) | Tokens / call (in + out, cap) | Monthly cap (tokens) | Parameter |
|---|---|---|---|---|
| P-01 screen | 300 | 4,000 | 1.2 M | `models.screenMonthlyTokens` |
| P-02 reader | 300 | 6,000 | 1.8 M | `models.readerMonthlyTokens` |
| P-03 planner | 40 | 12,000 | 0.5 M | `models.plannerMonthlyTokens` |
| P-04 soul compiler | 30 (nightly) | 24,000 | 0.72 M | `models.soulMonthlyTokens` |
| P-05 drives helper | 60 | 2,000 | 0.12 M | `models.drivesMonthlyTokens` |
| P-06 refusal | 20 | 1,000 | 0.02 M | `models.refusalMonthlyTokens` |
| **Total** | | | **≈ 4.4 M tokens** | `models.userMonthlyTokens` (hard cap 6 M) |

- When a cap is hit the component falls back per its "AI usage" section (no model); it never silently continues.
- Latency budgets: P-01 ≤ 2 s, P-02 ≤ 8 s, P-03 ≤ 20 s, P-04 ≤ 60 s, P-05 ≤ 5 s, P-06 ≤ 2 s (`models.<name>.timeoutMs`).

## 7. Dependency pinning list

| Dependency | Version | Where | Fact |
|---|---|---|---|
| Node.js | 22 LTS (buyer SDK needs ≥ 22.18, p1-G13) | daemon, server, mcp | p1-G13, spec 01 §17 |
| `viem` | 2.57.x (has `arc`, `arcTestnet`) | all chain code | A9-05 |
| `@x402/core`, `@x402/evm`, `@x402/extensions` | 2.28.0 (pin; watch the pending auth-capture breaking change) | `@czar/x402` | F2-02, F2-04 |
| `@circle-fin/x402-batching` | 3.5.0 (server and client; hand-built burn intents, never `GatewayClient.withdraw()`) | merchants, paying agent | F2-01, A2-12, A2-31 |
| `@circle-fin/modular-wallets-core` | 1.0.16 | web | A6-06 |
| `ponder` | 0.18.x | indexer | A9-05 |
| `better-sqlite3-multiple-ciphers` | 13.0.3 | daemon | B6-12 |
| `@napi-rs/keyring` | 2.1.1 (Linux: Secret Service pinned) | daemon, mcp | B6-17 |
| `sqlite-vec` | 0.1.9 (pre-1.0; pin exact; re-index on upgrade) | daemon (Phase 2 vectors) | C1-12 |
| gitleaks rules | `config/gitleaks.toml` at v8.30.1 (222 rules, MIT), vendored | `@czar/redaction` | C2-06 |
| Presidio (`presidio-analyzer`, `presidio-anonymizer`) | 2.2.364, Python ≥ 3.10 < 3.15; repo now `data-privacy-stack/presidio` | `czar-redact` sidecar | C2-01, C2-02 |
| Ajv | 8 (JSON Schema 2020-12) | `@czar/schemas`, acceptance `structural` checks | SL-C7 |
| Next.js, React, Tailwind | current stable, pinned in the build plan | web | spec 01 §17 |
| Postgres | 16; `pgvector` ≤ 1,024 dims | server | C1-13, FD-30 |
| Foundry | `arc-foundry` v0.8.0-2 from the checksummed release (never `foundryup`); solc 0.8.30, `evm_version = prague` | contracts | A9-12, A9-13, 03 `czar-vault.md` header |
| OpenZeppelin | v5.7.0 | contracts | 03 |
| MCP SDK | the official TypeScript SDK at a version that speaks `2026-07-28` and legacy `initialize` | mcp | D3-01, D3-02; exact version **GAP** (check at build) |
| Embeddings (Phase 2) | `text-embedding-3-small` or `voyage-4-lite`, ≤ 1,024 dims | Selection Layer retrieval | C1-01, C1-02 |

Supply-chain rules (CLAUDE.md): `pnpm audit --audit-level=moderate`, `minimumReleaseAge 1440`, `ignore-scripts true`, exact versions; Python with `uv` and hashes.

## 8. Mainnet differences (summary; each component repeats its own)

| Topic | Testnet | Mainnet |
|---|---|---|
| Chain, RPC | 5042002, `rpc.testnet.arc.io` | 5042, `rpc.mainnet.arc.io` + keyed providers |
| Gateway contracts | `0x0077…19B9` / `0x0022…475B` | `0x7777…00eE` / `0x2222…C205` (SDK constant; verify on-chain first); code hash differs (GAP A2-G2) |
| Gateway API | keyless (A2-30) | key slot K12 |
| Facilitator | keyless trial for `exact` (A1-15) | Console API key (K11) |
| ERC-8183 | Circle's instance, adapter kind `CircleTestnet` | `CzarJobEscrow`, kind `CzarBase` (D32) |
| Merchants | Czar's own (D14) plus live catalog items on testnet (134, mostly RPC, p1-D6) | 2,195 catalog items on Arc mainnet (p1-D6) |
| Explorer API | keyless, rate-limited (A9-10) | blocked for scripts (A9-11); own indexer only |
| Discovery | same keyless endpoint | same |
| Gas | floor 20 Gwei; thresholds from estimates | floor 20 Gwei; thresholds from measured gas |
| Vault-direct proof | live (A1-17) | simulation only (A1-11); rerun AR-3/AR-4/AR-5 before any spend (03 `security-and-testing.md` §5) |
| Display currency | USD only, USDC 1:1 (D51) | same unless local currency is added later |
| Evidence archives | Czar's object store, public HTTPS `archiveUri`, hash on-chain (D54) | Phase 2 adds IPFS pins |
| Spending | testnet USDC from faucet | real money; **no mainnet deployment or spend is a step in this spec** |

## Change log

| Date | ID | Change |
|---|---|---|
| 2026-10-18 | D61, D62 | KMS and relayer key note in §3.3 |
| 2026-10-18 | D51, D54 | USD display and server-side archives in the mainnet table |
| 2026-10-19 | D69 | `apps/web` runs in a desktop browser; push tagged stage 2. |
| 2026-10-19 | D68 | model prices read in T-046; budgets stay in tokens and request counts until then. |
| 2026-10-19 | D70 | Phase 1 runs on Zaryab's Mac with a local software signer (encrypted keystore); Google Cloud (KMS, Cloud Run, e2-micro VM) moves to stage 2. |
| 2026-10-19 | RV-022 | §2.1 shared `safeFetch` in `@czar/x402`; all outbound fetches use it. |
| 2026-10-19 | D78, RV-028 | keystore outside the repository; no secret-like config keys or env vars. |
| 2026-10-19 | RV-019, RV-021, RV-043, D76 | new `czarCode` and `StepError` codes. |
| 2026-10-20 | D83 | `@czar/x402` buyer refuses networks outside `x402.allowedPaymentNetworks`. |
