# Amendments, open decisions, assumptions, gaps, flags (spec 04)

- **Date:** 2026-10-18. Merged from every component file in this folder. Nothing here changes specs/02 or 03 by itself; each amendment is a proposal with the exact field or route. No locked decision (D1–D44) is contradicted.

## 1. Proposed amendments to specs/02 and 03

| # | Target | Exact change | Why (component) | Status |
|---|---|---|---|---|
| AM-01 | 02 `api/openapi.yaml` (daemon surface) | Add `POST /v1/quotes` (`createQuote`; request/response = the MCP `quote` tool schemas), `POST /v1/services/search` (`findService`; = `find_service` schemas), `POST /v1/outcomes` (`reportOutcome`; request = `report_outcome` input, response `{recorded, receiptObsId?}`). `shadowQuote` returns a `shadow: true` Plan, not a `quoteId`, so `quote` cannot reuse it. | CZ-09, CZ-13, CZ-24 | **Applied** in 02 `api/openapi.yaml` `findService` `/v1/services/search`, `createQuote` `/v1/quotes`, `reportOutcome` `/v1/outcomes`; `data-and-protocol.md` §9.2, §10; `mcp/czar-mcp-tools.md` §2.2, §2.3, §2.5 |
| AM-02 | 02 `api/openapi.yaml` (daemon surface) | Add `POST /v1/models/complete` (`completeModelCall`, auth `DeviceToken`): body `{prompt: "P-01"\|"P-04"\|"P-05"\|"P-06", promptHash, input, schema}`, response `{output, usage: {inputTokens, outputTokens}}`; the server stores only counts (D31). | CZ-04, CZ-06 | **Applied** in 02 `api/openapi.yaml` `completeModelCall` `/v1/models/complete`; `data-and-protocol.md` §9.2 |
| AM-03 | 02 `api/openapi.yaml` `Me` | Add `mode: "shadow" \| "live"`, `shadowEndsAt` (RFC 3339), `limits[].periodEndsAt` (RFC 3339), `balances.pocketOutstanding` (`Amount6`, sum over open envelopes). Today `limits[]` has `category, userMax, autoLimit, usedThisPeriod, periodId` and `balances` has `vaultBalance, free, committed, mscaBalance, asOfBlock`. | CZ-08, CZ-22, CZ-24 | **Applied** in 02 `api/openapi.yaml` `Me.mode`, `Me.shadowEndsAt`, `Me.limits[].periodEndsAt`, `Me.balances.pocketOutstanding` |
| AM-04 | 02 `api/openapi.yaml` `IngestReport` | Add optional `shadowTotals: {minutesObserved: integer, estimatedSpendAtomic: Amount6, objectivesPriced: integer}` so the web app can show a shadow summary card without objectives leaving the machine (D25, D34). Today it has `deviceId, periodStart, periodEnd, eventsIngested, redactionHits, hosts`. | CZ-08, CZ-22 | **Applied** in 02 `api/openapi.yaml` `IngestReport.shadowTotals`; `data-and-protocol.md` §9.2 |
| AM-05 | 02 `api/openapi.yaml` `LedgerReceipt` | Add `merchantIsCzar: boolean`, optional `minutesSaved` (integer), `minutesSource: "estimate" \| "reported"`; add `quarantined` to the `status` enum. | CZ-22, CZ-25, CZ-15 | **Applied** in 02 `api/openapi.yaml` `LedgerReceipt.merchantIsCzar`, `minutesSaved`, `minutesSource`, `status` `quarantined` |
| AM-06 | 02 `api/openapi.yaml` `ApprovalIntent.decoded` | Fix `decoded` to the `OpenEnvelopeParams` field list (03 `ICzarVault.OpenEnvelopeParams`) instead of `additionalProperties: true`, so the app's re-encode check is schema-backed. | CZ-22 | **Applied** in 02 `api/openapi.yaml` `ApprovalIntent.decoded` (8 `OpenEnvelopeParams` fields) |
| AM-07 | 02 `api/openapi.yaml` (public) | Add the two index routes from 02 §12.1: `GET /v2/x402/discovery/resources` (`listIndexResources`) and `GET /v2/x402/discovery/search` (`searchIndexResources`), no auth, rate-limited; Phase 2: `GET /v1/snapshots`, `GET /v1/snapshots/{id}` (SL-C11). | CZ-18 | **Applied** in 02 `api/openapi.yaml` tag `public`: `listIndexResources`, `searchIndexResources`; Phase 2 `listSnapshots`, `getSnapshot` (`x-phase: 2`); `data-and-protocol.md` §9.2 |
| AM-08 | 02 §4.11 `JobRecord` | Add `deliverableUri?: string` (server-only) and the deliverable convention: `https://<provider-host>/.well-known/czar-deliverable/<deliverable-hex>` whose content keccak256-hashes to `deliverable`. The EIP fixes only the `bytes32` (A4-03). | CZ-16, CZ-15 | **Applied** in 02 `data-and-protocol.md` §4.11; `schemas/job-record.schema.json` `deliverableUri` (D53 `.well-known` convention) |
| AM-09 | 02 §4.6 `Step.inputTemplate` | Define the optional sub-field `expectedKeys: string[]` used by the `requirement` check and by P-02 `expectedFields`. | CZ-16, CZ-13 | **Applied** in 02 `data-and-protocol.md` §4.6; `schemas/plan.schema.json` `Step.inputTemplate.expectedKeys` |
| AM-10 | 02 §4.13 / §6.3.3 | State which key signs `erc8183-job` receipts: the vault's `SL_RECEIPT` kind (the vault is the job client), as for vault-direct. | CZ-17 | **Applied** in 02 `data-and-protocol.md` §4.13, §6.3.3 |
| AM-11 | 02 §4.14 `AcceptanceReport` | Add `limits` values `no-correctness-check`, `screen-unavailable`, `sandbox-timeout`, and the `flags` value `injection-quarantined`, to the documented vocabulary. | CZ-16 | **Applied** in 02 `data-and-protocol.md` §4.14; `schemas/acceptance-report.schema.json` |
| AM-12 | 02 §4.1 `activity-event.schema.json` | Add optional `repeatCount` (integer, `local-only`) and `provenance.flags` (array of `injection-suspect`, `local-only`). | CZ-03 | **Applied** in 02 `data-and-protocol.md` §4.1; `schemas/activity-event.schema.json` |
| AM-13 | 02 §4.2 `soul.schema.json` | Add `Belief.state` (`candidate\|active\|faded\|archived`) and `Belief.key` (normalized dedupe key), both `local-only`; alternatively keep them as daemon columns only (then no change). | CZ-04 | **Applied** in 02 `data-and-protocol.md` §4.2; `schemas/soul.schema.json` `$defs.Belief.state`, `Belief.key` (local-only) |
| AM-14 | 02 §4.3 `Objective.status` | Extend the local enum to `candidate\|dismissed\|shadowed\|published`. | CZ-06, CZ-08 | **Applied** in 02 `data-and-protocol.md` §4.3; `schemas/objective.schema.json` `status` |
| AM-15 | 02 §7.1 | Add id prefix `cand_` (belief candidate between the rules and P-04, local-only). | CZ-04 | **Applied** in 02 `data-and-protocol.md` §7.1 (`cand_`) |
| AM-16 | 02 §9 | Document the daemon's loopback routes for the viewer (`GET /local/soul`, `POST /local/soul/beliefs/{beliefId}`, `GET /local/soul/diff`, `GET /local/soul/receipts/{beliefId}`, `GET /local/shadow/report`, `GET /local/audit/egress`) in a separate local OpenAPI file so the shapes have one home. | CZ-05 | **Applied** in new 02 `api/local-openapi.yaml` (`getLocalSoul`, `editLocalBelief`, `getLocalSoulDiff`, `getLocalBeliefReceipts`, `getLocalShadowReport`, `getLocalEgress`); `data-and-protocol.md` §9.2 |
| AM-17 | 02 §12.2 | Optional `extensions.czar.rail: "x402-exact" \| "gateway-batched"` on Czar-registered items so the two routes of one service are distinguishable without parsing `accepts[]`. | CZ-20 | **Applied** in 02 `data-and-protocol.md` §12.2 |
| AM-18 | 02 §13.1 / `api/openapi.yaml` `pairDevice` | Add the result-file marker `<!-- czar:result v=1 … -->` to the marker family; state in the `pairDevice` description that the response is returned once and the 8-digit code is single-use for 5 minutes. | CZ-11, CZ-02 | **Applied** in 02 `data-and-protocol.md` §13.2 marker family; `api/openapi.yaml` `pairDevice` description |
| AM-19 | 03 `czar-vault.md` §9.1 | Document the numeric mapping of `JobSynced.state` (`uint8`) to 02 §4.11 `JobRecord.state`. | CZ-19 | **Applied** in 03 `czar-vault.md` §9.1 (mapping paragraph before §9.2) |
| AM-20 | 03 `czar-vault.md` §5.6 | State explicitly in the function table that `raiseAutoLimit` accepts an empty `sig` when `msg.sender == owner` (the interface NatSpec already says so). | CZ-24 | **Applied** in 03 `czar-vault.md` §5.6 `raiseAutoLimit` row |

