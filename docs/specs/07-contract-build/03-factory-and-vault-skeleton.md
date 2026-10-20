# 03 — Factory, vault skeleton and test setup

## 1. Scope
- **Task:** T-012 (CzarVaultFactory), plus the deployable vault skeleton and the shared vault test setup that every later vault PRD uses.
- **You build:**
  - `contracts/foundry.toml`: one lint line (§6).
  - `contracts/src/vault/VaultStorage.sol`: every immutable and storage variable of the vault, its constructor, shared caller checks (§7).
  - `contracts/src/vault/VaultStubs.sol`: temporary placeholders so the vault can be deployed before its functions exist (§8).
  - `contracts/src/CzarVault.sol`: the concrete vault (§9).
  - `contracts/src/CzarVaultFactory.sol`: the factory (§10).
  - Test setup: `test/mocks/MockArcUSDC.sol`, `test/mocks/MockVaultFactory.sol`, `test/helpers/CzarVaultHarness.sol`, `test/helpers/VaultTestBase.sol` (§11).
  - `contracts/test/FactoryTest.t.sol` (§12).
- **You do not build:** any vault function. Every vault function is a stub that reverts `NotBuilt()` until PRDs 04–10 build it.
- **Dependencies:** PRD 01 done (libraries in `src/libraries/`), T-003, T-010. PR #9 (D88) merged into `build-v1`.

## 2. This PRD is already verified
- Every code block and the factory pseudo-code were built into a reference project and checked on **Arc Foundry v0.8.0-2** (checksummed release) with `FOUNDRY_PROFILE=arc`, solc 0.8.30, OpenZeppelin v5.7.0:
  - `FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes`: clean (compiler and lint).
  - `arc-forge fmt --check` on every file: clean. The code blocks are already in `fmt` layout.
  - All tests: 105 passed, 0 failed (34 libraries, 22 factory, and the 49 tests that were already in the repository).
  - Sizes at this stage: `CzarVault` runtime 5,280 B, initcode 6,910 B; `CzarVaultFactory` runtime 11,424 B, initcode 19,579 B.
- **So:** copy every code block exactly. For the factory, follow §10 step by step; the test file in §12 is the acceptance gate.

## 3. Sources (read these, nothing else)
- `07-contract-build/00-conventions.md`, all of it. §3 (layout, `VaultStorage is ICzarVault`, the stubs rule in §3.1), §2.4 (lint), §4.11 and §5.6 (traps) matter most here.
- `docs/specs/03-smart-contracts/czar-vault-factory.md`, all of it.
- `docs/specs/03-smart-contracts/czar-vault.md` §3 (constants and immutables), §4 (storage), §15.1 (callers), §15.2 (errors), §15.8 (constructor).
- `docs/specs/03-smart-contracts/interfaces/ICzarVault.sol` and `ICzarVaultFactory.sol`.
- `docs/specs/03-smart-contracts/security-and-testing.md` §3.3 (`MockArcUSDC`, `MockVaultFactory`, `CzarVaultHarness`) and §3.7 rows for RV-015.

## 4. Steps before you start
1. `git submodule update --init --recursive` (repo root).
2. From `contracts/`: `diff -r src/interfaces ../docs/specs/03-smart-contracts/interfaces` must print nothing. If it prints anything, copy the seven spec files over the copies with `cp` and run it again.
3. `FOUNDRY_PROFILE=arc arc-forge test --match-path test/LibrariesTest.t.sol` must show 34 passed (PRD 01 is done).

## 5. Files
| File | Action | Section |
|---|---|---|
| `contracts/foundry.toml` | edit (one line block) | §6 |
| `contracts/src/vault/VaultStorage.sol` | create | §7 |
| `contracts/src/vault/VaultStubs.sol` | create | §8 |
| `contracts/src/CzarVault.sol` | create | §9 |
| `contracts/src/CzarVaultFactory.sol` | create | §10 |
| `contracts/test/mocks/MockArcUSDC.sol` | create | §11.1 |
| `contracts/test/mocks/MockVaultFactory.sol` | create | §11.2 |
| `contracts/test/helpers/CzarVaultHarness.sol` | create | §11.3 |
| `contracts/test/helpers/VaultTestBase.sol` | create | §11.4 |
| `contracts/test/FactoryTest.t.sol` | create | §12 |

## 6. `foundry.toml`: exclude the timestamp lint
- Why: `arc-forge build` runs forge-lint, and `--deny-warnings` makes every lint warning a build failure (00-conventions §2.4). The factory's timelock and every vault time rule compare `block.timestamp` on purpose (`czar-vault.md` §15.7).
- Replace exactly this block:
```toml
[lint]
ignore = ["test/**/*.sol"]
```
with:
```toml
[lint]
ignore = ["test/**/*.sol"]
# block-timestamp: every time comparison in the vault and factory is a spec rule (czar-vault.md §15.7,
# czar-vault-factory.md §5) on windows of seconds to days; Arc validator skew cannot change an outcome (D88).
exclude_lints = ["block-timestamp"]
```
- Change nothing else in `foundry.toml`.

## 7. `src/vault/VaultStorage.sol`
- **What it is:** the single home of the vault's state. Every vault module inherits it, so every module sees the same variables.
- **Key points (read before copying):**
  - `abstract contract VaultStorage is ICzarVault, ReentrancyGuardTransient`. Inheriting `ICzarVault` here gives every module the interface's types, events and errors, and makes the public variables below implement the interface getters (`owner()`, `agentSigner()`, …) without `override` (00-conventions §3).
  - The three interface constants are public constants whose values come from `CzarConstants.sol` under an alias, because the file-level constant has the same name (00-conventions §4.11).
  - Immutables can only be assigned in the declaring contract's constructor, so `VaultStorage` is the only module with a constructor. It reads the network config and default signers from `msg.sender` (the factory) and checks them exactly as `czar-vault.md` §15.8 says.
  - The storage order is fixed. The step map is `_stepUsed` (00-conventions §4.3).
  - The four `_require*` helpers are the only caller and gate checks. Every later module calls them; none writes its own `msg.sender` comparison. They take a `caller` argument so the passkey path (PRD 10) can pass the owner.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ICzarVault} from "../interfaces/ICzarVault.sol";
import {ICzarVaultFactory} from "../interfaces/ICzarVaultFactory.sol";
import {CzarHashing} from "../libraries/CzarHashing.sol";
import {
    MAX_PULLBACK_FEE_CEILING as MAX_PULLBACK_FEE_CEILING_VALUE,
    MAX_AGENT_POCKET_CAP_BPS as MAX_AGENT_POCKET_CAP_BPS_VALUE,
    POCKET_STEP_INDEX as POCKET_STEP_INDEX_VALUE,
    DEFAULT_MAX_PULLBACK_FEE,
    USDC_NAME_HASH,
    USDC_VERSION_HASH,
    VAULT_NAME_HASH,
    SL_NAME_HASH,
    VERSION_1_HASH
} from "../libraries/CzarConstants.sol";

