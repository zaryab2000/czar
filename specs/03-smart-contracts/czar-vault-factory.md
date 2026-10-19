# `CzarVaultFactory` (spec 03)

- **Date:** 2026-10-18. **Status:** draft. Interface: `interfaces/ICzarVaultFactory.sol`. Shared definitions: spec 02.

## 1. Purpose and phase

- Deploys one immutable `CzarVault` per user at a predictable CREATE2 address, records the implementation version each vault was built from, and holds the single guardian pause flag every vault reads (spec 01 K6, K20).
- **Phase 1.** Not upgradeable. A new vault version is a new factory (or a new registered bytecode) for **new** vaults only; existing vaults never change (D33).

## 2. Roles and permissions

| Action | Factory admin (Ownable2Step, K20) | Guardian (K6) | Anyone |
|---|---|---|---|
| `createVault` for an owner | no (users do it) | no | yes, but only `owner == msg.sender` or a Czar-signed onboarding voucher (§5) |
| register a new vault bytecode version | yes (timelocked, 48 h) | no | no |
| set default signers for new vaults (`agentSigner`, `autonomySigner`, `evaluator`) | yes | no | no |
| set guardian address | yes (timelocked) | no | no |
| `pause()` / `unpause()` (global stop of spending) | no | yes | no |
| read `guardianPaused()`, `vaultOf(owner)` | — | — | yes |

## 3. Constants and immutables

| Name | Value | Reason |
|---|---|---|
| `ADMIN_TIMELOCK` | `48 hours` | code-version and guardian changes are visible before they apply |
| `CREATE2_DEPLOYER` | Arachnid `0x4e59b44847b379578588920cA78FbF26c0B4956C` (factory itself deployed through it) | same factory address on both networks (A9-15) |
| `vaultCreationCodeHash` (per version) | `keccak256(type(CzarVault).creationCode ‖ constructorArgsPrefix)` | published so anyone can predict addresses and check bytecode |
| `usdc`, `gatewayWallet`, `gatewayMinter`, `gatewayDomain`, `jobEscrow`, `jobEscrowKind` | per network (spec 01 §6.2; `czar-vault.md` §3) | passed into every vault's constructor |

## 4. Storage layout

| Variable | Type | Meaning | Writer |
|---|---|---|---|
| `owner` (admin), `pendingOwner` | `address` | Ownable2Step | admin |
| `guardian` | `address` | pause key | admin (timelocked) |
| `guardianPaused` | `bool` | read by every vault | guardian |
| `defaults` | `struct {address agentSigner; address autonomySigner; address evaluator}` | injected into new vaults | admin |
| `versions[versionId]` | `struct {bytes32 creationCodeHash; uint64 activeFrom; bool retired}` | registered vault code | admin |
| `currentVersion` | `uint32` | version used by `createVault` | admin after timelock |
| `vaultOf[ownerAccount]` | `address` | one vault per owner | `createVault` |
| `versionOf[vault]` | `uint32` | which code a vault runs | `createVault` |
| `pendingChanges[changeId]` | `struct {bytes32 payloadHash; uint64 eta}` | timelock queue | admin |

## 5. Functions

