# 10 — Earned autonomy and owner actions

## 1. Scope
- **Task:** T-019 (earned autonomy: `raiseAutoLimit`, `lowerAutoLimit`; the D30 passkey path: `executeOwnerAction` with WebAuthn and P-256).
- **You build:**
  - `contracts/src/vault/logic/AutonomyLogic.sol`: a linked library with 2 external functions (§7).
  - `contracts/src/vault/logic/OwnerActionLogic.sol`: a linked library with 1 external function that dispatches the 17 owner actions to the other libraries (§8).
  - `contracts/src/CzarVault.sol`: the final version in §6 (adds 3 wrappers; no more stubs).
  - `contracts/test/AutonomyTest.t.sol` and `contracts/test/OwnerActionTest.t.sol` (§9).
  - You **delete** `src/vault/VaultStubs.sol`.
- **Dependencies:** PRD 09 done (373 tests, `JobCircleTest` 42 and `JobCzarTest` 46 passed, 3 stubs). `OwnerActionLogic` calls `CoreLogic`, `EnvelopeLogic`, `PocketLogic`, `JobLogic` and `AutonomyLogic`, so all of them must exist.

## 2. This PRD is already verified
- References written from §7 and §8 passed on **Arc Foundry v0.8.0-2** with `FOUNDRY_PROFILE=arc`: clean `--deny-warnings` build (compiler and lint), `fmt --check` clean, 402 tests passed (373 earlier plus 17 autonomy and 12 owner-action tests).
- Under `FOUNDRY_PROFILE=arc` (`network = "arc"`) the P-256 precompile at `0x100` is live in tests, as T-019 asks ("on `arc-anvil --network arc`"). OpenZeppelin's `P256.verify` would fall back to its Solidity verifier without it, so a missing precompile shows up as gas, not as a failure.
- Sizes after this PRD (all functions built): `CzarVault` runtime 14,540 B, initcode 16,233 B; `CzarVaultFactory` runtime 20,747 B, initcode 38,225 B; `AutonomyLogic` 2,727 B; `OwnerActionLogic` 9,405 B. All under the limits (PRD 11 records them).

## 3. Sources (read these, nothing else)
- `07-contract-build/00-conventions.md` (§3.1 deleting the stubs, §3.2 library rules, §5 tests).
- `07-contract-build/01-shared-libraries.md` (`PasskeyVerifier`, `CzarHashing.autonomyRaiseStructHash`, `ownerActionStructHash`).
- `docs/specs/03-smart-contracts/czar-vault.md`: §5.6 (autonomy), §7 (the passkey path and the payload table), §15.1, §15.2, §15.4 (`Frozen.by`, `AutoLimitLowered.by`), §15.9 (`executeOwnerAction` order), §15.10 (raise check order and signature).
- `docs/specs/02-data-and-protocol/data-and-protocol.md` §6.2 (`AutonomyRaise`, `OwnerAction`).
- `docs/specs/03-smart-contracts/interfaces/ICzarVault.sol` (`OwnerActionKind`, `WebAuthnAuth`, `CategoryLimits`, events, errors).
- `docs/specs/03-smart-contracts/security-and-testing.md` §3.7 and §3.7a rows RV-008, RV-030, RV-031, RV-033, RV-034, H2.

## 4. Files
| File | Action | Section |
|---|---|---|
| `contracts/test/AutonomyTest.t.sol` | create | §9 |
| `contracts/test/OwnerActionTest.t.sol` | create | §9 |
| `contracts/src/vault/logic/AutonomyLogic.sol` | create | §7 |
| `contracts/src/vault/logic/OwnerActionLogic.sol` | create | §8 |
| `contracts/src/vault/VaultStubs.sol` | **delete the file** | §5 |
| `contracts/src/CzarVault.sol` | replace | §6 |

## 5. Delete the stubs file
- `git rm src/vault/VaultStubs.sol` (the last three stubs, `executeOwnerAction`, `lowerAutoLimit` and `raiseAutoLimit`, are built here).
- Afterwards `grep -rn NotBuilt src/` prints nothing (00-conventions §3.1).