/// @title VaultStorage
/// @notice Every immutable and storage variable of CzarVault, the constructor, and the shared caller and gate checks.
/// @dev czar-vault.md §3, §4, §15.1, §15.8. The only vault module with a constructor: Solidity lets only the
///      declaring contract's constructor assign an immutable. Storage order below is fixed (00-conventions §4.9).
abstract contract VaultStorage is ICzarVault, ReentrancyGuardTransient {
    /// @dev Fallback-mode digest lookup (czar-vault.md §4, 02 §6.3.4). Internal only; not in the ABI.
    struct DigestSlot {
        uint64 reservationId;
        uint32 index;
        bool set;
    }

    // ───────────── Constants exposed by ICzarVault (values in CzarConstants.sol) ─────────────

    /// @dev 500000 (0.50 USDC), D81.
    uint256 public constant MAX_PULLBACK_FEE_CEILING = MAX_PULLBACK_FEE_CEILING_VALUE;
    /// @dev 2500, D22 and D71.
    uint16 public constant MAX_AGENT_POCKET_CAP_BPS = MAX_AGENT_POCKET_CAP_BPS_VALUE;
    /// @dev type(uint32).max, D71.
    uint32 public constant POCKET_STEP_INDEX = POCKET_STEP_INDEX_VALUE;

    // ───────────── Immutables (czar-vault.md §3, §4; read from the factory, RV-015) ─────────────

    /// @dev The user's smart account.
    address public immutable owner;
    /// @dev The deploying factory; read for guardianPaused().
    address public immutable factory;
    /// @dev ERC-8183 instance.
    address public immutable jobEscrow;
    /// @dev 0 CircleTestnet, 1 CzarBase.
    uint8 public immutable jobEscrowKind;
    /// @dev Arc USDC, 0x3600…0000 on both networks (A1-01).
    address internal immutable USDC;
    /// @dev Circle GatewayWallet for this network.
    address internal immutable GATEWAY_WALLET;
    /// @dev Circle GatewayMinter for this network.
    address internal immutable GATEWAY_MINTER;
    /// @dev Gateway domain id (26 on Arc).
    uint32 internal immutable GATEWAY_DOMAIN;
    /// @dev EIP-712 domain of USDC ("USDC", "2", chainid, USDC).
    bytes32 internal immutable USDC_DOMAIN_SEPARATOR;
    /// @dev EIP-712 domain of the Selection Layer ("SelectionLayer", "1", chainid).
    bytes32 internal immutable SL_DOMAIN_SEPARATOR;
    /// @dev EIP-712 domain of this vault ("CzarVault", "1", chainid, this).
    bytes32 internal immutable VAULT_DOMAIN_SEPARATOR;

    // ───────────── Storage (order fixed) ─────────────

    /// @dev K3 agent key.
    address public agentSigner;
    /// @dev K5 autonomy key.
    address public autonomySigner;
    /// @dev K7 evaluator key.
    address public evaluator;
    /// @dev User freeze flag.
    bool public frozen;
    /// @dev Number of envelopes ever opened; ids start at 1.
    uint64 public envelopeCount;
    /// @dev Number of reservations ever made; ids start at 1.
    uint64 public reservationCount;
    /// @dev Number of pullbacks ever requested; ids start at 1.
    uint64 public pullbackCount;
    /// @dev Current bound on requestPullback.maxFee (D81).
    uint256 public maxPullbackFee;
    /// @dev Replay protection for AutonomyRaise; also bumped by freeze and every lowering (RV-030, D88).
    uint256 public autonomyNonce;
    /// @dev Replay protection for OwnerAction.
    uint256 public ownerActionNonce;
    /// @dev Σ over open envelopes of cap − spent − pocketOutstanding − jobEscrowed − shortfall (INV-2).
    uint256 public committedTotal;
    /// @dev D30 passkey.
    Passkey internal passkey;
    /// @dev Earned-autonomy limits per category.
    mapping(bytes32 categoryId => CategoryLimits) internal limits;
    /// @dev Envelope records.
    mapping(uint64 envelopeId => Envelope) internal envelopes;
    /// @dev Amount reserved or spent per plan step (RV-002). Named with "_" because stepUsed() is the getter.
    mapping(uint64 envelopeId => mapping(uint32 stepIndex => uint256)) internal _stepUsed;
    /// @dev Reservation records.
    mapping(uint64 reservationId => Reservation) internal reservations;
    /// @dev Fallback-mode digest lookup.
    mapping(bytes32 digest => DigestSlot) internal digestSlot;
    /// @dev Pocket records.
    mapping(address pocket => Pocket) internal pockets;
    /// @dev Pullback records.
    mapping(uint64 pullbackId => Pullback) internal pullbacks;
    /// @dev Job records.
    mapping(bytes32 jobKey => Job) internal jobs;

    /// @dev czar-vault.md §15.8. `msg.sender` is the factory.
    constructor(address ownerAccount) {
        ICzarVaultFactory.NetworkConfig memory cfg = ICzarVaultFactory(msg.sender).networkConfig();
        ICzarVaultFactory.Defaults memory d = ICzarVaultFactory(msg.sender).defaults();
        if (
            ownerAccount == address(0) || cfg.usdc == address(0) || cfg.gatewayWallet == address(0)
                || cfg.gatewayMinter == address(0) || cfg.jobEscrow == address(0) || d.agentSigner == address(0)
                || d.autonomySigner == address(0) || d.evaluator == address(0)
        ) revert ZeroAddress();
        if (cfg.jobEscrowKind > 1 || d.agentSigner == d.evaluator) revert BadParams();

        owner = ownerAccount;
        factory = msg.sender;
        jobEscrow = cfg.jobEscrow;
        jobEscrowKind = cfg.jobEscrowKind;
        USDC = cfg.usdc;
        GATEWAY_WALLET = cfg.gatewayWallet;
        GATEWAY_MINTER = cfg.gatewayMinter;
        GATEWAY_DOMAIN = cfg.gatewayDomain;
        USDC_DOMAIN_SEPARATOR =
            CzarHashing.domainSeparatorFull(USDC_NAME_HASH, USDC_VERSION_HASH, block.chainid, cfg.usdc);
        SL_DOMAIN_SEPARATOR = CzarHashing.domainSeparatorNoContract(SL_NAME_HASH, VERSION_1_HASH, block.chainid);
        VAULT_DOMAIN_SEPARATOR =
            CzarHashing.domainSeparatorFull(VAULT_NAME_HASH, VERSION_1_HASH, block.chainid, address(this));

        agentSigner = d.agentSigner;
        autonomySigner = d.autonomySigner;
        evaluator = d.evaluator;
        maxPullbackFee = DEFAULT_MAX_PULLBACK_FEE;
    }

    // ───────────── Shared checks (czar-vault.md §15.1, §15.2) ─────────────

    /// @dev Owner-only rule. `caller` is msg.sender, or the owner when dispatched by executeOwnerAction.
    function _requireOwner(address caller) internal view {
        if (caller != owner) revert NotOwner();
    }

    /// @dev Agent-only rule.
    function _requireAgent(address caller) internal view {
        if (caller != agentSigner) revert NotAgent();
    }

    /// @dev Owner-or-agent rule.
    function _requireOwnerOrAgent(address caller) internal view {
        if (caller != owner && caller != agentSigner) revert NotAuthorized();
    }

    /// @dev notPausedOrFrozen: freeze is checked before pause (§15.2).
    function _requireNotPausedOrFrozen() internal view {
        if (frozen) revert FrozenVault();
        if (ICzarVaultFactory(factory).guardianPaused()) revert Paused();
    }
}
```

## 8. `src/vault/VaultStubs.sol` (temporary)
- **What it is:** one placeholder per `ICzarVault` function that has no body yet, so `CzarVault` is a complete contract and can be deployed by the factory and by tests. Rules: 00-conventions §3.1.
- 44 stubs at this stage: the 62 interface functions minus the 18 that `VaultStorage`'s public variables and constants already implement.
- Stubs are `pure` so the compiler raises no "can be restricted to pure" warning.
- **Every later vault PRD deletes the stubs of the functions it builds.** PRD 04 deletes 19 of them.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VaultStorage} from "./VaultStorage.sol";

/// @title VaultStubs
/// @notice TEMPORARY. One placeholder per ICzarVault function that is not built, so CzarVault compiles and can be
///         deployed from PRD 03 on. Stubs are `pure` (stricter than the interface allows) so the compiler raises no
///         warning for an unused body. Each later PRD deletes the stubs of the functions it builds; PRD 10 deletes this
///         file. `NotBuilt` exists only here and must not appear anywhere once M1 is done.
abstract contract VaultStubs is VaultStorage {
    /// @dev Placeholder error; removed with this file.
    error NotBuilt();

    function cancelJob(bytes32) external pure {
        revert NotBuilt();
    }

    function cancelPullback(uint64) external pure {
        revert NotBuilt();
    }

    function claimJobRefund(bytes32) external pure {
        revert NotBuilt();
    }

    function closeEnvelope(uint64) external pure {
        revert NotBuilt();
    }

    function confirmPullback(uint64) external pure {
        revert NotBuilt();
    }

    function derivedNonce(uint64, uint32) external pure returns (bytes32) {
        revert NotBuilt();
    }

    function envelopePocket(uint64) external pure returns (address) {
        revert NotBuilt();
    }

    function envelopeShortfall(uint64) external pure returns (uint256) {
        revert NotBuilt();
    }

    function executeOwnerAction(uint8, bytes calldata, uint256, WebAuthnAuth calldata) external pure {
        revert NotBuilt();
    }

    function finalize(uint64, uint32, uint32) external pure {
        revert NotBuilt();
    }

    function forceCloseEnvelope(uint64) external pure {
        revert NotBuilt();
    }

    function freeBalance() external pure returns (uint256) {
        revert NotBuilt();
    }

    function freeze() external pure {
        revert NotBuilt();
    }

    function fundJob(bytes32, uint256) external pure {
        revert NotBuilt();
    }

    function fundPocket(address, uint256) external pure {
        revert NotBuilt();
    }

    function getEnvelope(uint64) external pure returns (Envelope memory) {
        revert NotBuilt();
    }

    function getJob(bytes32) external pure returns (Job memory) {
        revert NotBuilt();
    }

    function getLimits(bytes32) external pure returns (CategoryLimits memory) {
        revert NotBuilt();
    }

    function getPasskey() external pure returns (Passkey memory) {
        revert NotBuilt();
    }

    function getPocket(address) external pure returns (Pocket memory) {
        revert NotBuilt();
    }

    function getPullback(uint64) external pure returns (Pullback memory) {
        revert NotBuilt();
    }

    function getReservation(uint64) external pure returns (Reservation memory) {
        revert NotBuilt();
    }

    function grantPocketGas(address, uint256) external pure {
        revert NotBuilt();
    }

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        revert NotBuilt();
    }

    function lowerAutoLimit(bytes32, uint256) external pure {
        revert NotBuilt();
    }

    function openEnvelope(OpenEnvelopeParams calldata) external pure returns (uint64) {
        revert NotBuilt();
    }

    function openJob(uint64, uint32, address, uint256, bytes32[] calldata, uint64, bytes32)
        external
        pure
        returns (bytes32)
    {
        revert NotBuilt();
    }

    function raiseAutoLimit(bytes32, uint256, uint64, uint256, bytes calldata) external pure {
        revert NotBuilt();
    }

    function recordManualReturn(address, uint256) external pure {
        revert NotBuilt();
    }

    function registerPocket(uint64, address, bytes32[] calldata) external pure {
        revert NotBuilt();
    }

    function requestPullback(address, uint256, uint256, uint256) external pure returns (uint64) {
        revert NotBuilt();
    }

    function reserve(uint64, uint32, address, uint256, bytes32[] calldata, uint256, uint32, uint64)
        external
        pure
        returns (uint64)
    {
        revert NotBuilt();
    }

    function reserveWithDigests(uint64, uint32, address, uint256, bytes32[] calldata, uint256, uint32, uint64)
        external
        pure
        returns (uint64)
    {
        revert NotBuilt();
    }

    function rotateSigners(address, address, address) external pure {
        revert NotBuilt();
    }

    function setCategoryLimits(bytes32, uint256, uint256) external pure {
        revert NotBuilt();
    }

    function setMaxPullbackFee(uint256) external pure {
        revert NotBuilt();
    }

    function setPasskey(bytes32, bytes32, bytes32) external pure {
        revert NotBuilt();
    }

    function settle(uint64, uint32[] calldata) external pure {
        revert NotBuilt();
    }

    function stepUsed(uint64, uint32) external pure returns (uint256) {
        revert NotBuilt();
    }

    function sync() external pure {
        revert NotBuilt();
    }

    function syncJob(bytes32) external pure {
        revert NotBuilt();
    }

    function unfreeze() external pure {
        revert NotBuilt();
    }

    function withdraw(address, uint256) external pure {
        revert NotBuilt();
    }

    function writeOffPocket(address) external pure {
        revert NotBuilt();
    }
}
```

