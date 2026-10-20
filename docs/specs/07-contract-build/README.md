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
| 02 | `02-open-evidence-log-followup.md` | T-011 follow-up | OEL test fixes from the gap audit (G-61) | T-011 | Planned |
| 03 | `03-factory-and-vault-skeleton.md` | T-012 | `CzarVaultFactory`; `VaultStorage`, `VaultStubs`, `CzarVault`; `MockArcUSDC`, `MockVaultFactory`, `CzarVaultHarness`, `VaultTestBase`; `FactoryTest` (22 tests) | 01 | Ready (verified) |
| 04 | `04-vault-core.md` | T-013 | `VaultCore` (balance, owner settings, freeze, getters); `VaultCoreTest` (36 tests) | 03 | Ready (verified; pilot-built by a small model: 141 passed) |
| 05 | `05-envelopes.md` | T-014 | `VaultEnvelopes`; harness test setters; `EnvelopeTest` (28 tests) | 04 | Ready (verified) |
| 06 | `06-reservations.md` | T-015 | `VaultReservations` | 05 | Planned |
| 07 | `07-signatures.md` | T-016 | `VaultSignatures` (`isValidSignature` USDC_3009, fallback, SL_RECEIPT) | 06 | Planned |
| 08 | `08-pockets.md` | T-017 | `VaultPockets` and the `GATEWAY_BURN` kind | 07 | Planned |
| 09 | `09-jobs-and-adapter.md` | T-018 | `JobEscrowAdapter`, `VaultJobs` | 08 | Planned |
| 10 | `10-autonomy-and-owner-actions.md` | T-019 | `VaultAutonomy`, `VaultOwnerActions`; deletes `VaultStubs` | 08, 09 | Planned |
| 11 | `11-size-split.md` | T-020 | size measurement and the linked-library split (D42, D88) | 10, G0-08 | Planned |
| 12 | `12-test-suites.md` | T-021, T-022, T-023, T-024 | invariant, fuzz, fork, vector and gas suites | 11 | Planned |
| 13 | `13-analysis-and-deployment.md` | T-025, T-105, T-027 | Slither, keys, CREATE2 deployment | 12 | Planned |
| 14 | `14-vault-client.md` | T-026 | `@czar/vault-client` | 10 | Planned |

## 3. Fixtures
- `fixtures/payee-tree.mjs` generates `fixtures/payee-tree.json`: four-leaf and three-leaf `payeeRoot` trees under the `czar-merkle-v1` rules (`02-data-and-protocol` §5.3). PRD 01's tests hold the values as literals.

## 4. Open items that gate later PRDs
- **G0-08 and G0-09** (Gate 0, need testnet RPC): gate PRD 11 (size limit) and PRD 08 (Gateway replay check).
- **SCR-101** (Arc hardfork name): gates the M1 exit sign-off, not any PRD.

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version: 00, 01, 03, 04, 05 Ready; the rest Planned. |