## 6. `src/CzarVault.sol` (replace the whole file: the final version)
- `contract CzarVault is VaultBase` (no `VaultStubs`); every interface function now has a body.
- `raiseAutoLimit` and `lowerAutoLimit` are not guarded (no external call other than the factory's `guardianPaused()` view, §15.5); `executeOwnerAction` is `nonReentrant` and calls the library functions directly, so it never re-enters a guarded wrapper.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICzarVault} from "./interfaces/ICzarVault.sol";
import {VaultBase} from "./vault/VaultBase.sol";
import {CoreLogic} from "./vault/logic/CoreLogic.sol";
import {EnvelopeLogic} from "./vault/logic/EnvelopeLogic.sol";
import {ReservationLogic} from "./vault/logic/ReservationLogic.sol";
import {SignatureLogic} from "./vault/logic/SignatureLogic.sol";
import {PocketLogic} from "./vault/logic/PocketLogic.sol";
import {JobLogic} from "./vault/logic/JobLogic.sol";
import {AutonomyLogic} from "./vault/logic/AutonomyLogic.sol";
import {OwnerActionLogic} from "./vault/logic/OwnerActionLogic.sol";

/// @title CzarVault
/// @notice The per-user vault (czar-vault.md). Immutable; no proxy (D33). Every state-changing function is a thin
///         wrapper: the reentrancy guard (§15.5) stays here, the logic runs in a linked library by DELEGATECALL on
///         this vault's storage (07 PRD 03). `msg.sender` is passed as `caller`, so the passkey path can pass the owner.
contract CzarVault is VaultBase {
    /// @dev czar-vault.md §15.8. Called by CzarVaultFactory.createVault through CREATE2.
    constructor(address ownerAccount) VaultBase(ownerAccount) {}

    // ───────────── Balance and owner settings (§5.1) ─────────────

    /// @dev Native USDC arrives as free balance (A1-05). Not in ICzarVault.
    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }

    /// @inheritdoc ICzarVault
    function sync() external nonReentrant {
        emit BalanceSynced(IERC20(USDC).balanceOf(address(this)), _s.committedTotal);
    }

    /// @inheritdoc ICzarVault
    function withdraw(address to, uint256 amount) external nonReentrant {
        CoreLogic.withdraw(_s, _config(), msg.sender, to, amount);
    }

    /// @inheritdoc ICzarVault
    function setCategoryLimits(bytes32 categoryId, uint256 userMax, uint256 autoLimit) external {
        CoreLogic.setCategoryLimits(_s, _config(), msg.sender, categoryId, userMax, autoLimit);
    }

    /// @inheritdoc ICzarVault
    function freeze() external {
        CoreLogic.freeze(_s, _config(), msg.sender);
    }

    /// @inheritdoc ICzarVault
    function unfreeze() external {
        CoreLogic.unfreeze(_s, _config(), msg.sender);
    }

    /// @inheritdoc ICzarVault
    function rotateSigners(address agent, address autonomy, address evaluator_) external {
        CoreLogic.rotateSigners(_s, _config(), msg.sender, agent, autonomy, evaluator_);
    }

    /// @inheritdoc ICzarVault
    function setPasskey(bytes32 qx, bytes32 qy, bytes32 rpIdHash) external {
        CoreLogic.setPasskey(_s, _config(), msg.sender, qx, qy, rpIdHash);
    }

    /// @inheritdoc ICzarVault
    function setMaxPullbackFee(uint256 newMax) external {
        CoreLogic.setMaxPullbackFee(_s, _config(), msg.sender, newMax);
    }

    /// @inheritdoc ICzarVault
    function executeOwnerAction(uint8 action, bytes calldata payload, uint256 deadline, WebAuthnAuth calldata auth)
        external
        nonReentrant
    {
        OwnerActionLogic.executeOwnerAction(_s, _config(), action, payload, deadline, auth);
    }

    // ───────────── Envelopes (§5.2) ─────────────

    /// @inheritdoc ICzarVault
    function openEnvelope(OpenEnvelopeParams calldata p) external nonReentrant returns (uint64) {
        return EnvelopeLogic.openEnvelope(_s, _config(), msg.sender, p);
    }

    /// @inheritdoc ICzarVault
    function closeEnvelope(uint64 envelopeId) external {
        EnvelopeLogic.closeEnvelope(_s, _config(), msg.sender, envelopeId);
    }

    /// @inheritdoc ICzarVault
    function forceCloseEnvelope(uint64 envelopeId) external {
        EnvelopeLogic.forceCloseEnvelope(_s, _config(), msg.sender, envelopeId);
    }

    // ───────────── Reservations (§5.3) ─────────────

    /// @inheritdoc ICzarVault
    function reserve(
        uint64 envelopeId,
        uint32 stepIndex,
        address payee,
        uint256 stepCap,
        bytes32[] calldata proof,
        uint256 unitAmount,
        uint32 count,
        uint64 validBefore
    ) external returns (uint64) {
        ReservationLogic.ReserveRequest memory q = ReservationLogic.ReserveRequest(
            envelopeId, stepIndex, payee, stepCap, unitAmount, count, validBefore, ReservationMode.Envelope
        );
        return ReservationLogic.reserve(_s, _config(), msg.sender, q, proof);
    }

    /// @inheritdoc ICzarVault
    function reserveWithDigests(
        uint64 envelopeId,
        uint32 stepIndex,
        address payee,
        uint256 stepCap,
        bytes32[] calldata proof,
        uint256 unitAmount,
        uint32 count,
        uint64 validBefore
    ) external returns (uint64) {
        ReservationLogic.ReserveRequest memory q = ReservationLogic.ReserveRequest(
            envelopeId, stepIndex, payee, stepCap, unitAmount, count, validBefore, ReservationMode.Digest
        );
        return ReservationLogic.reserve(_s, _config(), msg.sender, q, proof);
    }

    /// @inheritdoc ICzarVault
    function settle(uint64 reservationId, uint32[] calldata indices) external nonReentrant {
        ReservationLogic.settle(_s, _config(), reservationId, indices);
    }

    /// @inheritdoc ICzarVault
    function finalize(uint64 reservationId, uint32 fromIndex, uint32 toIndex) external nonReentrant {
        ReservationLogic.finalize(_s, _config(), reservationId, fromIndex, toIndex);
    }

    // ───────────── ERC-1271 (§6) ─────────────

    /// @inheritdoc ICzarVault
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        return SignatureLogic.isValidSignature(_s, _config(), digest, signature);
    }

    // ───────────── Pockets (§5.4) ─────────────

    /// @inheritdoc ICzarVault
    function registerPocket(uint64 envelopeId, address pocket, bytes32[] calldata proof) external {
        PocketLogic.registerPocket(_s, _config(), msg.sender, envelopeId, pocket, proof);
    }

    /// @inheritdoc ICzarVault
    function grantPocketGas(address pocket, uint256 units) external nonReentrant {
        PocketLogic.grantPocketGas(_s, _config(), msg.sender, pocket, units);
    }

    /// @inheritdoc ICzarVault
    function fundPocket(address pocket, uint256 amount) external nonReentrant {
        PocketLogic.fundPocket(_s, _config(), msg.sender, pocket, amount);
    }

    /// @inheritdoc ICzarVault
    function requestPullback(address pocket, uint256 value, uint256 maxFee, uint256 maxBlockHeight)
        external
        returns (uint64)
    {
        return PocketLogic.requestPullback(_s, _config(), msg.sender, pocket, value, maxFee, maxBlockHeight);
    }

    /// @inheritdoc ICzarVault
    function confirmPullback(uint64 pullbackId) external nonReentrant {
        PocketLogic.confirmPullback(_s, _config(), pullbackId);
    }

    /// @inheritdoc ICzarVault
    function cancelPullback(uint64 pullbackId) external nonReentrant {
        PocketLogic.cancelPullback(_s, _config(), msg.sender, pullbackId);
    }

    /// @inheritdoc ICzarVault
    function writeOffPocket(address pocket) external {
        PocketLogic.writeOffPocket(_s, _config(), msg.sender, pocket);
    }

    /// @inheritdoc ICzarVault
    function recordManualReturn(address pocket, uint256 amount) external nonReentrant {
        PocketLogic.recordManualReturn(_s, _config(), msg.sender, pocket, amount);
    }

    // ───────────── Jobs (§5.5) ─────────────

    /// @inheritdoc ICzarVault
    function openJob(
        uint64 envelopeId,
        uint32 stepIndex,
        address provider,
        uint256 stepCap,
        bytes32[] calldata proof,
        uint64 expiredAt,
        bytes32 descriptionHash
    ) external nonReentrant returns (bytes32) {
        JobLogic.OpenJobRequest memory q = JobLogic.OpenJobRequest(
            envelopeId, stepIndex, provider, stepCap, expiredAt, descriptionHash
        );
        return JobLogic.openJob(_s, _config(), msg.sender, q, proof);
    }

    /// @inheritdoc ICzarVault
    function fundJob(bytes32 jobKey, uint256 expectedBudget) external nonReentrant {
        JobLogic.fundJob(_s, _config(), msg.sender, jobKey, expectedBudget);
    }

    /// @inheritdoc ICzarVault
    function cancelJob(bytes32 jobKey) external nonReentrant {
        JobLogic.cancelJob(_s, _config(), msg.sender, jobKey);
    }

    /// @inheritdoc ICzarVault
    function syncJob(bytes32 jobKey) external nonReentrant {
        JobLogic.syncJob(_s, _config(), jobKey);
    }

    /// @inheritdoc ICzarVault
    function claimJobRefund(bytes32 jobKey) external nonReentrant {
        JobLogic.claimJobRefund(_s, _config(), jobKey);
    }

    // ───────────── Earned autonomy (§5.6) ─────────────

    /// @inheritdoc ICzarVault
    function raiseAutoLimit(bytes32 categoryId, uint256 newLimit, uint64 periodId, uint256 deadline, bytes calldata sig)
        external
    {
        AutonomyLogic.raiseAutoLimit(_s, _config(), msg.sender, categoryId, newLimit, periodId, deadline, sig);
    }

    /// @inheritdoc ICzarVault
    function lowerAutoLimit(bytes32 categoryId, uint256 newLimit) external {
        AutonomyLogic.lowerAutoLimit(_s, _config(), msg.sender, categoryId, newLimit);
    }
}
```

## 7. `src/vault/logic/AutonomyLogic.sol`
- Shorthand in the steps: "→ `X`" means `revert ICzarVault.X();` (or with the arguments shown). Wherever a step uses `e`, `k` or `p` before the function declared it, declare it at first use: `ICzarVault.Envelope storage e = s.envelopes[<envelopeId>];`, `ICzarVault.Pocket storage k = s.pockets[pocket];`, `ICzarVault.Pullback storage p = s.pullbacks[pullbackId];`.

### 7.1 Header
- `// SPDX-License-Identifier: MIT`, `pragma solidity 0.8.30;`
- Imports, exactly:
  - `{ECDSA}` from `@openzeppelin/contracts/utils/cryptography/ECDSA.sol`
  - `{SafeCast}` from `@openzeppelin/contracts/utils/math/SafeCast.sol`
  - `{ICzarVault}` from `../../interfaces/ICzarVault.sol`
  - `{VaultState, VaultConfig}` from `../VaultState.sol`
  - `{VaultGuards}` from `../VaultGuards.sol`
  - `{CzarHashing}` from `../../libraries/CzarHashing.sol`
  - `{PERIOD_LENGTH, MAX_RAISE_STEP_BPS, BPS}` from `../../libraries/CzarConstants.sol`