## 9. `src/CzarVault.sol`
- The only concrete vault. At this stage it inherits only `VaultStubs` (which inherits `VaultStorage`). Each later PRD adds its module to the `is` list.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VaultStorage} from "./vault/VaultStorage.sol";
import {VaultStubs} from "./vault/VaultStubs.sol";

/// @title CzarVault
/// @notice The per-user vault (czar-vault.md). Immutable; no proxy (D33). The only concrete vault contract: it
///         inherits every vault module. Each later PRD adds its module to this list and removes its stubs.
contract CzarVault is VaultStubs {
    /// @dev czar-vault.md §15.8. Called by CzarVaultFactory.createVault through CREATE2.
    constructor(address ownerAccount) VaultStorage(ownerAccount) {}
}
```

## 10. `src/CzarVaultFactory.sol`

### 10.1 Header and inheritance
- `// SPDX-License-Identifier: MIT`, `pragma solidity 0.8.30;`
- Imports, exactly these:
  - `{Ownable}` from `@openzeppelin/contracts/access/Ownable.sol`
  - `{Ownable2Step}` from `@openzeppelin/contracts/access/Ownable2Step.sol`
  - `{SafeCast}` from `@openzeppelin/contracts/utils/math/SafeCast.sol`
  - `{ICzarVaultFactory}` from `./interfaces/ICzarVaultFactory.sol`
  - `{CzarVault}` from `./CzarVault.sol`
- `contract CzarVaultFactory is ICzarVaultFactory, Ownable2Step`
- NatSpec on every item; public items implementing the interface use `/// @inheritdoc ICzarVaultFactory`.

### 10.2 Types, constants, immutables, storage (in this order)
| Item | Declaration | Spec |
|---|---|---|
| change record | `struct PendingChange { uint8 kind; uint64 eta; bytes32 payloadHash; }` | factory §4 |
| timelock | `uint256 internal constant ADMIN_TIMELOCK = 48 hours;` (internal: it is not in the interface) | §3 |
| kinds | `uint8 internal constant KIND_GUARDIAN = 1;` and `uint8 internal constant KIND_DEFAULTS = 2;` | §4 |
| version | `uint32 public constant VAULT_VERSION = 1;` | §3 |
| code hash | `bytes32 public immutable VAULT_CREATION_CODE_HASH;` | §3 |
| network immutables | `address internal immutable USDC; GATEWAY_WALLET; GATEWAY_MINTER;` `uint32 internal immutable GATEWAY_DOMAIN;` `address internal immutable JOB_ESCROW;` `uint8 internal immutable JOB_ESCROW_KIND;` | §3 `networkConfig` |
| guardian | `address public guardian;` | §4 |
| pause flag | `bool public guardianPaused;` | §4 |
| defaults | `Defaults internal _defaults;` (a public struct getter would return a tuple, not the struct the interface needs) | §4 |
| vault maps | `mapping(address ownerAccount => address vault) public vaultOf;` `mapping(address vault => bool) public isVault;` | §4 |
| queue | `mapping(bytes32 changeId => PendingChange) internal _pendingChanges;` | §4 |
| nonce | `uint256 internal _changeNonce;` | §4, D88 |

