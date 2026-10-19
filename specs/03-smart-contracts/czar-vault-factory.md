# `CzarVaultFactory` (spec 03)

- **Date:** 2026-10-18; amended 2026-10-19 (RV-015, D73). **Status:** draft. Interface: `interfaces/ICzarVaultFactory.sol`. Shared definitions: spec 02.

## 1. Purpose and phase

- Deploys one immutable `CzarVault` per user at a CREATE2 address that depends only on the factory and the owner account, and holds the single guardian pause flag every vault reads (spec 01 K6, K20).
- **Phase 1.** Not upgradeable. **No version register (D73):** a factory deploys exactly one vault bytecode, compiled into it. A new vault version means deploying a new factory; existing vaults never change (D33), and users move by withdrawing to a vault from the new factory.
- **Superseded by D73 / RV-015:** the earlier "version register" (`queueVersion`/`applyVersion`, `versions[]`, `currentVersion`, a registered `creationCodeHash` per version). A factory cannot deploy bytecode it only knows by hash, so the register protected nothing and could not be built.

## 2. Roles and permissions

| Action | Factory admin (Ownable2Step, K20) | Guardian (K6) | Anyone |
|---|---|---|---|
| `createVault(ownerAccount)` | yes | yes | yes. The caller has no power over the result: the vault's owner is always `ownerAccount`, its signers are the factory's current defaults, and its address depends only on `ownerAccount`. In practice the app calls it from the owner's smart account or Czar's onboarding relayer does (one rule; the earlier "Czar-signed onboarding voucher" wording is superseded by RV-015) |
| queue / apply default signers for new vaults (`agentSigner`, `autonomySigner`, `evaluator`) | queue (timelocked, 48 h) | no | apply after `eta` |
| queue / apply guardian address | queue (timelocked, 48 h) | no | apply after `eta` |
| `pause()` / `unpause()` (global stop of spending) | no | yes | no |
| read `guardianPaused()`, `vaultOf(owner)`, `predictVault(owner)`, `networkConfig()`, `defaults()` | — | — | yes |

## 3. Constants and immutables

| Name | Value | Reason |
|---|---|---|
| `ADMIN_TIMELOCK` | `48 hours` | guardian and default-signer changes are visible before they apply (FAC-3) |
| `VAULT_VERSION` | `1` (constant) | the one vault version this factory deploys (D73); emitted in `VaultCreated` |
| `VAULT_CREATION_CODE_HASH` | `keccak256(type(CzarVault).creationCode)` (immutable view) | published so anyone can predict addresses and check the bytecode |
| `CREATE2_DEPLOYER` | Arachnid `0x4e59b44847b379578588920cA78FbF26c0B4956C` (the factory itself is deployed through it) | reproducible factory address per network (A9-15). The factory's constructor carries the network's immutables, so the testnet and mainnet factories have different addresses, and so do their vaults (RV-015) |
| `networkConfig` | `{usdc, gatewayWallet, gatewayMinter, gatewayDomain, jobEscrow, jobEscrowKind}` (immutables, per network: spec 01 §6.2; `czar-vault.md` §3) | read by each vault's constructor from `msg.sender` (the factory), so they are **not** part of the vault's init code |

## 4. Storage layout

| Variable | Type | Meaning | Writer |
|---|---|---|---|
| `owner` (admin), `pendingOwner` | `address` | Ownable2Step | admin |
| `guardian` | `address` | pause key | `applyGuardian` after timelock |
| `guardianPaused` | `bool` | read by every vault | guardian |
| `defaults` | `struct {address agentSigner; address autonomySigner; address evaluator}` | read by each new vault's constructor | `applyDefaults` after timelock |
| `vaultOf[ownerAccount]` | `address` | one vault per owner | `createVault` |
| `isVault[vault]` | `bool` | deployed by this factory | `createVault` |
| `pendingChanges[changeId]` | `struct {uint8 kind; bytes32 payloadHash; uint64 eta}` | timelock queue (`kind`: 1 guardian, 2 defaults) | admin |

## 5. Functions

| Function | Caller | Preconditions | State changes | External calls | Events / errors | Gas (est.) |
|---|---|---|---|---|---|---|
| `createVault(address ownerAccount) → address vault` | anyone | `ownerAccount != 0`; `vaultOf[ownerAccount] == 0` | deploy `new CzarVault{salt: keccak256(abi.encode(ownerAccount))}(ownerAccount)`; the vault's constructor reads `networkConfig()` and `defaults()` from `msg.sender`; `vaultOf`, `isVault` | CREATE2 | `VaultCreated(ownerAccount, vault, VAULT_VERSION, agentSigner, autonomySigner, evaluator)`; `VaultExists`, `ZeroAddress` | ≈ 2.5M (vault deployment; measure) |
| `predictVault(address ownerAccount) → address` (view) | anyone | — | — (`keccak256(0xff ‖ factory ‖ keccak256(abi.encode(ownerAccount)) ‖ keccak256(creationCode ‖ abi.encode(ownerAccount)))`) | — | — | 2k |
| `pause()` / `unpause()` | guardian | — | `guardianPaused` | — | `GuardianPaused(by)` / `GuardianUnpaused(by)`; `NotGuardian` | 25k |
| `queueGuardian(address)` / `applyGuardian(changeId)` | admin / anyone after `eta` | non-zero; timelock | `guardian` | — | `GuardianQueued`, `GuardianChanged`; `TooEarly`, `UnknownChange` | 50k |
| `queueDefaults(address agent, address autonomy, address evaluator)` / `applyDefaults(changeId, agent, autonomy, evaluator)` | admin / anyone after `eta` | none zero; `keccak256(abi.encode(agent, autonomy, evaluator)) == payloadHash`; timelock | `defaults` | — | `DefaultsQueued(changeId, agent, autonomy, evaluator, eta)`, `DefaultsSet(agent, autonomy, evaluator)`; `TooEarly`, `UnknownChange`, `ZeroAddress` | 55k |
| `transferOwnership` / `acceptOwnership` | admin / pending | Ownable2Step | | | OZ events | |