- `/// @title AutonomyLogic`, a `/// @notice` citing `czar-vault.md` §5.6, §15.10 and T-019. `library AutonomyLogic { … }`.

### 7.2 `raiseAutoLimit(VaultState storage s, VaultConfig memory c, address caller, bytes32 categoryId, uint256 newLimit, uint64 periodId, uint256 deadline, bytes memory sig) external`
- `sig` is `bytes memory` (not `calldata`), so the owner-action path can pass `""`.
- Exactly the §15.10 order:
  1. `VaultGuards.requireNotPausedOrFrozen(s, c);` (`FrozenVault`, `Paused`; RV-030)
  2. `block.timestamp > deadline` → `ICzarVault.Expired()`
  3. `periodId != block.timestamp / PERIOD_LENGTH` → `BadParams`
  4. Signer:
     - if `sig.length == 0`: `caller != c.owner` → `ICzarVault.BadSigner()` (AM-20: only the owner may send an empty signature)
     - else: `bytes32 digest = CzarHashing.typedDataHash(c.vaultDomainSeparator, CzarHashing.autonomyRaiseStructHash(categoryId, newLimit, periodId, s.autonomyNonce, deadline));` `(address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);` `err != NoError || signer != s.autonomySigner` → `BadSigner` (`tryRecover` gives the `_agentSigned` rules: 65 bytes, low s, `v` 27 or 28, non-zero signer)
  5. `ICzarVault.CategoryLimits storage l = s.limits[categoryId];` `l.lastRaiseAt != 0 && block.timestamp < l.lastRaiseAt + PERIOD_LENGTH` → `ICzarVault.RaiseAlreadyThisPeriod()` (RV-031)
  6. `uint256 oldLimit = l.autoLimit;` `newLimit <= oldLimit` → `ICzarVault.RaiseNotAbove()` (RV-008)
  7. `newLimit > l.userMax` → `ICzarVault.AutoLimitAboveUserMax()`
  8. `newLimit - oldLimit > l.userMax * MAX_RAISE_STEP_BPS / BPS` → `ICzarVault.RaiseTooLarge()`
  9. `l.autoLimit = newLimit; l.lastRaiseAt = SafeCast.toUint64(block.timestamp); s.autonomyNonce++;`
  10. `emit ICzarVault.AutoLimitRaised(categoryId, oldLimit, newLimit, periodId);`

### 7.3 `lowerAutoLimit(VaultState storage s, VaultConfig memory c, address caller, bytes32 categoryId, uint256 newLimit) external`
(§5.6; not gated by freeze or pause, because D60 lowers limits after a freeze)
1. `caller != c.owner && caller != s.agentSigner && caller != s.autonomySigner` → `NotAuthorized`
2. `ICzarVault.CategoryLimits storage l = s.limits[categoryId]; uint256 oldLimit = l.autoLimit;` `newLimit > oldLimit` → `BadParams` (equal is allowed, RV-008)
3. `l.autoLimit = newLimit; s.autonomyNonce++;` (always bumps, RV-030)
4. `emit ICzarVault.AutoLimitLowered(categoryId, oldLimit, newLimit, caller);`

## 8. `src/vault/logic/OwnerActionLogic.sol`

### 8.1 Header
- `// SPDX-License-Identifier: MIT`, `pragma solidity 0.8.30;`
- Imports, exactly:
  - `{SafeCast}` from `@openzeppelin/contracts/utils/math/SafeCast.sol`
  - `{ICzarVault}` from `../../interfaces/ICzarVault.sol`
  - `{VaultState, VaultConfig}` from `../VaultState.sol`
  - `{CzarHashing}` from `../../libraries/CzarHashing.sol`
  - `{PasskeyVerifier}` from `../../libraries/PasskeyVerifier.sol`
  - `{PERIOD_LENGTH}` from `../../libraries/CzarConstants.sol`
  - `{CoreLogic}` from `./CoreLogic.sol`, `{EnvelopeLogic}` from `./EnvelopeLogic.sol`, `{PocketLogic}` from `./PocketLogic.sol`, `{JobLogic}` from `./JobLogic.sol`, `{AutonomyLogic}` from `./AutonomyLogic.sol`
- `/// @title OwnerActionLogic`, a `/// @notice` citing `czar-vault.md` §7, §15.9, 02 §6.2 and T-019, and saying each action calls the same library function as the direct path, with `caller = owner`. `library OwnerActionLogic { … }`.
- First in the library: `uint8 internal constant MAX_OWNER_ACTION = uint8(ICzarVault.OwnerActionKind.CancelJob);` with a `/// @dev` line (17, H2).

### 8.2 `executeOwnerAction(VaultState storage s, VaultConfig memory c, uint8 action, bytes calldata payload, uint256 deadline, ICzarVault.WebAuthnAuth calldata auth) external`
Exactly the §15.9 order:
1. `ICzarVault.Passkey memory k = s.passkey;` `!k.set` → `ICzarVault.PasskeyNotSet()`
2. `block.timestamp > deadline` → `Expired`
3. `action == 0 || action > MAX_OWNER_ACTION` → `ICzarVault.UnknownAction()`
4. `uint256 nonce = s.ownerActionNonce;`
5. `bytes32 digest = CzarHashing.typedDataHash(c.vaultDomainSeparator, CzarHashing.ownerActionStructHash(action, keccak256(payload), nonce, deadline));`
6. `!PasskeyVerifier.verify(digest, auth, k.qx, k.qy, k.rpIdHash)` → `ICzarVault.InvalidPasskeyAssertion()` (the RP ID hash, UV flag, challenge and low-s P-256 checks are inside `PasskeyVerifier`, PRD 01)
7. `s.ownerActionNonce = nonce + 1;`
8. `_dispatch(s, c, ICzarVault.OwnerActionKind(action), payload, deadline);`
9. `emit ICzarVault.OwnerActionExecuted(action, nonce);` (the nonce that was signed, before the increment)

