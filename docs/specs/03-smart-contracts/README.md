# 03 — Smart contracts

- **Status:** draft written 2026-10-18 together with `docs/specs/02-data-and-protocol/`; reviewed (G0-01, the job-path review) and made build-ready on 2026-10-20 (D88). Interfaces only; no implementations. Step-by-step builder PRDs for these contracts are in `docs/specs/07-contract-build/`.
- **Shared types:** every EIP-712 type, hash, Merkle rule, id and signature encoding is defined once in spec 02 (§5–§7) and referenced here.

## Files

| File | What it is | Phase |
|---|---|---|
| `czar-vault.md` | The per-user vault: roles, constants, storage, every function, the `isValidSignature` dispatcher with the exposure-bound proof, state machines, events, invariants, edge cases, gas and the D37 threshold arithmetic | 1 |
| `czar-vault-factory.md` | CREATE2 deployment (one vault bytecode per factory, D73), timelocked guardian and default-signer changes, guardian pause | 1 |
| `job-escrow-adapter.md` | `IJobEscrow` adapter over Circle's testnet ABI and `CzarJobEscrow` | 1 / pre-mainnet |
| `open-evidence-log.md` | SL §7.1 verbatim plus Czar's two leaf types | 1 |
| `czar-job-escrow.md` | Czar-owned ERC-8183 instance from `erc-8183/base-contracts` | pre-mainnet |
| `builder-escrow-and-recipe-splits.md` | Tips escrow keyed by repo id; 0xSplits v2.2 router | 2 |
| `security-and-testing.md` | Threat model per contract, invariant ids, unit/fuzz/invariant/fork test plan, static analysis, deployment, pre-mainnet checklist | — |
| `interfaces/ICzarVault.sol`, `ICzarVaultFactory.sol`, `IJobEscrowAdapter.sol`, `ICzarJobEscrow.sol`, `IOpenEvidenceLog.sol`, `IBuilderEscrow.sol`, `IRecipeSplits.sol` | Interface files (Solidity 0.8.30, NatSpec, events, custom errors, structs) | per contract |

## Summary

- Vaults are immutable, one per user, owned by the user's smart account acting as `msg.sender`; a passkey-verified `OwnerAction` path exists as the D30 fallback.
- Reserve → sign → verify → settle → release: one reservation covers up to 128 authorizations whose nonces derive from the reservation id, so the worst case the agent can sign is `count × unitAmount` (proof in `czar-vault.md` §6.5).
- `isValidSignature` dispatches on a kind tag (`USDC_3009`, `GATEWAY_BURN`, `SL_RECEIPT`) and recomputes the digest from fields it controls; a 65-byte fallback covers the untested Facilitator signature-length case.
- Pullbacks are trustless: the vault fixes every `BurnIntent` field at request time (recipient = vault) and credits only when `GatewayMinter.isTransferSpecHashUsed` is true.
- Jobs: the vault is the ERC-8183 client; the adapter adds the missing `expectedBudget` and fee checks on Circle's instance and targets `CzarJobEscrow` before mainnet.
- The D37 pocket threshold is a named server parameter computed from measured gas: with estimates, 0.0396 USDC at batch size 1 and 0.00504 at 10 (`czar-vault.md` §13, RV-039).

## Deployment order

1. `OpenEvidenceLog` (CREATE2, same address on both networks).
2. `CzarVaultFactory` with network immutables, defaults, guardian, admin (the constructor sets the admin; no version register, D73, D88); publish bytecode hashes.
3. Vaults are created per user at sign-up.
4. Pre-mainnet: `CzarJobEscrow` proxy, then a new factory pointing at it.
5. Phase 2: `BuilderEscrow`, `RecipeSplits`.
