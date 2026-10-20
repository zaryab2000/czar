# Amendment verification (spec 05, Part A)

- **Date:** 2026-10-18. **Scope:** AM-01 to AM-20 (from `docs/specs/04-components/amendments-and-open-decisions.md` §1) and decisions D45–D62, applied to specs 02, 03 and 04.
- **Result:** all checks pass. 0 unresolved references, 0 interface changes, 0 EIP-712 changes, 0 name mismatches, 0 banned-word hits.

## 1. What was applied, and where

| ID | Landed in |
|---|---|
| AM-01 | 02 `api/openapi.yaml`: `findService` (`POST /v1/services/search`), `createQuote` (`POST /v1/quotes`), `reportOutcome` (`POST /v1/outcomes`); 02 `data-and-protocol.md` §9.2, §10; `mcp/czar-mcp-tools.md` §2.2, §2.3, §2.5 |
| AM-02 | 02 `api/openapi.yaml`: `completeModelCall` (`POST /v1/models/complete`); `data-and-protocol.md` §9.2 |
| AM-03 | 02 `api/openapi.yaml` `Me`: `mode`, `shadowEndsAt`, `limits[].periodEndsAt`, `balances.pocketOutstanding` |
| AM-04 | 02 `api/openapi.yaml` `IngestReport.shadowTotals`; `data-and-protocol.md` §9.2 |
| AM-05 | 02 `api/openapi.yaml` `LedgerReceipt`: `merchantIsCzar`, `minutesSaved`, `minutesSource`, status `quarantined` |
| AM-06 | 02 `api/openapi.yaml` `ApprovalIntent.decoded` fixed to the 8 `OpenEnvelopeParams` fields |
| AM-07 | 02 `api/openapi.yaml` tag `public`: `listIndexResources`, `searchIndexResources`; Phase 2 `listSnapshots`, `getSnapshot` (`x-phase: 2`) |
| AM-08 | 02 `data-and-protocol.md` §4.11 and `schemas/job-record.schema.json` `deliverableUri`, with the `.well-known/czar-deliverable/<hex>` convention (D53) |
| AM-09 | 02 §4.6; `schemas/plan.schema.json` `Step.inputTemplate.expectedKeys` |
| AM-10 | 02 §4.13, §6.3.3 (job receipts signed via the vault's `SL_RECEIPT` kind) |
| AM-11 | 02 §4.14; `schemas/acceptance-report.schema.json` |
| AM-12 | 02 §4.1; `schemas/activity-event.schema.json` (`repeatCount`, `provenance.flags`) |
| AM-13 | 02 §4.2; `schemas/soul.schema.json` `Belief.state`, `Belief.key` (local-only) |
| AM-14 | 02 §4.3; `schemas/objective.schema.json` (`shadowed`, `published`) |
| AM-15 | 02 §7.1 (`cand_`) |
| AM-16 | new 02 `api/local-openapi.yaml` (6 routes: `getLocalSoul`, `editLocalBelief`, `getLocalSoulDiff`, `getLocalBeliefReceipts`, `getLocalShadowReport`, `getLocalEgress`) |
| AM-17 | 02 §12.2 `extensions.czar.rail` |
| AM-18 | 02 §13.2 marker family (`czar:result`); `pairDevice` description |
| AM-19 | 03 `czar-vault.md` §9.1 (`JobSynced.state` mapping); documentation only |
| AM-20 | 03 `czar-vault.md` §5.6 (`raiseAutoLimit` empty `sig` for the owner); documentation only |
| D45–D50, D52, D53, D55–D62 | spec 04 component files (per-file change logs); 02 `Me.balances.mscaBalance` described as "Network fee reserve" (D52) |
| D51 | 02 `Me.displayCurrency` fixed to `USD`; money strings USD-only in 02 and 04; `app.fxSource` removed from 04 |
| D54 | 02 §4.20 and `schemas/evidence-batch.schema.json` (`archiveUri` required, `cid` optional and Phase 2); 03 `open-evidence-log.md` §11–§13; 04 CZ-17 and the acceptance scenario |
| D60 | 03 `czar-vault.md` §5.6 note: the agent calls `lowerAutoLimit(categoryId, 0)` per used category after `Frozen` (no signature change); 04 CZ-15, CZ-22, CZ-24, scenario 8.4 |
| Marks | 04 `amendments-and-open-decisions.md`: every AM marked **Applied** with its location; OD-17 to OD-34 marked **Decided** with D45–D62 |

Every edited file ends with a change log (Markdown section, a YAML `x-changeLog` comment block, or a JSON `$comment`).

## 2. Checks run

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Schema structure | `cd docs/specs/02-data-and-protocol/schemas && python3 -I check-schemas.py` | `checked 19 files; problems: 0` |
| 2 | Schema JSON parse | `python3 -I -c 'import json,sys;json.load(open(sys.argv[1]))' <each>.schema.json` | all 19 parse |
| 3 | OpenAPI parse | `ruby -ryaml -e 'YAML.safe_load(...)'` on each file (PyYAML is not installed) | `openapi.yaml`: OpenAPI 3.1.0, 36 paths, 37 operations, 46 component schemas. `local-openapi.yaml`: OpenAPI 3.1.0, 6 paths, 6 operations, 7 component schemas |
| 4 | `$ref` resolution | script that resolves `#/...` pointers, relative file refs with fragments, and absolute `$id` refs against the loaded schemas | 415 refs checked; 0 unresolved |
| 5 | EIP-712 types | no type string changed; re-ran `node vectors/compute-eip712-vectors.mjs` (viem 2.57.2) and compared with `eip712-vectors.json` ignoring `generatedAt` | identical |
| 6 | Solidity interfaces | no `.sol` file changed; recompiled all 7 with `forge build --force` (solc 0.8.30, `evm_version = prague`) | `Compiler run successful!`; 0 warnings |
| 7 | Banned wording | `grep -rniE '\b(demo|hackathon|prototype|throwaway)\b' docs/specs/02-* docs/specs/03-* docs/specs/04-* docs/specs/05-*` (excluding rule statements) | 0 hits |

## 3. Cross-spec name check

- **Method:** a script collected names from spec 04 and looked each up in spec 02 (both OpenAPI files' `operationId`s and component schemas, `data-and-protocol.md` §4 objects, MCP tools) and spec 03 (functions, events, errors, structs and enums in `interfaces/*.sol`, plus the vendor names spec 03 documents).
- **Scanned:** 43 operation IDs, 97 interface functions, 59 events, 82 errors, all backticked calls, PascalCase names and snake_case tool names in the 13 spec 04 files.
- **Flagged and triaged (not mismatches):**
  - vendor SDK and contract names cited with fact IDs: `createGatewayMiddleware`, `submitBatch`, `gatewayMint`, `isAuthorizedForBalance`, `isTransferSpecHashUsed`, `toModularTransport`, `createConfig`, `openSystemSettingsLoginItems`, events `AttestationUsed`, `AuthorizationUsed`, `BatchProcessed`, `DelegateAdded`, `Deposited`, `Transfer`, `RoleRevoked`
  - spec-04-internal interfaces that are not cross-spec shapes: indexer queries (`envelopeByRef`, `reservationsNeedingSettle`, `jobsToSync`, …), signer-service calls (`createPocketKey`, `destroyPocketKey`, `sign`), library helpers (`privacyClassOf`, `redactSecrets`), table columns and metric names
  - state names (`Candidate`, `Faded`, `Built`, …), plist keys, key IDs (`K3`), math notation (`cVd(n)`, `f(S)`)
  - field names written as identifiers: `shadowEndsAt` and `reportHash` (both exist in 02)
- **Result:** 0 mismatches.
- **Value spot-check (03 constants vs 04 parameters):** reservation TTL 600 s; settle batch 32 = `FINALIZE_CHUNK`; pullback max fee 10,000 = `MAX_PULLBACK_FEE`; pocket gas grant 20,000 ≤ `MAX_GAS_GRANT_PER_POCKET` 50,000; 128 authorizations (D39); `maxFeeRatioBps` 1000 (D38); `autonomy.baseAtomic` 500,000 and `minScore` 3 (D59); `drives.roiMultiple` 5 (D57). All consistent.
- **One fix made during the check:** a CZ-17 threat row still said "archives bound by CID"; it now says root plus `archiveUri` (D54).

## 4. Follow-ups carried into the build plan

- `receipt.schema.json` references `payment-ref` by absolute `$id`; the `@czar/schemas` loader must register all schemas by `$id` before compiling (task T-006).
- `vaultSignatureMode` is set by Gate 0 check G0-04.

---

## D63–D69

- **Date:** 2026-10-19. **Scope:** decisions D63–D69 applied across specs 01–05 and product §4.1, §9.2 only.

### Files changed

| File | Change |
|---|---|
| `docs/specs/01-system-architecture/system-architecture.md` | D69 desktop-browser app, CZ-23 stage 2, AR-9 and gap 1 stage 2, §8 and §12 use the pending list; D65 USD wording (§4.3, §8.2, §13); D63 freeze note (§7.3) |
| `docs/specs/01-system-architecture/README.md` | summary says desktop browser; Home Screen app is stage 2 |
| `docs/product/czar-product.md` | §4.1 and §9.2 say "a budget in US dollars" (D65) |
| `docs/specs/02-data-and-protocol/api/openapi.yaml` | app tag describes the desktop browser; push routes and schemas tagged `x-stage: 2` (kept defined) |
| `docs/specs/02-data-and-protocol/data-and-protocol.md` | push routes, §9.6 payloads, §9.7 push link and the `psh_` id tagged stage 2 |
| `docs/specs/02-data-and-protocol/mcp/czar-mcp-tools.md`, `README.md` | approval happens in the app; §7 push payloads stage 2 |
| `docs/specs/03-smart-contracts/czar-vault.md` | D60 note cites D63 (follow-up agent step; atomic version is backlog P2-15) |
| `docs/specs/04-components/` (11 files) | CZ-22 desktop web, CZ-23 stage-2 outline, scenario Stage 0 in desktop Safari, pending list replaces push; D63 in CZ-15, CZ-22, CZ-24; D67 macOS-only CZ-02; D68 in `cross-cutting.md`; OD-35..OD-40 marked Decided (§2b of `amendments-and-open-decisions.md`) |
| `docs/specs/05-build-plan/gate-0-checks.md` | G0-02 and G0-15 moved to stage 2 (procedures kept) |
| `docs/specs/05-build-plan/build-plan.md` | Gate 0 list, M6 scope, task totals (87), DoD, R-1, §11 stage-2 mobile row, OD-35..OD-40 Decided, D64 limits and pre-mainnet check, D66 in M2 entry |
| `docs/specs/05-build-plan/phase-1-tasks.md` | T-080 desktop scaffold, T-082 desktop passkey onboarding and fixture removal, T-083 moved to stage 2, T-084–T-086 desktop only, T-046 price read (D68), T-060 macOS only (D67), T-102 desktop Stage 0, coverage tables |
| `docs/specs/05-build-plan/stage-2-backlog.md` | §0 status applied; §1 marked Applied |
| `docs/specs/05-build-plan/README.md` | counts and wording |
| `README.md` (root) | status: D63–D69 applied; Gate 0 review (G0-01) next |

Every edited file has a 2026-10-19 change-log entry. No data shape, route, contract function, event or EIP-712 type changed; only phase tags were added.

### Checks

| Check | Result |
|---|---|
| `python3 -I docs/specs/02-data-and-protocol/schemas/check-schemas.py` | `checked 19 files; problems: 0` |
| Parse `openapi.yaml` and `local-openapi.yaml` (Ruby YAML) | 36 paths / 37 operations; 6 paths / 6 operations |
| `$ref` resolution in both OpenAPI files | 210 refs, 0 unresolved |
| Phase 1 tasks depending on a stage-2 task (T-083) | none |
| Banned wording (demo, hackathon, prototype, throwaway) | 0 hits |

### Remaining hits for `iPhone`, `iOS`, `Home Screen`, `push`, `phone`, `mobile`, `manifest`, `local currency`, `fxSource`, `exchange rate`

| Where | Why it stays |
|---|---|
| spec 01 §1 risk (1), §4.3 "Stage 2:" clauses, §5, §17, §18, §19, AR-9 | on the same line as a stage-2 / D69 tag |
| spec 01 CZ-23 (§4.2) | under the CZ-23 entry marked "Phase: stage 2 (D69)" |
| spec 01 §6, §17 `PushSplit`, `PushSplitFactory`; spec 03 builder-escrow, `IRecipeSplits.sol` | 0xSplits contract names, unrelated |
| spec 01 OD-6 "Soul on the phone" | historical open decision, decided by D34 (soul sync is stage 2, backlog M-6) |
| spec 02 §3.1 `PHONE_NUMBER`; spec 04 P-01 prompt "phone numbers"; T-064 PII corpus "phones" | Presidio entity and PII examples, unrelated |
| spec 02 §9.6, mcp §7, OpenAPI `PushSubscription*`, `/v1/push/*` | sections and operations tagged stage 2 (`x-stage: 2`), kept defined |
| spec 02 OpenAPI `listApprovals` "This list, not push, is the source of truth" | consistent with D69 |
| spec 02 §15.3, spec 04 `cross-cutting.md` §8, `server-autonomy-roi-keys.md` mainnet row, OD-23 row | say local currency is a later option (D51) or are a decided historical row |
| spec 04 `app-and-notifications.md` CZ-23 section | under "## CZ-23 Notifications (stage 2, D69)" |
| spec 04 `local-agent-surfaces.md` "no server push to the daemon"; `local-soul-and-drives.md` "no push in Phase 1" | statements that there is no push, consistent |
| spec 04 `local-observers-and-daemon.md` plugin "manifest", Chrome "Manifest V3" | Claude Code plugin manifest and Chrome extension manifest (stage 2 observer), unrelated to the web app |
| `gate-0-checks.md` G0-02, G0-15 procedures | under headings marked "moved to stage 2 (D69)" |
| `phase-1-tasks.md` T-083 block | marked "moved to stage 2 (D69)" |
| "every push and pull request" (`gate-0-checks.md` G0-12, `build-plan.md` §8, T-002) | git push, unrelated |
| `build-plan.md` §11 P2-M2 "phone soul"; OD-37 row | Phase 2 scope (D34); decided historical row (D65) |
| `docs/product/czar-product.md` §2.1 "phone calls"; §9.1 "Mobile and web app" | §2.1 is a merchant service type (unrelated); §9.1 is outside the allowed edit scope (open question below) |
| `amendment-verification.md` D51 row | historical record |

### Open questions for Zaryab

1. `docs/product/czar-product.md` §9.1 still says "Mobile and web app". The prompt allows edits to §4.1 and §9.2 only, so it was left. Recommend changing it to "Web app (desktop browser in Phase 1; mobile in stage 2, D69)".
2. Spec 01 §1 and `docs/specs/01-system-architecture/README.md` say "Raw work data never leaves the machine (D25)", which breaks the D31 wording rule ("raw data stays local; only redacted excerpts are sent for compilation"). It is not a D63–D69 change, so it was left. Recommend fixing before the G0-01 review.
3. D34 says "no soul on the phone"; spec 04 now says "no soul view in the web app" for Phase 1. Same rule for the Phase 1 surface; confirm this reading.
