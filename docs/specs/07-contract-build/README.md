# 07 — Contract build PRDs

- **What this folder is:** step-by-step build documents (PRDs) for every Phase 1 smart contract, written for the builder agent. Each PRD turns part of `docs/specs/03-smart-contracts/` into exact files, code or numbered pseudo-code, a complete test list and pass criteria.
- **Authority:** the specs in `03-smart-contracts/` (interfaces first) outrank every PRD (`00-conventions.md` §1.3). A PRD never adds behaviour the spec lacks.
- **Start here:** read `00-conventions.md` in full, then the PRD for your task.

## 1. Rules for the builder
- Start only a PRD whose status below is **Ready**. A **Planned** PRD is not written yet; stop and say so.
- Do the PRDs in the order of the table. Each one lists its dependencies; if one is not done, stop.
- Every PRD ends with a **Definition of done** (exact commands and numbers) and **Stop conditions**. Paste the command output into the task report (`00-conventions.md` §6).
- **How a PRD is verified before it is marked Ready:** its code and tests are built in a reference project on Arc Foundry v0.8.0-2 under `FOUNDRY_PROFILE=arc` (`--deny-warnings` build including lint, `fmt --check`, full test suite). Its stated sizes and test counts come from that run.

## 2. Build order

| # | PRD | Task(s) | Builds | Depends on | Status |
|---|---|---|---|---|---|
| 00 | `00-conventions.md` | all | rules, layout, commands, traps | — | Ready |
| 01 | `01-shared-libraries.md` | T-013 (part) | `CzarConstants`, `SatMath`, `CzarHashing`, `PayeeLeaf`, `CzarNonces`, `PasskeyVerifier`; `LibrariesTest` (34 tests) | T-003, T-010 | Ready (verified) |
| 02 | `02-open-evidence-log-followup.md` | T-011 follow-up | OEL test fixes from the gap audit (G-61): 2 new unit tests, OEL-4 and OEL-5 handler fixes; no contract change | T-011, 01 | Ready (verified) |
| 03 | `03-factory-and-vault-skeleton.md` | T-012 | `CzarVaultFactory`; the vault frame (`VaultState`, `VaultGuards`, `VaultBase`, `VaultStubs`, `CzarVault`; D89); `MockArcUSDC`, `MockVaultFactory`, `CzarVaultHarness`, `VaultTestBase`; `FactoryTest` (22 tests) | 01, 02 | Ready (verified; rewritten for D89) |
| 04 | `04-vault-core.md` | T-013 | `CoreLogic` (balance, owner settings, freeze); `VaultCoreTest` (36 tests) | 03 | Ready (verified; rewritten for D89; the first version was pilot-built by a small model) |
| 05 | `05-envelopes.md` | T-014 | `EnvelopeLogic`; harness test setters; `EnvelopeTest` (28 tests) | 04 | Ready (verified; rewritten for D89) |
| 06 | `06-reservations.md` | T-015 | `ReservationLogic`; `PayeeTree`; `ReserveTest` (33 tests) | 05 | Ready (verified) |
| 07 | `07-signatures.md` | T-016 | `SignatureLogic` (`isValidSignature`: USDC_3009, fallback, SL_RECEIPT); `SignatureTest` (38 tests) | 06 | Ready (verified) |
| 08 | `08-pockets.md` | T-017 | `PocketLogic` and the `GATEWAY_BURN` kind; `PocketTest` (43 tests) | 07, G0-09 | Ready (verified) |
| 09 | `09-jobs-and-adapter.md` | T-018 | `JobEscrowAdapter`, `JobLogic`; `JobTest` (42 + 46 tests, both escrow kinds) | 08 | Ready (verified) |
| 10 | `10-autonomy-and-owner-actions.md` | T-019 | `AutonomyLogic`, `OwnerActionLogic`; deletes `VaultStubs`; `AutonomyTest` (17), `OwnerActionTest` (12) | 09 | Ready (verified) |
| 11 | `11-size-and-gas.md` | T-020 | `SizeTest` (2 tests) and `contracts/SIZE.md` (sizes and measured gas); the split itself is done in PRD 03 (D89) | 10, G0-08 | Ready (verified) |
| 12 | `12-test-suites.md` | T-021, T-023, T-024 (+ deferred T-016, T-017, T-019 items) | `InvariantVault` (both escrow kinds), `InvariantFactory`, 3 fuzz suites, `AbiTest`, `VectorsTest`, `ExposureTest`, `GasTest`, `.gas-snapshot`, `gas-table.json` | 11 | Ready (verified: 419 tests, mutations checked) |
| 13 | `13-analysis-and-deployment.md` | T-025, T-105, T-027 | Slither, keys, CREATE2 deployment | 12 | Planned |
| 14 | `14-vault-client.md` | T-026 | `@czar/vault-client` | 10 | Planned |

## 3. Fixtures
- `fixtures/payee-tree.mjs` generates `fixtures/payee-tree.json`: four-leaf and three-leaf `payeeRoot` trees under the `czar-merkle-v1` rules (`02-data-and-protocol` §5.3). PRD 01's tests hold the values as literals.

## 4. Open items that gate later PRDs
- **G0-08 and G0-09** (Gate 0, read-only testnet RPC): gate PRD 11 (size limit) and PRD 08 (Gateway replay check). Each PRD tells the builder to run the check if it is not recorded.
- **Size (D89):** settled. With every function built the vault is 14,540 B and the factory 20,747 B; PRD 11 records the numbers and adds a regression test.
- **SCR-101** (Arc hardfork name): gates the M1 exit sign-off, not any PRD.
- **Fork tests (T-022):** need the Arc testnet RPC, which the PRD author's environment cannot reach. They get their own PRD once a run against the RPC can verify them; PRD 12 covers T-021, T-023 and T-024.
- **Arithmetic panics on extreme inputs (review, 2026-10-20):** `reserve` (`unitAmount × count`), `fundPocket` (`funded + amount`), `grantPocketGas` (`gasGranted + units`) and `raiseAutoLimit` (`userMax × MAX_RAISE_STEP_BPS` with a huge owner-set `userMax`) can revert with `Panic(0x11)` instead of `BadParams` when a caller passes amounts near 2^256. No funds move; only the error differs from 00-conventions §4.8. To be closed by an SCR (security pass), not by a builder.

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version: 00, 01, 03, 04, 05 Ready; the rest Planned. |
| 2026-10-20 | D89: the vault's logic moves into linked libraries; 00, 03, 04 and 05 rewritten for it; 02 and 06 to 11 Ready (verified). PRD 02 now comes before 03, and the totals in 03–11 include its 2 tests. |
| 2026-10-20 | Independent review and a pilot build of PRD 09: fixes in 00, 03, 04, 06–11 (event order per §15.5, T-018 command, deferrals to PRD 12, shorthand rules, pinned gas seed). Open items: fork tests, arithmetic panics. |
| 2026-10-20 | PRD 12 Ready (verified). Measured routing gas raises `pocketThreshold(1)` from 39,600 to 84,980 atomic. T-022 fork tests split out. |