## 2. Open decisions for Zaryab

| # | Decision | Options | Recommendation | Confidence | Status |
|---|---|---|---|---|---|
| OD-17 | Layer-2 redaction runtime | Python sidecar with Presidio / Node-only regex PII for Phase 1 | Python sidecar packaged with `uv`; Node regex as the forced-review fallback | moderate | **Decided** D45 |
| OD-18 | Hook transport default for the Claude Code plugin | `http` handler with `onFailure: continue` / `command` with `async: true` | `http`, automatic fallback to `command` under managed `allowedHttpHookUrls` policies (B1-18) | moderate | **Decided** D46 |
| OD-19 | Default review mode for outbound objectives | `first-5-then-auto` / `always-review` | `first-5-then-auto` | moderate | **Decided** D47 |
| OD-20 | Routing volume `V` for `pocketWorthIt` | per objective / per merchant | per objective (one pocket per envelope, 03 §5.4) | moderate | **Decided** D48 |
| OD-21 | Phase 1 merchant set | `czar-spot`, `czar-extract`, `czar-search` / fewer / more; public price source with cache vs synthetic only for `czar-spot` | the three services; public source with a cache and a synthetic fallback, always with a `source` field | moderate | **Decided** D49 |
| OD-22 | Refund policy for Czar's own sales | automatic on acceptance failure / manual review | automatic with a daily cap `merchants.refundDailyAtomic` (Czar refunding its own sales is not a D35 credit) | moderate | **Decided** D50 |
| OD-23 | `app.fxSource` for local-currency strings | one named daily-rate provider cached 24 h / USDC-only display in Phase 1 | one provider, cached; which provider is open | low | **Decided** D51 (changed: USD only, no rate provider) |
| OD-24 | Gas-reserve UX on the MSCA | show "Network fee reserve" as its own balance / hide until Circle sponsorship is confirmed (A6-08, A6-19 GAP) | show it | moderate | **Decided** D52 |
| OD-25 | ERC-8183 deliverable URI convention (AM-08) | `.well-known` path on the provider host / IPFS CID in the off-chain brief | `.well-known` | moderate | **Decided** D53 |
| OD-26 | IPFS pin providers for evidence archives (two) | any two independent services with HTTP APIs | undecided; pricing drives it | low | **Decided** D54 (changed: no IPFS in Phase 1) |
| OD-27 | Structural check with no declared schema and no history | record `inconclusive` with `parseOk` / count parse-only as `pass` | `inconclusive` (honest) | high | **Decided** D55 |
| OD-28 | Minutes-saved tables per detector (20 / 15 / 30 min) | ship as defaults with per-objective override, tune from `report_outcome.minutesSavedActual` in Phase 2 / wait for data | ship defaults | low | **Decided** D56 |
| OD-29 | `drives.roiMultiple` | 5 (product §6.4 "e.g. 5×") / other | 5 | moderate | **Decided** D57 |
| OD-30 | Soul compile when the sidecar or proxy is down | rules-only compile / skip the compile | rules-only | moderate | **Decided** D58 |
| OD-31 | Earned-autonomy constants `autonomy.baseAtomic` 0.50 USDC per score unit, `autonomy.minScore` 3, diversity weight `1/sqrt(k)` per payee | as proposed / a pure fraction-of-`userMax` raise with no score | as proposed | low | **Decided** D59 |
| OD-32 | Freeze lowers `autoLimit` to 0 on-chain for every category | yes / rely on the `frozen` flag only | yes | moderate | **Decided** D60 |
| OD-33 | KMS vendor, and whether an HSM is required before mainnet (AR-1) | cloud KMS / HSM appliance / software signer in an isolated segment | cloud KMS with the signer service; HSM decision at the pre-mainnet audit | unknown | **Decided** D61 |
| OD-34 | Relayer gas key custody | KMS / hot wallet with a balance cap | KMS | moderate | **Decided** D62 |