### 10.3 Constructor
Signature: `constructor(NetworkConfig memory cfg, Defaults memory initialDefaults, address guardian_, address admin_) Ownable(_nonZero(admin_))`
1. The base-constructor argument is `_nonZero(admin_)`, a `private pure` helper that reverts `ZeroAddress()` when its argument is zero and otherwise returns it. Reason: `Ownable`'s constructor runs before this body and would revert with `OwnableInvalidOwner(address(0))` first (factory §3).
2. If any of `cfg.usdc`, `cfg.gatewayWallet`, `cfg.gatewayMinter`, `cfg.jobEscrow`, `initialDefaults.agentSigner`, `initialDefaults.autonomySigner`, `initialDefaults.evaluator`, `guardian_` is `address(0)`: `revert ZeroAddress();`
3. If `cfg.jobEscrowKind > 1 || initialDefaults.agentSigner == initialDefaults.evaluator`: `revert BadParams();`
4. Store the six network fields in the six immutables; `_defaults = initialDefaults;` `guardian = guardian_;`
5. `VAULT_CREATION_CODE_HASH = keccak256(type(CzarVault).creationCode);`

### 10.4 Functions
Write each function in this order, with exactly these checks in this order.

1. **`createVault(address ownerAccount) external returns (address vault)`** (anyone)
   1. `if (ownerAccount == address(0)) revert ZeroAddress();`
   2. `if (vaultOf[ownerAccount] != address(0)) revert VaultExists();`
   3. `vault = address(new CzarVault{salt: keccak256(abi.encode(ownerAccount))}(ownerAccount));`
   4. `vaultOf[ownerAccount] = vault; isVault[vault] = true;`
   5. `emit VaultCreated(ownerAccount, vault, VAULT_VERSION, _defaults.agentSigner, _defaults.autonomySigner, _defaults.evaluator);`
2. **`predictVault(address ownerAccount) external view returns (address)`**
   1. `initCodeHash = keccak256(abi.encodePacked(type(CzarVault).creationCode, abi.encode(ownerAccount)))`
   2. `h = keccak256(abi.encodePacked(bytes1(0xff), address(this), keccak256(abi.encode(ownerAccount)), initCodeHash))`
   3. `return address(uint160(uint256(h)));`
3. **`pause() external`**: `if (msg.sender != guardian) revert NotGuardian();` then `guardianPaused = true;` then `emit GuardianPaused(msg.sender);` (idempotent: no "already paused" check).
4. **`unpause() external`**: same check; `guardianPaused = false;` `emit GuardianUnpaused(msg.sender);`
5. **`networkConfig() external view returns (NetworkConfig memory)`**: return a `NetworkConfig` built from the six immutables (named fields).
6. **`defaults() external view returns (Defaults memory)`**: `return _defaults;`
7. **`queueGuardian(address newGuardian) external onlyOwner returns (bytes32 changeId)`**
   1. `if (newGuardian == address(0)) revert ZeroAddress();`
   2. `(changeId, eta) = _queue(KIND_GUARDIAN, keccak256(abi.encode(newGuardian)));` (declare `uint64 eta;` first)
   3. `emit GuardianQueued(changeId, newGuardian, eta);`
8. **`applyGuardian(bytes32 changeId, address newGuardian) external`** (anyone)
   1. `if (newGuardian == address(0)) revert ZeroAddress();` (also satisfies the `missing-zero-check` lint)
   2. `_consume(changeId, KIND_GUARDIAN, keccak256(abi.encode(newGuardian)));`
   3. `address oldGuardian = guardian; guardian = newGuardian;`
   4. `emit GuardianChanged(oldGuardian, newGuardian);`
9. **`queueDefaults(address agentSigner, address autonomySigner, address evaluator) external onlyOwner returns (bytes32 changeId)`**
   1. any of the three zero → `revert ZeroAddress();`
   2. `if (agentSigner == evaluator) revert BadParams();`
   3. `(changeId, eta) = _queue(KIND_DEFAULTS, keccak256(abi.encode(agentSigner, autonomySigner, evaluator)));`
   4. `emit DefaultsQueued(changeId, agentSigner, autonomySigner, evaluator, eta);`
10. **`applyDefaults(bytes32 changeId, address agentSigner, address autonomySigner, address evaluator) external`** (anyone)
    1. any of the three zero → `revert ZeroAddress();`
    2. `_consume(changeId, KIND_DEFAULTS, keccak256(abi.encode(agentSigner, autonomySigner, evaluator)));`
    3. `_defaults = Defaults({agentSigner: agentSigner, autonomySigner: autonomySigner, evaluator: evaluator});`
    4. `emit DefaultsSet(agentSigner, autonomySigner, evaluator);`
11. **`cancelChange(bytes32 changeId) external onlyOwner`**
    1. `if (_pendingChanges[changeId].kind == 0) revert UnknownChange();`
    2. `delete _pendingChanges[changeId];`
    3. `emit ChangeCancelled(changeId);`
12. **`_queue(uint8 kind, bytes32 payloadHash) internal returns (bytes32 changeId, uint64 eta)`**
    1. `eta = SafeCast.toUint64(block.timestamp + ADMIN_TIMELOCK);` (SafeCast, not a plain cast: the `unsafe-typecast` lint)
    2. `changeId = keccak256(abi.encode(kind, payloadHash, eta, ++_changeNonce));`
    3. `_pendingChanges[changeId] = PendingChange({kind: kind, eta: eta, payloadHash: payloadHash});`
13. **`_consume(bytes32 changeId, uint8 kind, bytes32 payloadHash) internal`**
    1. `PendingChange memory c = _pendingChanges[changeId];`
    2. `if (c.kind != kind) revert UnknownChange();` (also catches an unknown id: its `kind` is 0)
    3. `if (block.timestamp < c.eta) revert TooEarly();`
    4. `if (c.payloadHash != payloadHash) revert UnknownChange();`
    5. `delete _pendingChanges[changeId];`
14. **`_nonZero(address a) private pure returns (address)`**: `if (a == address(0)) revert ZeroAddress(); return a;`

- `owner()`, `transferOwnership`, `acceptOwnership` and `OwnableUnauthorizedAccount` come from OpenZeppelin unchanged. `guardian()`, `guardianPaused()`, `vaultOf()`, `isVault()`, `VAULT_VERSION()` and `VAULT_CREATION_CODE_HASH()` come from the public variables.
- Add no other public or external function.

### 10.5 Pitfalls
- The vault's constructor calls back into the factory (`networkConfig()`, `defaults()`) during `createVault`. Both are `view`, and `createVault` writes `vaultOf` only after the deployment, so FAC-1 holds; do not move step 4 before step 3.
- `type(CzarVault).creationCode` appears twice in the factory's initcode (runtime plus the constructor's hash). That is expected; `czar-vault-factory.md` §11 records the numbers.

## 11. Test setup