### 8.3 `_dispatch(VaultState storage s, VaultConfig memory c, ICzarVault.OwnerActionKind a, bytes calldata payload, uint256 deadline) private`
- `address o = c.owner;` then one `if / else if` chain, in this order. Each branch decodes the payload of the `czar-vault.md` §7 table and calls the library function with `caller = o`. A payload that does not decode reverts with the raw `abi.decode` error (§15.2).

| # | Kind | Decode | Call |
|---|---|---|---|
| 1 | `OpenEnvelope` | `abi.decode(payload, (ICzarVault.OpenEnvelopeParams))` | `EnvelopeLogic.openEnvelope(s, c, o, p)` (the owner path sets `approverIsOwner`) |
| 2 | `SetLimits` | `(bytes32, uint256, uint256)` | `CoreLogic.setCategoryLimits(s, c, o, categoryId, userMax, autoLimit)` |
| 3 | `Freeze` | none | `CoreLogic.freeze(s, c, o)` |
| 4 | `Unfreeze` | none | `CoreLogic.unfreeze(s, c, o)` |
| 5 | `Withdraw` | `(address, uint256)` | `CoreLogic.withdraw(s, c, o, to, amount)` |
| 6 | `RotateSigners` | `(address, address, address)` | `CoreLogic.rotateSigners(s, c, o, agent, autonomy, evaluator)` |
| 7 | `SetPasskey` | `(bytes32, bytes32, bytes32)` | `CoreLogic.setPasskey(s, c, o, qx, qy, rpIdHash)` |
| 8 | `CloseEnvelope` | `(uint64)` | `EnvelopeLogic.closeEnvelope(s, c, o, envelopeId)` |
| 9 | `ForceCloseEnvelope` | `(uint64)` | `EnvelopeLogic.forceCloseEnvelope(s, c, o, envelopeId)` |
| 10 | `RecordManualReturn` | `(address, uint256)` | `PocketLogic.recordManualReturn(s, c, o, pocket, amount)` |
| 11 | `RaiseAutoLimit` | `(bytes32, uint256)` | `uint64 periodId = SafeCast.toUint64(block.timestamp / PERIOD_LENGTH);` then `AutonomyLogic.raiseAutoLimit(s, c, o, categoryId, newLimit, periodId, deadline, "")` (§15.9: current period, the `OwnerAction` deadline, empty signature) |
| 12 | `LowerAutoLimit` | `(bytes32, uint256)` | `AutonomyLogic.lowerAutoLimit(s, c, o, categoryId, newLimit)` |
| 13 | `RequestPullback` | `(address, uint256, uint256, uint256)` | `PocketLogic.requestPullback(s, c, o, pocket, value, maxFee, maxBlockHeight)` |
| 14 | `CancelPullback` | `(uint64)` | `PocketLogic.cancelPullback(s, c, o, pullbackId)` |
| 15 | `WriteOffPocket` | `(address)` | `PocketLogic.writeOffPocket(s, c, o, pocket)` |
| 16 | `SetMaxPullbackFee` | `(uint256)` | `CoreLogic.setMaxPullbackFee(s, c, o, newMax)` |
| 17 | `CancelJob` | `(bytes32)` | `JobLogic.cancelJob(s, c, o, jobKey)`, as the final `else` (the only value left after step 3's range check) |

- These calls are library-to-library calls: the compiler links `OwnerActionLogic` to the five libraries, and each call runs on the vault's storage like a direct call does.

## 9. Tests

### 9.1 `test/AutonomyTest.t.sol`
- 17 tests: a raise signed by the autonomy key and relayed by anyone; the empty signature (owner only, AM-20); frozen and paused; deadline and period checks; a wrong or short signature; the nonce rules (a raise signed before a freeze, a lowering or `setCategoryLimits` can never land, RV-030); the period spacing and the boundary case (RV-031); `RaiseNotAbove` and the bounds in order (RV-008); a raise widening the agent's allowance; lowering by the three callers, refused callers and values, lowering after a freeze (D60), and 0 → 0 (RV-008).
- The test computes the vault's EIP-712 domain separator from the strings `"CzarVault"`, `"1"`, the chain id and the vault address, so a wrong domain in the vault fails these tests.
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {CzarHashing} from "../src/libraries/CzarHashing.sol";
import {PERIOD_LENGTH} from "../src/libraries/CzarConstants.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";

/// @dev 07 PRD 10 part A (T-019). czar-vault.md §5.6, §15.10; 02 §6.2 AutonomyRaise; RV-008, RV-030, RV-031, AM-20.
contract AutonomyTest is VaultTestBase {
    bytes32 internal constant CATEGORY = keccak256("category");
    uint256 internal constant USER_MAX = 10 * ONE_USDC; // a raise may move at most 20% of this: 2 USDC
    uint256 internal constant START_LIMIT = ONE_USDC;

    uint256 internal autonomyPk = uint256(keccak256(abi.encodePacked("autonomy")));
    uint256 internal agentPk = uint256(keccak256(abi.encodePacked("agent")));

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        vault.setCategoryLimits(CATEGORY, USER_MAX, START_LIMIT);
    }

    function _period() internal view returns (uint64) {
        return uint64(block.timestamp / PERIOD_LENGTH);
    }

    function _raiseSig(uint256 pk, uint256 newLimit, uint64 periodId, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = CzarHashing.typedDataHash(
            _vaultDomainSeparator(), CzarHashing.autonomyRaiseStructHash(CATEGORY, newLimit, periodId, nonce, deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev EIP712Domain(name "CzarVault", version "1", chainId, verifyingContract = the vault) (02 §6.2).
    function _vaultDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("CzarVault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
    }

    // ───────────── raiseAutoLimit ─────────────

    function test_raise_signedByAutonomy_relayedByAnyone() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = vault.autonomyNonce();
        bytes memory sig = _raiseSig(autonomyPk, 3 * ONE_USDC, _period(), nonce, deadline);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.AutoLimitRaised(CATEGORY, START_LIMIT, 3 * ONE_USDC, _period());
        vm.prank(stranger);
        vault.raiseAutoLimit(CATEGORY, 3 * ONE_USDC, _period(), deadline, sig);
        ICzarVault.CategoryLimits memory l = vault.getLimits(CATEGORY);
        assertEq(l.autoLimit, 3 * ONE_USDC);
        assertEq(l.lastRaiseAt, block.timestamp);
        assertEq(vault.autonomyNonce(), nonce + 1);
    }

    /// @dev AM-20: only the owner may call with an empty signature.
    function test_raise_emptySig_ownerOnly() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint64 period = _period();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadSigner.selector);
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, period, deadline, "");
        vm.prank(stranger);
        vm.expectRevert(ICzarVault.BadSigner.selector);
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, period, deadline, "");
        vm.prank(owner);
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, period, deadline, "");
        assertEq(vault.getLimits(CATEGORY).autoLimit, 2 * ONE_USDC);
    }

    /// @dev RV-030 named test.
    function test_raiseAutoLimit_whileFrozen_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint64 period = _period();
        vm.prank(owner);
        vault.freeze();
        vm.prank(owner);
        vm.expectRevert(ICzarVault.FrozenVault.selector);
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, period, deadline, "");
    }

    function test_raise_paused_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint64 period = _period();
        vaultFactory.setGuardianPaused(true);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.Paused.selector);
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, period, deadline, "");
    }

    function test_raise_deadlineAndPeriod_revert() public {
        uint64 period = _period();
        uint256 past = block.timestamp - 1;
        uint256 deadline = block.timestamp + 1 hours;
        vm.startPrank(owner);
        vm.expectRevert(ICzarVault.Expired.selector);
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, period, past, "");
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, period + 1, deadline, "");
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, period, block.timestamp, ""); // deadline == now is allowed
        vm.stopPrank();
    }

    function test_raise_wrongSigner_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint64 period = _period();
        bytes memory sig = _raiseSig(agentPk, 2 * ONE_USDC, period, vault.autonomyNonce(), deadline);
        vm.expectRevert(ICzarVault.BadSigner.selector);
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, period, deadline, sig);
        bytes memory shortSig = new bytes(64);
        vm.expectRevert(ICzarVault.BadSigner.selector);
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, period, deadline, shortSig);
    }

    /// @dev RV-030 named test: freeze bumps autonomyNonce, so a raise signed before it fails BadSigner.
    function test_raiseSignedBeforeFreeze_cannotLand() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint64 period = _period();
        bytes memory sig = _raiseSig(autonomyPk, 2 * ONE_USDC, period, vault.autonomyNonce(), deadline);
        vm.prank(agent);
        vault.freeze();
        vm.prank(owner);
        vault.unfreeze();
        vm.expectRevert(ICzarVault.BadSigner.selector);
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, period, deadline, sig);
    }

    /// @dev §15.10: lowerAutoLimit and setCategoryLimits bump the nonce too, so an older raise never lands.
    function test_raise_signedBeforeLowerOrSetLimits_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint64 period = _period();
        bytes memory sig = _raiseSig(autonomyPk, 2 * ONE_USDC, period, vault.autonomyNonce(), deadline);
        vm.prank(agent);
        vault.lowerAutoLimit(CATEGORY, START_LIMIT); // equal: changes only the nonce
        vm.expectRevert(ICzarVault.BadSigner.selector);
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, period, deadline, sig);
        sig = _raiseSig(autonomyPk, 2 * ONE_USDC, period, vault.autonomyNonce(), deadline);
        vm.prank(owner);
        vault.setCategoryLimits(CATEGORY, USER_MAX, START_LIMIT);
        vm.expectRevert(ICzarVault.BadSigner.selector);
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, period, deadline, sig);
    }

    /// @dev RV-031: raises are spaced at least PERIOD_LENGTH apart.
    function test_raise_oncePerPeriodLength() public {
        vm.startPrank(owner);
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, _period(), block.timestamp, "");
        vm.warp(block.timestamp + PERIOD_LENGTH - 1);
        uint64 period = _period();
        vm.expectRevert(ICzarVault.RaiseAlreadyThisPeriod.selector);
        vault.raiseAutoLimit(CATEGORY, 3 * ONE_USDC, period, block.timestamp, "");
        vm.warp(block.timestamp + 1);
        vault.raiseAutoLimit(CATEGORY, 3 * ONE_USDC, _period(), block.timestamp, "");
        vm.stopPrank();
        assertEq(vault.getLimits(CATEGORY).autoLimit, 3 * ONE_USDC);
    }

    /// @dev RV-031 named test: a raise just before a period boundary blocks one just after it.
    function test_twoRaisesAcrossPeriodBoundary_secondReverts() public {
        uint256 boundary = (block.timestamp / PERIOD_LENGTH + 1) * PERIOD_LENGTH;
        vm.warp(boundary - 1);
        vm.prank(owner);
        vault.raiseAutoLimit(CATEGORY, 2 * ONE_USDC, _period(), block.timestamp, "");
        vm.warp(boundary + 1);
        uint64 period = _period();
        vm.prank(owner);
        vm.expectRevert(ICzarVault.RaiseAlreadyThisPeriod.selector);
        vault.raiseAutoLimit(CATEGORY, 3 * ONE_USDC, period, block.timestamp, "");
    }

    /// @dev RV-008 named test.
    function test_raiseAutoLimit_notAbove_reverts() public {
        uint64 period = _period();
        uint256 deadline = block.timestamp;
        vm.prank(owner);
        vm.expectRevert(ICzarVault.RaiseNotAbove.selector);
        vault.raiseAutoLimit(CATEGORY, START_LIMIT, period, deadline, "");
        vm.prank(owner);
        vm.expectRevert(ICzarVault.RaiseNotAbove.selector);
        vault.raiseAutoLimit(CATEGORY, START_LIMIT - 1, period, deadline, "");
    }

    /// @dev The §15.10 bounds after RaiseNotAbove, in check order.
    function test_raise_bounds_revert() public {
        uint64 period = _period();
        uint256 deadline = block.timestamp;
        vm.startPrank(owner);
        vm.expectRevert(ICzarVault.AutoLimitAboveUserMax.selector);
        vault.raiseAutoLimit(CATEGORY, USER_MAX + 1, period, deadline, "");
        vm.expectRevert(ICzarVault.RaiseTooLarge.selector);
        vault.raiseAutoLimit(CATEGORY, 3 * ONE_USDC + 1, period, deadline, "");
        vault.raiseAutoLimit(CATEGORY, 3 * ONE_USDC, period, deadline, ""); // exactly 20% of userMax
        vm.stopPrank();
    }

    /// @dev The raised allowance is what the agent may open by itself this period (§5.6).
    function test_raise_widensAgentAllowance() public {
        _fundVault(10 * ONE_USDC);
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = 2 * ONE_USDC;
        p.maxStepAmount = ONE_USDC;
        p.expiresAt = uint64(block.timestamp + 1 days);
        p.categoryId = CATEGORY;
        p.payeeRoot = keccak256("root");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.AllowanceExceeded.selector, CATEGORY, START_LIMIT, p.cap));
        vault.openEnvelope(p);
        vm.prank(owner);
        vault.raiseAutoLimit(CATEGORY, 3 * ONE_USDC, _period(), block.timestamp, "");
        vm.prank(agent);
        vault.openEnvelope(p);
    }

    // ───────────── lowerAutoLimit ─────────────

    function test_lower_byOwnerAgentOrAutonomy() public {
        address[3] memory callers = [owner, agent, autonomy];
        for (uint256 i = 0; i < 3; i++) {
            uint256 nonce = vault.autonomyNonce();
            uint256 old = vault.getLimits(CATEGORY).autoLimit;
            uint256 next = old / 2;
            vm.expectEmit(true, true, true, true, address(vault));
            emit ICzarVault.AutoLimitLowered(CATEGORY, old, next, callers[i]);
            vm.prank(callers[i]);
            vault.lowerAutoLimit(CATEGORY, next);
            assertEq(vault.getLimits(CATEGORY).autoLimit, next);
            assertEq(vault.autonomyNonce(), nonce + 1);
        }
    }

    function test_lower_strangerOrAbove_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(ICzarVault.NotAuthorized.selector);
        vault.lowerAutoLimit(CATEGORY, 0);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.lowerAutoLimit(CATEGORY, START_LIMIT + 1);
    }

    /// @dev D60: after a freeze the agent lowers every used category to 0; freeze and pause do not block it.
    function test_lower_afterFreeze_toZero() public {
        vm.prank(owner);
        vault.freeze();
        vaultFactory.setGuardianPaused(true);
        vm.prank(agent);
        vault.lowerAutoLimit(CATEGORY, 0);
        assertEq(vault.getLimits(CATEGORY).autoLimit, 0);
        vm.prank(agent);
        vault.lowerAutoLimit(CATEGORY, 0); // equal is allowed (RV-008)
    }

    /// @dev RV-008 named test: lowering 0 → 0 succeeds and only bumps the nonce.
    function test_lowerAutoLimit_equalIsNoop() public {
        vm.prank(owner);
        vault.setCategoryLimits(CATEGORY, USER_MAX, 0);
        uint256 nonce = vault.autonomyNonce();
        vm.prank(agent);
        vault.lowerAutoLimit(CATEGORY, 0);
        assertEq(vault.getLimits(CATEGORY).autoLimit, 0);
        assertEq(vault.autonomyNonce(), nonce + 1);
    }
}
```

### 9.2 `test/OwnerActionTest.t.sol`
- 12 tests: `FREEZE` through the passkey (`Frozen.by` is the owner); `PasskeyNotSet`; `Expired` and `UnknownAction` (0 and 18); a replayed assertion; an assertion over another payload, action or deadline; a wrong RP ID hash; no user verification; high-s refused and the normalised signature accepted (RV-034); a payload that does not decode; `OPEN_ENVELOPE` sets `approverIsOwner`; all 17 kinds dispatched in one scenario (RV-033); `CANCEL_JOB` (H2).
- The WebAuthn assertions are built in the test the way a browser builds them: `authenticatorData = rpIdHash ‖ flags ‖ signCount`, `clientDataJSON` with the base64url challenge at index 23, signed with forge's `vm.signP256` over `sha256(authenticatorData ‖ sha256(clientDataJSON))`. `RP_ID_HASH` is `sha256("localhost")` (D78).
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {CzarHashing} from "../src/libraries/CzarHashing.sol";
import {USDC_ADDRESS, PULLBACK_CANCEL_DELAY_BLOCKS, FORCE_CLOSE_DELAY} from "../src/libraries/CzarConstants.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {PayeeTree} from "./helpers/PayeeTree.sol";

/// @dev 07 PRD 10 part B (T-019). czar-vault.md §7, §15.9; 02 §6.2 OwnerAction; RV-033, RV-034, H2.
contract OwnerActionTest is VaultTestBase, PayeeTree {
    uint256 internal constant PASSKEY_PK = 0xA11CE; // test-only P-256 private key
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    bytes32 internal constant RP_ID_HASH = 0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763; // sha256("localhost")
    bytes1 internal constant FLAGS_UP_UV = 0x05;
    bytes32 internal constant CATEGORY = keccak256("category");
    uint256 internal constant FEE = 3_500;

    bytes32 internal qx;
    bytes32 internal qy;

    function setUp() public override {
        super.setUp();
        _fundVault(10 * ONE_USDC);
        (uint256 x, uint256 y) = vm.publicKeyP256(PASSKEY_PK);
        (qx, qy) = (bytes32(x), bytes32(y));
        vm.prank(owner);
        vault.setPasskey(qx, qy, RP_ID_HASH);
    }

    // ───────────── Helpers ─────────────

    function _digest(uint8 action, bytes memory payload, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("CzarVault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        return CzarHashing.typedDataHash(
            domain, CzarHashing.ownerActionStructHash(action, keccak256(payload), nonce, deadline)
        );
    }

    /// @dev A browser-shaped WebAuthn assertion over `digest` (czar-vault.md §7), low-s unless `highS`.
    function _assertion(bytes32 digest, bytes32 rpIdHash, bool highS)
        internal
        pure
        returns (ICzarVault.WebAuthnAuth memory a)
    {
        bytes memory authenticatorData = abi.encodePacked(rpIdHash, FLAGS_UP_UV, uint32(0));
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"http://localhost"}'
        );
        bytes32 messageHash = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(PASSKEY_PK, messageHash);
        bool isHigh = uint256(s) > P256_N / 2;
        if (isHigh != highS) s = bytes32(P256_N - uint256(s));
        a.challengeIndex = 23;
        a.typeIndex = 1;
        a.r = r;
        a.s = s;
        a.authenticatorData = authenticatorData;
        a.clientDataJSON = clientDataJSON;
    }

    /// @dev Signs the current nonce and relays through a stranger, as Czar's relayer would.
    function _exec(ICzarVault.OwnerActionKind kind, bytes memory payload) internal {
        uint8 action = uint8(kind);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = vault.ownerActionNonce();
        ICzarVault.WebAuthnAuth memory a = _assertion(_digest(action, payload, nonce, deadline), RP_ID_HASH, false);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.OwnerActionExecuted(action, nonce);
        vm.prank(stranger);
        vault.executeOwnerAction(action, payload, deadline, a);
        assertEq(vault.ownerActionNonce(), nonce + 1);
    }

    // ───────────── Checks (§15.9 order) ─────────────

    function test_ownerAction_freeze_viaPasskey() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Frozen(owner); // Frozen.by is the owner on the passkey path (§15.4)
        _exec(ICzarVault.OwnerActionKind.Freeze, "");
        assertTrue(vault.frozen());
    }

    function test_ownerAction_passkeyNotSet_reverts() public {
        vault = vaultFactory.deploy(makeAddr("owner2"));
        ICzarVault.WebAuthnAuth memory a;
        uint256 deadline = block.timestamp + 1 hours;
        vm.expectRevert(ICzarVault.PasskeyNotSet.selector);
        vault.executeOwnerAction(3, "", deadline, a);
    }

    function test_ownerAction_expiredOrUnknown_reverts() public {
        uint256 past = block.timestamp - 1;
        uint256 deadline = block.timestamp + 1 hours;
        ICzarVault.WebAuthnAuth memory a = _assertion(_digest(3, "", 0, past), RP_ID_HASH, false);
        vm.expectRevert(ICzarVault.Expired.selector);
        vault.executeOwnerAction(3, "", past, a);
        vm.expectRevert(ICzarVault.UnknownAction.selector);
        vault.executeOwnerAction(0, "", deadline, a);
        vm.expectRevert(ICzarVault.UnknownAction.selector);
        vault.executeOwnerAction(18, "", deadline, a);
    }

    function test_ownerAction_replay_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        ICzarVault.WebAuthnAuth memory a = _assertion(_digest(3, "", 0, deadline), RP_ID_HASH, false);
        vault.executeOwnerAction(3, "", deadline, a);
        vm.expectRevert(ICzarVault.InvalidPasskeyAssertion.selector);
        vault.executeOwnerAction(3, "", deadline, a); // nonce is now 1
    }

    function test_ownerAction_otherPayloadOrAction_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory payload = abi.encode(owner, ONE_USDC);
        ICzarVault.WebAuthnAuth memory a = _assertion(_digest(5, payload, 0, deadline), RP_ID_HASH, false);
        bytes memory other = abi.encode(stranger, ONE_USDC);
        vm.expectRevert(ICzarVault.InvalidPasskeyAssertion.selector);
        vault.executeOwnerAction(5, other, deadline, a);
        vm.expectRevert(ICzarVault.InvalidPasskeyAssertion.selector);
        vault.executeOwnerAction(3, payload, deadline, a);
        vm.expectRevert(ICzarVault.InvalidPasskeyAssertion.selector);
        vault.executeOwnerAction(5, payload, deadline + 1, a);
    }

    /// @dev §7 / D88 G-59: the RP ID hash is checked by the vault.
    function test_ownerAction_wrongRpIdHash_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        ICzarVault.WebAuthnAuth memory a = _assertion(_digest(3, "", 0, deadline), sha256("evil.example"), false);
        vm.expectRevert(ICzarVault.InvalidPasskeyAssertion.selector);
        vault.executeOwnerAction(3, "", deadline, a);
    }

    /// @dev RV-034: high-s is refused; the normalised signature over the same message is accepted.
    function test_passkey_highS_refusedThenNormalisedAccepted() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _digest(3, "", 0, deadline);
        ICzarVault.WebAuthnAuth memory high = _assertion(digest, RP_ID_HASH, true);
        vm.expectRevert(ICzarVault.InvalidPasskeyAssertion.selector);
        vault.executeOwnerAction(3, "", deadline, high);
        high.s = bytes32(P256_N - uint256(high.s));
        vault.executeOwnerAction(3, "", deadline, high);
        assertTrue(vault.frozen());
    }

    function test_ownerAction_badPayload_revertsRaw() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory payload = hex"01";
        ICzarVault.WebAuthnAuth memory a = _assertion(_digest(5, payload, 0, deadline), RP_ID_HASH, false);
        vm.expectRevert();
        vault.executeOwnerAction(5, payload, deadline, a);
        assertEq(vault.ownerActionNonce(), 0); // the whole call reverted
    }

    /// @dev §15.9: action 1 sets approverIsOwner.
    function test_ownerAction_openEnvelope_approverIsOwner() public {
        ICzarVault.OpenEnvelopeParams memory p = _envelopeParams(0);
        _exec(ICzarVault.OwnerActionKind.OpenEnvelope, abi.encode(p));
        assertTrue(vault.getEnvelope(1).approverIsOwner);
    }

    // ───────────── Every action dispatches (§7 table) ─────────────

    function _envelopeParams(uint16 pocketBps) internal view returns (ICzarVault.OpenEnvelopeParams memory p) {
        p.cap = 4 * ONE_USDC;
        p.maxStepAmount = ONE_USDC;
        p.pocketCapBps = pocketBps;
        p.expiresAt = uint64(block.timestamp + 1 days);
        p.categoryId = CATEGORY;
        p.payeeRoot = PAYEE_ROOT;
    }

    function test_ownerAction_everyKindDispatches() public {
        // 7 SET_PASSKEY (same key, so later assertions still verify)
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.PasskeySet(keccak256(abi.encode(qx, qy)));
        _exec(ICzarVault.OwnerActionKind.SetPasskey, abi.encode(qx, qy, RP_ID_HASH));
        // 2 SET_LIMITS, 11 RAISE_AUTO_LIMIT (empty sig, current period), 12 LOWER_AUTO_LIMIT
        _exec(ICzarVault.OwnerActionKind.SetLimits, abi.encode(CATEGORY, 10 * ONE_USDC, ONE_USDC));
        _exec(ICzarVault.OwnerActionKind.RaiseAutoLimit, abi.encode(CATEGORY, 2 * ONE_USDC));
        assertEq(vault.getLimits(CATEGORY).autoLimit, 2 * ONE_USDC);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.AutoLimitLowered(CATEGORY, 2 * ONE_USDC, ONE_USDC, owner);
        _exec(ICzarVault.OwnerActionKind.LowerAutoLimit, abi.encode(CATEGORY, ONE_USDC));
        // 1 OPEN_ENVELOPE with a pocket share
        _exec(ICzarVault.OwnerActionKind.OpenEnvelope, abi.encode(_envelopeParams(2500)));
        uint64 env = 1;
        bytes32[] memory pocketProof = _proofB0c0();
        vm.prank(agent);
        vault.registerPocket(env, POCKET_B0C0, pocketProof);
        vm.prank(POCKET_B0C0);
        gatewayWallet.addDelegate(USDC_ADDRESS, address(vault));
        vm.prank(agent);
        vault.fundPocket(POCKET_B0C0, 500_000);
        // 13 REQUEST_PULLBACK, 14 CANCEL_PULLBACK
        uint256 maxBlock = block.number + 100;
        _exec(ICzarVault.OwnerActionKind.RequestPullback, abi.encode(POCKET_B0C0, 100_000, FEE, maxBlock));
        assertEq(vault.pullbackCount(), 1);
        vm.roll(maxBlock + PULLBACK_CANCEL_DELAY_BLOCKS);
        _exec(ICzarVault.OwnerActionKind.CancelPullback, abi.encode(uint64(1)));
        assertEq(uint8(vault.getPullback(1).state), uint8(ICzarVault.PullbackState.Cancelled));
        // 10 RECORD_MANUAL_RETURN, 15 WRITE_OFF_POCKET
        _exec(ICzarVault.OwnerActionKind.RecordManualReturn, abi.encode(POCKET_B0C0, 100_000));
        assertEq(vault.getPocket(POCKET_B0C0).outstanding, 400_000);
        _exec(ICzarVault.OwnerActionKind.WriteOffPocket, abi.encode(POCKET_B0C0));
        assertEq(uint8(vault.getPocket(POCKET_B0C0).state), uint8(ICzarVault.PocketState.Closed));
        // 17 CANCEL_JOB
        bytes32[] memory jobProof = _proofD00d();
        uint64 jobExpiry = uint64(block.timestamp + 1 hours);
        vm.prank(agent);
        bytes32 jobKey =
            vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, jobProof, jobExpiry, keccak256("job"));
        _exec(ICzarVault.OwnerActionKind.CancelJob, abi.encode(jobKey));
        assertEq(uint8(vault.getJob(jobKey).state), uint8(ICzarVault.JobState.Released));
        // 8 CLOSE_ENVELOPE
        _exec(ICzarVault.OwnerActionKind.CloseEnvelope, abi.encode(env));
        assertEq(uint8(vault.getEnvelope(env).state), uint8(ICzarVault.EnvelopeState.Closed));
        // 9 FORCE_CLOSE_ENVELOPE
        vm.prank(owner);
        uint64 env2 = vault.openEnvelope(_envelopeParams(0));
        vm.warp(vault.getEnvelope(env2).expiresAt + FORCE_CLOSE_DELAY);
        _exec(ICzarVault.OwnerActionKind.ForceCloseEnvelope, abi.encode(env2));
        assertEq(uint8(vault.getEnvelope(env2).state), uint8(ICzarVault.EnvelopeState.Closed));
        // 16 SET_MAX_PULLBACK_FEE, 6 ROTATE_SIGNERS
        _exec(ICzarVault.OwnerActionKind.SetMaxPullbackFee, abi.encode(uint256(5_000)));
        assertEq(vault.maxPullbackFee(), 5_000);
        address newEvaluator = makeAddr("newEvaluator");
        _exec(ICzarVault.OwnerActionKind.RotateSigners, abi.encode(agent, autonomy, newEvaluator));
        assertEq(vault.evaluator(), newEvaluator);
        // 5 WITHDRAW
        uint256 before = usdc.balanceOf(owner);
        _exec(ICzarVault.OwnerActionKind.Withdraw, abi.encode(owner, ONE_USDC));
        assertEq(usdc.balanceOf(owner), before + ONE_USDC);
        // 3 FREEZE, 4 UNFREEZE
        _exec(ICzarVault.OwnerActionKind.Freeze, "");
        _exec(ICzarVault.OwnerActionKind.Unfreeze, "");
        assertFalse(vault.frozen());
        assertEq(vault.ownerActionNonce(), 17); // every action ran exactly once
        uint256 deadline = block.timestamp + 1 hours;
        ICzarVault.WebAuthnAuth memory a = _assertion(_digest(18, "", 17, deadline), RP_ID_HASH, false);
        vm.expectRevert(ICzarVault.UnknownAction.selector);
        vault.executeOwnerAction(18, "", deadline, a);
    }

    /// @dev H2 named test: CANCEL_JOB through the passkey path.
    function test_ownerAction_cancelJob() public {
        vm.prank(owner);
        uint64 env = vault.openEnvelope(_envelopeParams(0));
        bytes32[] memory proof = _proofD00d();
        uint64 jobExpiry = uint64(block.timestamp + 1 hours);
        vm.prank(agent);
        bytes32 jobKey = vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, jobExpiry, keccak256("job"));
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobCancelled(jobKey);
        _exec(ICzarVault.OwnerActionKind.CancelJob, abi.encode(jobKey));
        assertEq(uint8(vault.getJob(jobKey).state), uint8(ICzarVault.JobState.Released));
    }

    /// @dev T-019 acceptance: an assertion without user verification (UV bit) is refused (REQUIRE_UV).
    function test_ownerAction_missingUv_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _digest(3, "", 0, deadline);
        ICzarVault.WebAuthnAuth memory a = _assertion(digest, RP_ID_HASH, false);
        bytes memory upOnly = abi.encodePacked(RP_ID_HASH, bytes1(0x01), uint32(0)); // UP set, UV clear
        bytes32 messageHash = sha256(abi.encodePacked(upOnly, sha256(bytes(a.clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(PASSKEY_PK, messageHash);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
        (a.r, a.s, a.authenticatorData) = (r, s, upOnly);
        vm.expectRevert(ICzarVault.InvalidPasskeyAssertion.selector);
        vault.executeOwnerAction(3, "", deadline, a);
    }
}
```