## 2b. OD-35 to OD-40 (raised in spec 05)

These were raised in `specs/05-build-plan/build-plan.md` §13 and are now decided.

| # | Decision | Status |
|---|---|---|
| OD-35 | How freeze lowers limits | **Decided** D63: a follow-up agent step (`lowerAutoLimit(category, 0)` per category after `Frozen`), not atomic; atomic version in the stage-2 backlog |
| OD-36 | Test-keystore vault owner for M3–M4 | **Decided** D64: testnet only, removed in M6, listed in the pre-mainnet checklist |
| OD-37 | Docs lagging D51 | **Decided** D65: USD-only wording in spec 01 §4.3, §8.2 and product §4.1, §9.2 |
| OD-38 | Cloud provider | **Decided** D66: one provider for server, indexer and KMS, chosen before M2 (provider still open) |
| OD-39 | Phase 1 daemon platforms | **Decided** D67: macOS only |
| OD-40 | When model prices are read | **Decided** D68: in T-046; budgets stay in tokens and request counts until then |

## 3. Assumptions register (adds to spec 01 §20 and spec 02 §15.1)

| # | Assumption | Check | If false |
|---|---|---|---|
| AR-18 | Claude Code `http` hooks can target `127.0.0.1` without an `allowedHttpHookUrls` entry in unmanaged setups (B1-18 only names the managed allowlist) | build-time test | `command` handler with `async: true` |
| AR-19 | `SMAppService.agent(plistName:)` works for a signed, notarized app bundle that embeds a Python sidecar (B6-04, B6-05) | notarization dry run | `launchctl bootstrap` CLI install; Node-only redaction (OD-17) |
| AR-20 | The Claude Code plugin `.mcp.json` `env` substitution `${CLAUDE_PLUGIN_OPTION_DEVICE_TOKEN}` is supported for `userConfig` options (B1-35 lists `userConfig`; the exact substitution name is from 02 mcp §5) | `claude plugin validate --strict` and a smoke run | write the token through `${CLAUDE_PLUGIN_DATA}` and read it in `bin/czar-mcp` |
| AR-21 | The server answers `submitObjective` with a plan summary including `cap` within `drives.quoteWaitHours`, so the live-mode ROI filter has a price | integration test | the daemon uses `shadowQuote` pricing for the filter |
| AR-22 | P-01 is callable from the daemon through the model proxy (AM-02) | same route as P-04 | daemon regex pre-screen only |
| AR-23 | Ponder 0.18.x handles 0.5 s blocks and the 10,000-block `eth_getLogs` cap with `ethGetLogsBlockRange` (A9-05) | testnet run | Goldsky or Envio (A9-02, A9-04) |
| AR-24 | Gateway `GET /v1/x402/transfers` stays keyless on testnet and filterable by `from`/`nonce` (A2-30, SL-F19) | daily probe | settlement grade `onchain-netted` from `submitBatch` deltas (SL-C8) |
| AR-25 | `GatewayMinter.AttestationUsed` is emitted on the testnet proxy as in the 1.3.0 source (`Mints.sol` lines 47–55) | first pullback | match pullbacks by `isTransferSpecHashUsed` polling only |
| AR-26 | A secondary bundler (Pimlico, Alchemy, ZeroDev; A6-15 to A6-17) accepts a UserOp built for Circle's MSCA without a different paymaster setup | onboarding test | Circle's bundler only, with retries |
| AR-27 | **Stage 2 (D69):** Declarative Web Push works from a Home Screen web app created from a site without a manifest on iOS 26 (D2-09 second half is a GAP) | stage-2 push work (`stage-2-backlog.md` §2 M-4) | ship a manifest |
| AR-28 | The cloud KMS supports secp256k1 ECDSA over raw 32-byte digests with per-key principal policies (AR-1) | vendor docs at build | software signer service in an isolated segment |
| AR-29 | The CZ-19 projection is fresh enough (≤ `indexer.maxLagBlocks`) for the signer service to validate reservations | lag alert | CZ-15 retries after the lag clears |