- **Superseded by RV-015:** `setDefaults` without a timelock, and the `salt` argument of `createVault`/`predictVault`. With defaults in the init code and a caller-chosen salt, the predicted address changed whenever defaults changed, and anyone could deploy the owner's vault at a different address first.
- `createVault` must run **before** the user's first payment (A1-13, A1-19: no ERC-6492); the app calls it during sign-up (spec 01 §8.1). A deposit to `predictVault(owner)` before deployment is safe: the address can only ever hold that owner's vault.

## 6. State machine

Factory state is a pause flag plus a timelock queue: `Unpaused ⇄ Paused` by the guardian (`GuardianPaused`/`GuardianUnpaused`); guardian and defaults changes go `Queued → Applied` after `ADMIN_TIMELOCK`.

## 7. Events and errors

| Event | Signature |
|---|---|
| `VaultCreated` | `(address indexed ownerAccount, address indexed vault, uint32 indexed version, address agentSigner, address autonomySigner, address evaluator)` |
| `GuardianPaused` / `GuardianUnpaused` | `(address indexed by)` |
| `GuardianQueued` / `GuardianChanged` | `(bytes32 indexed changeId, address guardian, uint64 eta)` / `(address indexed oldGuardian, address indexed newGuardian)` |
| `DefaultsQueued` | `(bytes32 indexed changeId, address agentSigner, address autonomySigner, address evaluator, uint64 eta)` |
| `DefaultsSet` | `(address agentSigner, address autonomySigner, address evaluator)` |

Errors: `VaultExists()`, `ZeroAddress()`, `NotGuardian()`, `TooEarly()`, `UnknownChange()`. (`VersionRetired()` is superseded by D73.)

## 8. External dependencies

None at runtime except CREATE2. The factory never holds funds and never calls into vaults.

## 9. Invariants

| Id | Invariant |
|---|---|
| FAC-1 | `vaultOf[o]` is set at most once per `o`, and `CzarVault(vaultOf[o]).owner() == o`. |
| FAC-2 | `guardianPaused` can only be set by `guardian`; no factory function moves funds. |
| FAC-3 | A guardian change or a defaults change takes effect no earlier than `queuedAt + ADMIN_TIMELOCK`. There is no exception (the first defaults and guardian are constructor arguments, not changes). |
| FAC-4 | Existing vaults' code and signers are unaffected by any factory change (immutable deployments). |
| FAC-5 | `predictVault(o)` depends only on the factory address and `o`, and equals `vaultOf[o]` after `createVault(o)`, whatever the caller and whatever defaults changes happened in between (RV-015). |

## 10. Edge cases

- A user with no MSCA yet: `predictVault` gives the address for display; the vault is only used after `createVault` mined (ERC-6492 unsupported, A1-13).
- Defaults rotation: queued, applied after 48 h, affects new vaults only; existing vaults rotate through their owner (`rotateSigners`). The indexer alerts on `DefaultsQueued` (a K20 compromise shows 48 h before it bites).
- Guardian key loss: admin queues a new guardian (48 h); until then the pause flag keeps its current value.
- New vault version: deploy a new factory (D73); the app points new sign-ups at it; existing users migrate by withdraw-and-redeposit.

## 11. Gas budget

`createVault` ≈ 2.5M gas ≈ 0.05 USDC at 20 Gwei (to be measured; vault bytecode size drives it; must stay under the 24,576-byte EIP-170 limit, which may force a `VaultLib` external library for the WebAuthn and Gateway hashing code).

## 12. Mainnet differences

The factory is deployed through CREATE2 on each network, but its constructor immutables differ per network (`czar-vault.md` §14), so the mainnet factory, and every mainnet vault, has a different address from testnet. Guardian and admin keys are separate per network.

## Change log

| Date | ID | Change |
|---|---|---|
| 2026-10-19 | RV-015 / D73 | Version register removed (a new version is a new factory); `createVault`/`predictVault` take only the owner; network config and defaults are read by the vault constructor, not passed in init code; `setDefaults` replaced by timelocked `queueDefaults`/`applyDefaults`; one caller rule; FAC-3 has no exception; FAC-5 added; same-address claim dropped (SCR-015). |