## 10. Build steps (tests first)
1. Create both test files (§9).
2. Run `FOUNDRY_PROFILE=arc arc-forge test --match-path test/AutonomyTest.t.sol`: `0 passed; 17 failed`. Run `FOUNDRY_PROFILE=arc arc-forge test --match-path test/OwnerActionTest.t.sol`: `1 passed; 11 failed` (`test_ownerAction_badPayload_revertsRaw` expects any revert, and the stub's `NotBuilt()` is one). Every failure mentions `NotBuilt()`. Paste both summary lines into your report.
3. Write `src/vault/logic/AutonomyLogic.sol` (§7), then `src/vault/logic/OwnerActionLogic.sol` (§8).
4. Do §5 (delete `VaultStubs.sol`) and §6 (replace `CzarVault.sol`).
5. Run both test files again: 17 passed and 12 passed.
6. `arc-forge fmt src/vault/logic/AutonomyLogic.sol src/vault/logic/OwnerActionLogic.sol`, then `arc-forge fmt --check` on those files plus `src/CzarVault.sol` and both test files: nothing printed apart from the flag notice.
7. Run the clean gate build and the full suite (00-conventions §2.2).

## 11. Definition of done
- `FOUNDRY_PROFILE=arc arc-forge test --match-contract AutonomyTest` → 17 passed, 0 failed (T-019: includes `RaiseTooLarge`, `RaiseAlreadyThisPeriod`, `BadSigner`, `Expired`).
- `FOUNDRY_PROFILE=arc arc-forge test --match-contract OwnerActionTest` → 12 passed, 0 failed (T-019: includes wrong `rpIdHash`, missing UV and wrong challenge → `InvalidPasskeyAssertion`).
- `FOUNDRY_PROFILE=arc arc-forge test` → 402 passed, 0 failed.
- `rm -rf out cache && FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes` → no warnings; `CzarVault` runtime about 14,540 B, `CzarVaultFactory` about 20,747 B, `AutonomyLogic` about 2,727 B, `OwnerActionLogic` about 9,405 B (more than 300 B off means your code differs from §6–§8).
- `grep -rn NotBuilt src/` → nothing. `ls src/vault/VaultStubs.sol` → no such file.
- `diff -r src/interfaces ../docs/specs/03-smart-contracts/interfaces` → nothing.

## 12. Open item (not a step)
- T-019 lists "a captured WebAuthn fixture in `contracts/test/fixtures/`". Capturing one needs a real passkey on a real device, which needs Zaryab's approval (CLAUDE.md). The tests here use assertions built with `vm.signP256`, which exercise the same verifier. Do not try to capture a fixture in this task; note it as open in your report.

- **Deferred to PRD 12:** the `autonomyRaise_5042002` and `ownerAction_5042002` digests on-chain, and the `autonomyRaise` vector executed at its `deadline` (RV-061), are `test_vectors_reproducedOnChain`; the P-256 precompile gas (6,900 per call) is measured in PRD 12. `test_lowerBelowUsed_openEnvelopeRevertsAllowanceExceeded` (assigned to T-014 and T-019) is in `EnvelopeTest` (PRD 05): cite it there in your report.

## 13. Stop conditions
- A test fails after you have compared the function with its numbered steps: stop and report the test name and failure line. Never change a test.
- A passkey test fails with `InvalidPasskeyAssertion` although your code matches §8: run `FOUNDRY_PROFILE=arc arc-forge test --match-path test/LibrariesTest.t.sol --match-test passkey` (8 tests). If those fail too, `PasskeyVerifier` (PRD 01) is wrong: stop and report it. If they pass, compare the digest in §8.2 step 5 with `test/OwnerActionTest.t.sol` `_digest`, then stop and report.

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version (D89 library layout), verified on Arc Foundry v0.8.0-2 against a reference implementation. |
| 2026-10-20 | Shorthand rules; deferrals to PRD 12 (vectors, precompile gas) and where the T-014/T-019 test lives (review). |