## 4. Gaps ranked by harm

1. ~~D1-11 passkeys inside the installed iPhone web app~~ moved to stage 2 (D69; `stage-2-backlog.md` §2 M-1). Phase 1 uses desktop-browser passkeys.
2. ~~ERC-8183 deliverable URI convention (AM-08)~~ closed by D53 and AM-08 (applied).
3. Circle gas sponsorship for MSCA UserOps on Arc (A6-08 vs A6-19): decides the gas-reserve UX and onboarding funding.
4. Faucet to an MSCA address (A6-26, AR-6): decides whether testnet onboarding needs a manual transfer.
5. MCP revision negotiated today by Claude Code, Codex and Cursor (part 2 D3 GAP): the legacy path is untested.
6. Model and KMS prices not read this session (KMS vendor chosen at build time, D61): all cost budgets are token or request counts.
7. Arc public RPC rate limits unpublished (A9-06): a keyed provider is required for the indexer.
8. Presidio non-English models (C2-04): non-English users get regex-only PII redaction with forced review.
9. Minutes-saved tables have no ground-truth source (OD-28).
10. Apple Web Push delivery limits and payload size (part 2 D2 GAPs): stage 2 (D69).
11. Keyless-trial allowance size for the Facilitator (part 2 A1 GAP): affects how many testnet settles Czar's merchants can do before registering.
12. Maximum hook `timeout` for non-`SessionEnd` events (part 2 B1 GAP): 2 s is used.
13. Windows service model (B6-20): stage 2 (D67).
14. Cursor untested on this machine (B3 preamble): mappings follow the documented payloads.
15. Which EntryPoint Circle's MSCA factory targets (A6-07): affects bundler fallback choice.