### 11.1 `test/mocks/MockArcUSDC.sol`
- **What it is:** `MockUSDC3009` (T-010) with its balance ledger replaced by the native balance, as on Arc (`security-and-testing.md` §3.3). All vault tests use it at `0x3600…0000`.
- **Differences from `MockUSDC3009`:** the `forge-std` `Vm` import and `VM` constant; `NATIVE_SCALE = 1e12`; `balanceOf` is a function returning `account.balance / NATIVE_SCALE`; `mint` and `_transfer` move native value with `VM.deal`; the contract name and the controller revert string. Everything else is identical.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";

/// @title MockArcUSDC
/// @notice Test double of Arc USDC (`NativeFiatTokenV2_2`, A1-04) for vault unit, fuzz and invariant tests, with
///         ONE ledger: the native balance is the USDC balance, as on Arc (A1-05). `balanceOf(a) = a.balance / 1e12`;
///         every transfer moves native value with `vm.deal`. So a native send by the vault (grantPocketGas) lowers its
///         USDC balance exactly as on Arc (security-and-testing.md §3.3, D88 G-62). A copy of MockUSDC3009 with the
///         ledger replaced; everything else (EIP-3009, ERC-1271 dispatch, nonces, pause, blacklist) is unchanged.
///         Place it at 0x3600…0000 with deployCodeTo (00-conventions §5.5).
/// @dev Behaviour follows circlefin/stablecoin-evm `contracts/v2/EIP3009.sol` lines 84–143 and 296–335 and
///      `contracts/util/SignatureChecker.sol` lines 38–76 (A1-06, A1-07, A1-09). Revert strings are copied.
contract MockArcUSDC {
    /// @dev Foundry cheatcode address; this mock is test-only.
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    /// @dev One 6-decimal USDC unit is 10^12 wei of native value (A1-05).
    uint256 internal constant NATIVE_SCALE = 1e12;

    // A1-03: name "USDC", symbol "USDC", version "2", decimals 6.
    string internal constant NAME = "USDC";
    string internal constant SYMBOL = "USDC";
    string internal constant VERSION = "2";
    uint8 internal constant DECIMALS = 6;

    // EIP3009.sol: keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
    // keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;
    // keccak256("CancelAuthorization(address authorizer,bytes32 nonce)")
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;

    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    uint256 internal constant ECDSA_SIGNATURE_LENGTH = 65;
    // secp256k1n / 2; ECRecover rejects malleable high-s signatures.
    uint256 internal constant SECP256K1_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    bool public paused;
    mapping(address => bool) internal _blacklisted;
    mapping(address => mapping(bytes32 => bool)) internal _authorizationStates;
    address public immutable controller;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    event Pause();
    event Unpause();
    event Blacklisted(address indexed account);
    event UnBlacklisted(address indexed account);

    modifier whenNotPaused() {
        require(!paused, "Pausable: paused");
        _;
    }

    modifier notBlacklisted(address account) {
        require(!_blacklisted[account], "Blacklistable: account is blacklisted");
        _;
    }

    modifier onlyController() {
        require(msg.sender == controller, "MockArcUSDC: caller is not the controller");
        _;
    }

    constructor() {
        controller = msg.sender;
    }

    // ─────────────── Test controls (stand in for Circle's minter, pauser and blacklister roles) ───────────────

    function mint(address to, uint256 value) external onlyController {
        require(to != address(0), "FiatToken: mint to the zero address");
        require(value > 0, "FiatToken: mint amount not greater than 0");
        totalSupply += value;
        VM.deal(to, to.balance + value * NATIVE_SCALE);
        emit Transfer(address(0), to, value);
    }

    function pause() external onlyController {
        paused = true;
        emit Pause();
    }

    function unpause() external onlyController {
        paused = false;
        emit Unpause();
    }

    function blacklist(address account) external onlyController {
        _blacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unBlacklist(address account) external onlyController {
        _blacklisted[account] = false;
        emit UnBlacklisted(account);
    }

    // ─────────────── ERC-20 (FiatTokenV2_2 modifiers) ───────────────

    /// @notice Arc rule: the ERC-20 view of the native balance, rounded down to 6 decimals (A1-05).
    function balanceOf(address account) public view returns (uint256) {
        return account.balance / NATIVE_SCALE;
    }

    function name() external pure returns (string memory) {
        return NAME;
    }

    function symbol() external pure returns (string memory) {
        return SYMBOL;
    }

    function version() external pure returns (string memory) {
        return VERSION;
    }

    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    function isBlacklisted(address account) external view returns (bool) {
        return _blacklisted[account];
    }

    /// @notice A1-03: DOMAIN_SEPARATOR = EIP712Domain(name "USDC", version "2", chainId, verifyingContract).
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    function approve(address spender, uint256 value)
        external
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(spender)
        returns (bool)
    {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value)
        external
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(to)
        returns (bool)
    {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value)
        external
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(from)
        notBlacklisted(to)
        returns (bool)
    {
        require(value <= allowance[from][msg.sender], "ERC20: transfer amount exceeds allowance");
        allowance[from][msg.sender] -= value;
        _transfer(from, to, value);
        return true;
    }

    // ─────────────── EIP-3009 (A1-08 selectors) ───────────────

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @notice `0xe3ee160e`: the v,r,s overload packs abi.encodePacked(r, s, v) and takes the same path (A1-09).
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused notBlacklisted(from) notBlacklisted(to) {
        _transferWithAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
            abi.encodePacked(r, s, v)
        );
    }

    /// @notice `0xcf092995`: the bytes overload used for contract signers (A1-08, A1-20).
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external whenNotPaused notBlacklisted(from) notBlacklisted(to) {
        _transferWithAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature
        );
    }

    /// @notice `0x88b7ab63` (A1-08). The caller must be the payee.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external whenNotPaused notBlacklisted(from) notBlacklisted(to) {
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        _transferWithAuthorization(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature
        );
    }

    /// @notice `0xb7b72899` (A1-08).
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) external whenNotPaused {
        require(!_authorizationStates[authorizer][nonce], "FiatTokenV2: authorization is used or canceled");
        _requireValidSignature(
            authorizer, keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)), signature
        );
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _transferWithAuthorization(
        bytes32 typeHash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) internal {
        // EIP3009.sol _requireValidAuthorization: strict inequalities on both bounds.
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!_authorizationStates[from][nonce], "FiatTokenV2: authorization is used or canceled");
        _requireValidSignature(
            from, keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce)), signature
        );
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _requireValidSignature(address signer, bytes32 structHash, bytes memory signature) internal view {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        require(_isValidSignatureNow(signer, digest, signature), "FiatTokenV2: invalid signature");
    }

    /// @dev SignatureChecker.isValidSignatureNow (A1-09): a signer with code is asked through a staticcall to
    ///      isValidSignature(bytes32,bytes); the call must succeed and return at least 32 bytes whose first word
    ///      equals 0x1626ba7e. A signer without code is checked by ECDSA recovery.
    function _isValidSignatureNow(address signer, bytes32 digest, bytes memory signature) internal view returns (bool) {
        if (signer.code.length == 0) return _recover(digest, signature) == signer;
        (bool success, bytes memory result) =
            signer.staticcall(abi.encodeWithSelector(ERC1271_MAGIC_VALUE, digest, signature));
        return success && result.length >= 32 && abi.decode(result, (bytes32)) == bytes32(ERC1271_MAGIC_VALUE);
    }

    /// @dev ECRecover.recover: 65-byte r‖s‖v only, low s, v ∈ {27, 28}, non-zero result.
    function _recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        require(signature.length == ECDSA_SIGNATURE_LENGTH, "ECRecover: invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        require(uint256(s) <= SECP256K1_HALF_N, "ECRecover: invalid signature 's' value");
        require(v == 27 || v == 28, "ECRecover: invalid signature 'v' value");
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0), "ECRecover: invalid signature");
        return recovered;
    }

    /// @dev NativeFiatTokenV2_2 _transfer checks (A1-05; zero-address rule also enforced by Arc, A9-14).
    function _transfer(address from, address to, uint256 value) internal {
        require(from != address(0), "ERC20: transfer from the zero address");
        require(to != address(0), "ERC20: transfer to the zero address");
        require(value <= balanceOf(from), "ERC20: transfer amount exceeds balance");
        VM.deal(from, from.balance - value * NATIVE_SCALE);
        VM.deal(to, to.balance + value * NATIVE_SCALE);
        emit Transfer(from, to, value);
    }
}
```

### 11.2 `test/mocks/MockVaultFactory.sol`
- The vault's factory in vault tests: the three views the vault calls, setters, and deploy helpers that make this mock `msg.sender` of the vault constructor (`deployCodeAt` places a vault at a fixed address for vector tests).
- The assembly block in `deployCode` is the only assembly in the test setup; copy it exactly.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {ICzarVaultFactory} from "../../src/interfaces/ICzarVaultFactory.sol";
import {CzarVault} from "../../src/CzarVault.sol";

/// @title MockVaultFactory
/// @notice Test-only stand-in for CzarVaultFactory as the vault sees it: the three views the vault constructor and
///         spending paths call (networkConfig, defaults, guardianPaused), settable, plus helpers that deploy a vault
///         with this contract as msg.sender (security-and-testing.md §3.3, D88 G-66).
contract MockVaultFactory {
    /// @dev Foundry cheatcode address; this mock is test-only.
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    ICzarVaultFactory.NetworkConfig internal _cfg;
    ICzarVaultFactory.Defaults internal _defaults;
    bool public guardianPaused;

    constructor(ICzarVaultFactory.NetworkConfig memory cfg, ICzarVaultFactory.Defaults memory d) {
        _cfg = cfg;
        _defaults = d;
    }

    function networkConfig() external view returns (ICzarVaultFactory.NetworkConfig memory) {
        return _cfg;
    }

    function defaults() external view returns (ICzarVaultFactory.Defaults memory) {
        return _defaults;
    }

    function setGuardianPaused(bool paused) external {
        guardianPaused = paused;
    }

    function setNetworkConfig(ICzarVaultFactory.NetworkConfig memory cfg) external {
        _cfg = cfg;
    }

    function setDefaults(ICzarVaultFactory.Defaults memory d) external {
        _defaults = d;
    }

    /// @notice Deploys a CzarVault for `ownerAccount` with CREATE; constructor reverts bubble up unchanged.
    function deploy(address ownerAccount) external returns (CzarVault) {
        return CzarVault(payable(deployCode(abi.encodePacked(type(CzarVault).creationCode, abi.encode(ownerAccount)))));
    }

    /// @notice Deploys any creation code (with its constructor arguments appended) with CREATE, so the new contract
    ///         sees this mock as msg.sender. Used for CzarVaultHarness. Constructor reverts bubble up unchanged.
    function deployCode(bytes memory initcode) public returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create(0, add(initcode, 0x20), mload(initcode))
            if iszero(deployed) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
    }

    /// @notice Deploys creation code at a fixed address (vector tests), the way forge-std deployCodeTo does: run it
    ///         at `where` with this mock as msg.sender, then store the returned runtime code there.
    function deployCodeAt(address where, bytes memory initcode) external returns (address) {
        VM.etch(where, initcode);
        (bool ok, bytes memory runtime) = where.call("");
        require(ok, "MockVaultFactory: constructor reverted");
        VM.etch(where, runtime);
        return where;
    }
}
```