| Function | Caller | Preconditions | State changes | External calls | Events / errors | Gas (est.) |
|---|---|---|---|---|---|---|
| `createVault(address ownerAccount, bytes32 salt) → address vault` | `ownerAccount` itself (the MSCA's first UserOp), or Czar's onboarding relayer with `ownerAccount` given (vault ownership is fixed to `ownerAccount`, so a relayer can only create, never control) | `vaultOf[ownerAccount] == 0`; `ownerAccount != 0` | deploy `new CzarVault{salt: keccak256(abi.encode(ownerAccount, salt))}(ownerAccount, defaults, network immutables, address(this))`; `vaultOf`, `versionOf` | CREATE2 | `VaultCreated(ownerAccount, vault, version, agentSigner, autonomySigner, evaluator)`; `VaultExists`, `ZeroAddress` | ≈ 2.5M (vault deployment; measure) |
| `predictVault(address ownerAccount, bytes32 salt) → address` (view) | anyone | — | — | — | — | 2k |
| `pause()` / `unpause()` | guardian | — | `guardianPaused` | — | `GuardianPaused(by)` / `GuardianUnpaused(by)`; `NotGuardian` | 25k |
| `queueVersion(bytes32 creationCodeHash)` / `applyVersion(changeId)` | admin / anyone after `eta` | timelock | `versions`, `currentVersion` | — | `VersionQueued`, `VersionApplied`; `TooEarly` | 60k |
| `queueGuardian(address)` / `applyGuardian(changeId)` | admin / anyone after `eta` | timelock | `guardian` | — | `GuardianQueued`, `GuardianChanged` | 50k |
| `setDefaults(address agent, address autonomy, address evaluator)` | admin | none zero | `defaults` | — | `DefaultsSet` | 50k |
| `transferOwnership` / `acceptOwnership` | admin / pending | Ownable2Step | | | OZ events | |

- The vault's constructor arguments are fixed by the factory (network immutables) except `ownerAccount` and the defaults; the vault reads `factory.guardianPaused()` on every spending path (`czar-vault.md` §5).
- `createVault` must run **before** the user's first payment (A1-13, A1-19: no ERC-6492); the app calls it during sign-up (spec 01 §8.1).

## 6. State machine

Factory state is a pause flag and a version register: `Unpaused ⇄ Paused` by the guardian (`GuardianPaused`/`GuardianUnpaused`); version `Queued → Applied` after `ADMIN_TIMELOCK` (`VersionQueued`/`VersionApplied`).

## 7. Events and errors

| Event | Signature |
|---|---|
| `VaultCreated` | `(address indexed ownerAccount, address indexed vault, uint32 indexed version, address agentSigner, address autonomySigner, address evaluator)` |
| `GuardianPaused` / `GuardianUnpaused` | `(address indexed by)` |
| `VersionQueued` | `(bytes32 indexed changeId, bytes32 creationCodeHash, uint64 eta)` |
| `VersionApplied` | `(uint32 indexed version, bytes32 creationCodeHash)` |
| `GuardianQueued` / `GuardianChanged` | `(bytes32 indexed changeId, address guardian, uint64 eta)` / `(address indexed oldGuardian, address indexed newGuardian)` |
| `DefaultsSet` | `(address agentSigner, address autonomySigner, address evaluator)` |

Errors: `VaultExists()`, `ZeroAddress()`, `NotGuardian()`, `TooEarly()`, `UnknownChange()`, `VersionRetired()`.

## 8. External dependencies

None at runtime except CREATE2. The factory never holds funds and never calls into vaults.

## 9. Invariants

| Id | Invariant |
|---|---|
| FAC-1 | `vaultOf[o]` is set at most once per `o`, and `CzarVault(vaultOf[o]).owner() == o`. |
| FAC-2 | `guardianPaused` can only be set by `guardian`; no factory function moves funds. |
| FAC-3 | A version change or guardian change takes effect no earlier than `queuedAt + ADMIN_TIMELOCK`. |
| FAC-4 | Existing vaults' code is unaffected by any factory change (immutable deployments). |

## 10. Edge cases

- A user with no MSCA yet: `predictVault` gives the address for display; the vault is only used after `createVault` mined (ERC-6492 unsupported, A1-13).
- Defaults rotation: affects new vaults only; existing vaults rotate through their owner (`rotateSigners`).
- Guardian key loss: admin queues a new guardian (48 h); until then the pause flag keeps its current value.

## 11. Gas budget

`createVault` ≈ 2.5M gas ≈ 0.05 USDC at 20 Gwei (to be measured; vault bytecode size drives it; must stay under the 24,576-byte EIP-170 limit, which may force a `VaultLib` external library for the WebAuthn and Gateway hashing code).

## 12. Mainnet differences

Same factory address through CREATE2 (A9-15); constructor immutables differ per network (`czar-vault.md` §14). Guardian and admin keys are separate per network.