## 5. Flags

- No new agent-directed text was met while writing this folder. The known cases stay in force: Circle and Arc doc headers telling agents to install skills and add an MCP server (FL-1, FL-2), Circle's skill text telling agents to pay small amounts without confirmation (p1-W10), and `AGENTS.md` contributor files in vendor repos (FL-4). P-01 eval case 9 and P-04 eval case 6 use the FL-1 text shape as test input only.
- Pages fetched by `czar-extract` and catalog descriptions will carry such text at run time; CZ-20 returns it as data labelled untrusted, CZ-18 uses descriptions for retrieval only, and P-01 flags it before any other model sees it.
- No secrets were opened. Key files seen by name only in earlier sessions: `research/evidence/experiments/a1-erc1271-usdc/{owner,seller}.key`, `a2-gateway-e2e/{buyer,delegate,merchant}.key`.


## Change log

| Date | ID | Change |
|---|---|---|
| 2026-10-18 | AM-01..AM-20 | Every amendment marked **Applied** with the file and section where it landed. |
| 2026-10-18 | D45..D62 | OD-17..OD-34 marked **Decided** with their D-numbers; D51 and D54 differ from the original recommendations. |
| 2026-10-18 | D53 | Gap 2 (deliverable URI) closed. |
| 2026-10-19 | D63–D68 | added §2b marking OD-35 to OD-40 Decided. |
| 2026-10-19 | D69 | iPhone passkey gap, web-push assumption and gap moved to stage 2; AM-04 wording says web app. |
| 2026-10-19 | D67 | Windows gap tagged stage 2. |