### 11.3 `test/helpers/CzarVaultHarness.sol`
- Test-only subclass of `CzarVault` exposing internal values. Later PRDs add `exposed_*` functions here.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {CzarVault} from "../../src/CzarVault.sol";

/// @title CzarVaultHarness
/// @notice Test-only subclass that exposes internal values for vector and storage tests (security-and-testing.md
///         §3.3, D88 G-58). Later PRDs add `exposed_*` functions here; it never changes vault behaviour.
contract CzarVaultHarness is CzarVault {
    constructor(address ownerAccount) CzarVault(ownerAccount) {}

    function exposed_usdcDomainSeparator() external view returns (bytes32) {
        return USDC_DOMAIN_SEPARATOR;
    }

    function exposed_slDomainSeparator() external view returns (bytes32) {
        return SL_DOMAIN_SEPARATOR;
    }

    function exposed_vaultDomainSeparator() external view returns (bytes32) {
        return VAULT_DOMAIN_SEPARATOR;
    }

    function exposed_gatewayDomain() external view returns (uint32) {
        return GATEWAY_DOMAIN;
    }
}
```

### 11.4 `test/helpers/VaultTestBase.sol`
- Shared setup for every vault test (00-conventions §5.1, §5.4).
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ICzarVault} from "../../src/interfaces/ICzarVault.sol";
import {ICzarVaultFactory} from "../../src/interfaces/ICzarVaultFactory.sol";
import {CzarVault} from "../../src/CzarVault.sol";
import {USDC_ADDRESS} from "../../src/libraries/CzarConstants.sol";
import {MockArcUSDC} from "../mocks/MockArcUSDC.sol";
import {MockGatewayWallet} from "../mocks/MockGatewayWallet.sol";
import {MockGatewayMinter} from "../mocks/MockGatewayMinter.sol";
import {MockCircleAgenticCommerce} from "../mocks/MockCircleAgenticCommerce.sol";
import {MockVaultFactory} from "../mocks/MockVaultFactory.sol";

/// @title VaultTestBase
/// @notice Shared setup for every vault test (07 PRD 04): Arc chain id, a fixed time and block, the one-ledger USDC
///         mock at 0x3600…0000, the Gateway and job-escrow mocks, a MockVaultFactory and one vault.
abstract contract VaultTestBase is Test {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;
    uint256 internal constant START_TIME = 1_792_000_000; // 00-conventions §5.4
    uint256 internal constant START_BLOCK = 68_000_000; // 00-conventions §5.4
    uint32 internal constant ARC_GATEWAY_DOMAIN = 26; // czar-vault.md §3
    uint256 internal constant ONE_USDC = 1_000_000;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal autonomy = makeAddr("autonomy");
    address internal evaluatorKey = makeAddr("evaluator");
    address internal stranger = makeAddr("stranger");
    address internal treasury = makeAddr("treasury");

    MockArcUSDC internal usdc;
    MockGatewayWallet internal gatewayWallet;
    MockGatewayMinter internal gatewayMinter;
    MockCircleAgenticCommerce internal jobEscrow;
    MockVaultFactory internal vaultFactory;
    CzarVault internal vault;

    function setUp() public virtual {
        vm.chainId(ARC_TESTNET_CHAIN_ID);
        vm.warp(START_TIME);
        vm.roll(START_BLOCK);

        deployCodeTo("MockArcUSDC.sol:MockArcUSDC", USDC_ADDRESS);
        usdc = MockArcUSDC(USDC_ADDRESS);
        gatewayWallet = new MockGatewayWallet(USDC_ADDRESS);
        gatewayMinter = new MockGatewayMinter();
        jobEscrow = new MockCircleAgenticCommerce(USDC_ADDRESS, treasury);

        vaultFactory = new MockVaultFactory(_networkConfig(), _defaults());
        vault = vaultFactory.deploy(owner);
    }

    function _networkConfig() internal view returns (ICzarVaultFactory.NetworkConfig memory) {
        return ICzarVaultFactory.NetworkConfig({
            usdc: USDC_ADDRESS,
            gatewayWallet: address(gatewayWallet),
            gatewayMinter: address(gatewayMinter),
            gatewayDomain: ARC_GATEWAY_DOMAIN,
            jobEscrow: address(jobEscrow),
            jobEscrowKind: 0
        });
    }

    function _defaults() internal view returns (ICzarVaultFactory.Defaults memory) {
        return ICzarVaultFactory.Defaults({agentSigner: agent, autonomySigner: autonomy, evaluator: evaluatorKey});
    }

    /// @dev Mints USDC to the vault (free balance).
    function _fundVault(uint256 amount) internal {
        usdc.mint(address(vault), amount);
    }
}
```

## 12. `test/FactoryTest.t.sol`
- Covers the constructor (zero and bad parameters), `createVault`/`predictVault` (FAC-1, FAC-5, the RV-015 named tests), pause (FAC-2), the timelocked changes and cancellation (FAC-3), FAC-4, and the two-step ownership transfer.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ICzarVaultFactory} from "../src/interfaces/ICzarVaultFactory.sol";
import {CzarVaultFactory} from "../src/CzarVaultFactory.sol";
import {CzarVault} from "../src/CzarVault.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";

/// @dev 07 PRD 03 (T-012). czar-vault-factory.md §3–§9; FAC-1..5.
contract FactoryTest is VaultTestBase {
    uint256 internal constant ADMIN_TIMELOCK = 48 hours; // czar-vault-factory.md §3

    address internal guardianKey = makeAddr("guardian");
    address internal admin = makeAddr("admin");
    address internal user = makeAddr("user");
    CzarVaultFactory internal factory;

    function setUp() public override {
        super.setUp();
        factory = new CzarVaultFactory(_networkConfig(), _defaults(), guardianKey, admin);
    }

    // ───────────── Constructor ─────────────

    function test_constructor_setsConfigDefaultsGuardianAdmin() public view {
        ICzarVaultFactory.NetworkConfig memory cfg = factory.networkConfig();
        assertEq(cfg.usdc, _networkConfig().usdc);
        assertEq(cfg.gatewayWallet, address(gatewayWallet));
        assertEq(cfg.gatewayMinter, address(gatewayMinter));
        assertEq(cfg.gatewayDomain, ARC_GATEWAY_DOMAIN);
        assertEq(cfg.jobEscrow, address(jobEscrow));
        assertEq(cfg.jobEscrowKind, 0);
        ICzarVaultFactory.Defaults memory d = factory.defaults();
        assertEq(d.agentSigner, agent);
        assertEq(d.autonomySigner, autonomy);
        assertEq(d.evaluator, evaluatorKey);
        assertEq(factory.guardian(), guardianKey);
        assertEq(factory.owner(), admin);
        assertFalse(factory.guardianPaused());
        assertEq(factory.VAULT_VERSION(), 1);
        assertEq(factory.VAULT_CREATION_CODE_HASH(), keccak256(type(CzarVault).creationCode));
    }

    function test_constructor_zeroAdmin_revertsZeroAddress() public {
        ICzarVaultFactory.NetworkConfig memory cfg = _networkConfig();
        ICzarVaultFactory.Defaults memory d = _defaults();
        vm.expectRevert(ICzarVaultFactory.ZeroAddress.selector);
        new CzarVaultFactory(cfg, d, guardianKey, address(0));
    }

    function test_constructor_zeroGuardian_reverts() public {
        ICzarVaultFactory.NetworkConfig memory cfg = _networkConfig();
        ICzarVaultFactory.Defaults memory d = _defaults();
        vm.expectRevert(ICzarVaultFactory.ZeroAddress.selector);
        new CzarVaultFactory(cfg, d, address(0), admin);
    }

    function test_constructor_zeroNetworkAddress_reverts() public {
        ICzarVaultFactory.NetworkConfig memory cfg = _networkConfig();
        cfg.jobEscrow = address(0);
        ICzarVaultFactory.Defaults memory d = _defaults();
        vm.expectRevert(ICzarVaultFactory.ZeroAddress.selector);
        new CzarVaultFactory(cfg, d, guardianKey, admin);
    }

    function test_constructor_badEscrowKind_reverts() public {
        ICzarVaultFactory.NetworkConfig memory cfg = _networkConfig();
        cfg.jobEscrowKind = 2;
        ICzarVaultFactory.Defaults memory d = _defaults();
        vm.expectRevert(ICzarVaultFactory.BadParams.selector);
        new CzarVaultFactory(cfg, d, guardianKey, admin);
    }

    function test_constructor_agentEqualsEvaluator_reverts() public {
        ICzarVaultFactory.NetworkConfig memory cfg = _networkConfig();
        ICzarVaultFactory.Defaults memory d = _defaults();
        d.evaluator = d.agentSigner;
        vm.expectRevert(ICzarVaultFactory.BadParams.selector);
        new CzarVaultFactory(cfg, d, guardianKey, admin);
    }

    // ───────────── createVault, predictVault (FAC-1, FAC-5) ─────────────

    function test_createVault_deploysAtPredictedAddress() public {
        address predicted = factory.predictVault(user);
        vm.expectEmit(true, true, true, true, address(factory));
        emit ICzarVaultFactory.VaultCreated(user, predicted, 1, agent, autonomy, evaluatorKey);
        vm.prank(stranger);
        address v = factory.createVault(user);
        assertEq(v, predicted);
        assertEq(factory.vaultOf(user), v);
        assertTrue(factory.isVault(v));
        assertEq(CzarVault(payable(v)).owner(), user);
        assertEq(CzarVault(payable(v)).factory(), address(factory));
        assertEq(CzarVault(payable(v)).agentSigner(), agent);
    }

    function test_createVault_twice_revertsVaultExists() public {
        factory.createVault(user);
        vm.expectRevert(ICzarVaultFactory.VaultExists.selector);
        factory.createVault(user);
    }

    function test_createVault_zeroOwner_reverts() public {
        vm.expectRevert(ICzarVaultFactory.ZeroAddress.selector);
        factory.createVault(address(0));
    }

    /// @dev RV-015 named test.
    function test_createVault_anyCaller_sameAddress() public {
        uint256 snap = vm.snapshotState();
        vm.prank(stranger);
        address a = factory.createVault(user);
        vm.revertToState(snap);
        vm.prank(user);
        address b = factory.createVault(user);
        assertEq(a, b);
    }

    /// @dev RV-015 named test.
    function test_predictVault_stableAcrossDefaultsChange() public {
        address before = factory.predictVault(user);
        address a2 = makeAddr("agent2");
        address e2 = makeAddr("evaluator2");
        vm.prank(admin);
        bytes32 id = factory.queueDefaults(a2, autonomy, e2);
        vm.warp(block.timestamp + ADMIN_TIMELOCK);
        factory.applyDefaults(id, a2, autonomy, e2);
        assertEq(factory.predictVault(user), before);
        address v = factory.createVault(user);
        assertEq(v, before);
        assertEq(CzarVault(payable(v)).agentSigner(), a2);
    }

    // ───────────── Guardian pause (FAC-2) ─────────────

    function test_pause_guardianOnly() public {
        vm.prank(stranger);
        vm.expectRevert(ICzarVaultFactory.NotGuardian.selector);
        factory.pause();
        vm.expectEmit(true, true, true, true, address(factory));
        emit ICzarVaultFactory.GuardianPaused(guardianKey);
        vm.prank(guardianKey);
        factory.pause();
        assertTrue(factory.guardianPaused());
        vm.prank(guardianKey);
        factory.pause(); // idempotent (D88)
        assertTrue(factory.guardianPaused());
        vm.prank(admin);
        vm.expectRevert(ICzarVaultFactory.NotGuardian.selector);
        factory.unpause();
        vm.prank(guardianKey);
        factory.unpause();
        assertFalse(factory.guardianPaused());
    }

    // ───────────── Timelocked changes (FAC-3) ─────────────

    /// @dev RV-015 named test.
    function test_queueDefaults_appliesOnlyAfter48h() public {
        address a2 = makeAddr("agent2");
        vm.prank(admin);
        bytes32 id = factory.queueDefaults(a2, autonomy, evaluatorKey);
        vm.warp(block.timestamp + ADMIN_TIMELOCK - 1);
        vm.expectRevert(ICzarVaultFactory.TooEarly.selector);
        factory.applyDefaults(id, a2, autonomy, evaluatorKey);
        vm.warp(block.timestamp + 1);
        vm.expectEmit(true, true, true, true, address(factory));
        emit ICzarVaultFactory.DefaultsSet(a2, autonomy, evaluatorKey);
        factory.applyDefaults(id, a2, autonomy, evaluatorKey);
        assertEq(factory.defaults().agentSigner, a2);
    }

    function test_queueDefaults_notAdmin_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.queueDefaults(agent, autonomy, evaluatorKey);
    }

    function test_queueDefaults_agentEqualsEvaluator_reverts() public {
        vm.prank(admin);
        vm.expectRevert(ICzarVaultFactory.BadParams.selector);
        factory.queueDefaults(agent, autonomy, agent);
    }

    function test_applyDefaults_wrongArgs_revertsUnknownChange() public {
        vm.prank(admin);
        bytes32 id = factory.queueDefaults(makeAddr("agent2"), autonomy, evaluatorKey);
        vm.warp(block.timestamp + ADMIN_TIMELOCK);
        vm.expectRevert(ICzarVaultFactory.UnknownChange.selector);
        factory.applyDefaults(id, makeAddr("agent3"), autonomy, evaluatorKey);
    }

    function test_applyGuardian_afterTimelock_changesGuardian() public {
        address g2 = makeAddr("guardian2");
        vm.prank(admin);
        bytes32 id = factory.queueGuardian(g2);
        vm.expectRevert(ICzarVaultFactory.TooEarly.selector);
        factory.applyGuardian(id, g2);
        vm.warp(block.timestamp + ADMIN_TIMELOCK);
        vm.expectRevert(ICzarVaultFactory.UnknownChange.selector);
        factory.applyGuardian(id, makeAddr("other"));
        vm.expectEmit(true, true, true, true, address(factory));
        emit ICzarVaultFactory.GuardianChanged(guardianKey, g2);
        factory.applyGuardian(id, g2);
        assertEq(factory.guardian(), g2);
        vm.expectRevert(ICzarVaultFactory.UnknownChange.selector);
        factory.applyGuardian(id, g2); // deleted on apply
    }

    function test_applyGuardian_withDefaultsChangeId_revertsUnknownChange() public {
        vm.prank(admin);
        bytes32 id = factory.queueDefaults(makeAddr("agent2"), autonomy, evaluatorKey);
        vm.warp(block.timestamp + ADMIN_TIMELOCK);
        vm.expectRevert(ICzarVaultFactory.UnknownChange.selector);
        factory.applyGuardian(id, makeAddr("guardian2"));
    }

    function test_cancelChange_adminRemovesQueuedChange() public {
        address g2 = makeAddr("guardian2");
        vm.prank(admin);
        bytes32 id = factory.queueGuardian(g2);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.cancelChange(id);
        vm.expectEmit(true, true, true, true, address(factory));
        emit ICzarVaultFactory.ChangeCancelled(id);
        vm.prank(admin);
        factory.cancelChange(id);
        vm.warp(block.timestamp + ADMIN_TIMELOCK);
        vm.expectRevert(ICzarVaultFactory.UnknownChange.selector);
        factory.applyGuardian(id, g2);
        vm.prank(admin);
        vm.expectRevert(ICzarVaultFactory.UnknownChange.selector);
        factory.cancelChange(id);
    }

    function test_changeIds_unique() public {
        address g2 = makeAddr("guardian2");
        vm.startPrank(admin);
        bytes32 a = factory.queueGuardian(g2);
        bytes32 b = factory.queueGuardian(g2); // same payload, same block: the nonce makes it unique
        vm.stopPrank();
        assertTrue(a != b);
    }

    /// @dev FAC-4: an existing vault keeps its signers after a defaults change.
    function test_defaultsChange_doesNotTouchExistingVault() public {
        address v = factory.createVault(user);
        address a2 = makeAddr("agent2");
        vm.prank(admin);
        bytes32 id = factory.queueDefaults(a2, autonomy, evaluatorKey);
        vm.warp(block.timestamp + ADMIN_TIMELOCK);
        factory.applyDefaults(id, a2, autonomy, evaluatorKey);
        assertEq(CzarVault(payable(v)).agentSigner(), agent);
    }

    function test_ownership_twoStepTransfer() public {
        address admin2 = makeAddr("admin2");
        vm.prank(admin);
        factory.transferOwnership(admin2);
        assertEq(factory.owner(), admin);
        vm.prank(admin2);
        factory.acceptOwnership();
        assertEq(factory.owner(), admin2);
    }
}
```

## 13. Build steps (tests first)
1. Do §4.
2. Edit `foundry.toml` (§6).
3. Create the four test-setup files (§11) and `test/FactoryTest.t.sol` (§12). Run `FOUNDRY_PROFILE=arc arc-forge test --match-path test/FactoryTest.t.sol`: it fails to compile (no `CzarVault`, no factory). Paste the first error line into your report.
4. Create `VaultStorage.sol` (§7), `VaultStubs.sol` (§8) and `CzarVault.sol` (§9).
5. Write `CzarVaultFactory.sol` from §10, item by item.
6. Run `FOUNDRY_PROFILE=arc arc-forge test --match-path test/FactoryTest.t.sol`: 22 passed. If a test fails, compare the function with its numbered steps in §10.4 before anything else.
7. `arc-forge fmt src/CzarVaultFactory.sol` (your own file), then `arc-forge fmt --check` on every file in §5 except `foundry.toml`: nothing printed.
8. Run the full build with sizes and the full suite (00-conventions §2.2).

## 14. Definition of done
- `FOUNDRY_PROFILE=arc arc-forge test --match-path test/FactoryTest.t.sol` → 22 passed, 0 failed.
- `FOUNDRY_PROFILE=arc arc-forge test` → 105 passed, 0 failed (the repository's earlier tests, PRD 01 and this PRD).
- `FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes` → no compiler or lint warning; `CzarVault` runtime about 5,280 B and `CzarVaultFactory` runtime about 11,424 B (paste the lines; a difference above 200 B means the code differs from this PRD).
- `diff -r src/interfaces ../docs/specs/03-smart-contracts/interfaces` → nothing.
- `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` → 44.

## 15. Stop conditions
- A factory test fails after you have compared your code with §10 step by step: stop and report the test name and the failure line. Do not change a test.
- The build fails on a lint you cannot fix by the rules in 00-conventions §2.4: stop and report the lint id and line.

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version, verified on Arc Foundry v0.8.0-2. |
