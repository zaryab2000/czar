# 04 — Vault core

## 1. Scope
- **Task:** T-013 (CzarVault core: balance, owner settings, freeze, getters).
- **You build:** `contracts/src/vault/VaultCore.sol` with 19 `ICzarVault` functions plus `receive()`, and `contracts/test/VaultCoreTest.t.sol`. You also delete 19 stubs from `VaultStubs.sol` and add `VaultCore` to `CzarVault`.
- **Functions in this PRD:**
  - balance: `freeBalance`, `sync`, `withdraw`, and `receive()` (not in the interface)
  - owner settings: `setCategoryLimits`, `freeze`, `unfreeze`, `rotateSigners`, `setPasskey`, `setMaxPullbackFee`
  - getters: `stepUsed`, `envelopePocket`, `envelopeShortfall`, `getEnvelope`, `getReservation`, `getPocket`, `getPullback`, `getJob`, `getLimits`, `getPasskey`
- **You do not build:** envelopes (PRD 05) or anything later. Their stubs stay.
- **Dependencies:** PRD 03 done (`FactoryTest` 22 passed, 105 tests in total).

## 2. This PRD is already verified
- A reference `VaultCore` written from §7 below was built and tested on **Arc Foundry v0.8.0-2** with `FOUNDRY_PROFILE=arc`: `--deny-warnings` build clean (compiler and lint), `fmt --check` clean, 141 tests passed (105 earlier plus the 36 in §8).
- Sizes after this PRD: `CzarVault` runtime 9,849 B, initcode 11,510 B; `CzarVaultFactory` runtime 16,024 B.
- The test file in §8 is the acceptance gate. Copy it exactly.

## 3. Sources (read these, nothing else)
- `07-contract-build/00-conventions.md` (§3.1 stubs, §4 style, §5 tests, §5.6 traps).
- `07-contract-build/03-factory-and-vault-skeleton.md` §7 (`VaultStorage`: the variables and `_require*` helpers you use).
- `docs/specs/03-smart-contracts/czar-vault.md`: §2 and §15.1 (callers), §5.1 (functions), §9 (events and errors), §15.2 (errors), §15.4 (`PasskeySet` key hash), §15.5 (guarded functions), §15.10 (`setCategoryLimits` nonce), §15.11 (`freeze` while frozen, `rotateSigners`, `withdraw`).
- `docs/specs/03-smart-contracts/interfaces/ICzarVault.sol`.
- `docs/specs/03-smart-contracts/security-and-testing.md` §3.7 rows RV-011 and RV-037.

## 4. Files
| File | Action | Section |
|---|---|---|
| `contracts/test/VaultCoreTest.t.sol` | create | §8 |
| `contracts/src/vault/VaultCore.sol` | create | §7 |
| `contracts/src/vault/VaultStubs.sol` | delete 19 stubs | §6 |
| `contracts/src/CzarVault.sol` | add `VaultCore` | §6 |

## 5. Rules that apply to every function here
- **The external/internal pair.** Every state-changing interface function is a thin external wrapper that calls an internal `_name(address caller, …)` with `caller = msg.sender`. All checks and effects are in the internal function. PRD 10's passkey path calls the same internal functions with `caller = owner` (`czar-vault.md` §15.5, §15.9). Views have no internal form.
- **Caller checks** use only the `VaultStorage` helpers: `_requireOwner(caller)` (raises `NotOwner`), `_requireOwnerOrAgent(caller)` (raises `NotAuthorized`). Never compare `msg.sender` yourself.
- **Guard:** `nonReentrant` goes on the **external** wrapper, and only on `withdraw` and `sync` in this PRD (`czar-vault.md` §15.5: they call USDC).
- **Events** come from `ICzarVault` (inherited); emit them by name.
- **Freeze and pause gate nothing in this PRD.** `withdraw` is the owner's own money and is never gated (§15.11). Do not call `_requireNotPausedOrFrozen` here.
- **USDC** is the `USDC` immutable from `VaultStorage`, used as `IERC20(USDC)`. Transfers use `SafeERC20` (`using SafeERC20 for IERC20;`).

## 6. Wire the module in
1. In `VaultStubs.sol`, delete (with your editor or a script; any method is fine) the whole stub (from its `function` line through its closing `}`, plus one blank line) for each of these 19 functions:
   `envelopePocket`, `envelopeShortfall`, `freeBalance`, `freeze`, `getEnvelope`, `getJob`, `getLimits`, `getPasskey`, `getPocket`, `getPullback`, `getReservation`, `rotateSigners`, `setCategoryLimits`, `setMaxPullbackFee`, `setPasskey`, `stepUsed`, `sync`, `unfreeze`, `withdraw`.
   Afterwards `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` prints `25`.
2. Replace `src/CzarVault.sol` with:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VaultStorage} from "./vault/VaultStorage.sol";
import {VaultCore} from "./vault/VaultCore.sol";
import {VaultStubs} from "./vault/VaultStubs.sol";

/// @title CzarVault
/// @notice The per-user vault (czar-vault.md). Immutable; no proxy (D33). The only concrete vault contract: it
///         inherits every vault module. Each later PRD adds its module to this list and removes its stubs.
contract CzarVault is VaultCore, VaultStubs {
    /// @dev czar-vault.md §15.8. Called by CzarVaultFactory.createVault through CREATE2.
    constructor(address ownerAccount) VaultStorage(ownerAccount) {}
}
```
- If a stub is left behind, the build fails with `Error (6480): Derived contract must override function "<name>"` (00-conventions §3.1): delete that stub.

## 7. `src/vault/VaultCore.sol`

### 7.1 Header
- `// SPDX-License-Identifier: MIT`, `pragma solidity 0.8.30;`
- Imports, exactly:
  - `{IERC20}` from `@openzeppelin/contracts/token/ERC20/IERC20.sol`
  - `{SafeERC20}` from `@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol`
  - `{ICzarVault}` from `../interfaces/ICzarVault.sol` (needed by `@inheritdoc`; 00-conventions §4.11)
  - `{VaultStorage}` from `./VaultStorage.sol`
  - `{SatMath}` from `../libraries/SatMath.sol`
- `/// @title VaultCore` and a one-line `/// @notice` citing `czar-vault.md` §5.1 and T-013.
- `abstract contract VaultCore is VaultStorage { using SafeERC20 for IERC20; … }`
- Every external or public function: `/// @inheritdoc ICzarVault`. Every internal function: one `/// @dev` line citing its spec section.

### 7.2 Balance
1. **`freeBalance() public view returns (uint256)`** — `public`, because `_withdraw` calls it.
   - `return SatMath.sat(IERC20(USDC).balanceOf(address(this)), committedTotal);` (never reverts, RV-011)
2. **`sync() external nonReentrant`** (anyone)
   - `emit BalanceSynced(IERC20(USDC).balanceOf(address(this)), committedTotal);` Nothing else.
3. **`receive() external payable`** (anyone; not in `ICzarVault`, so `/// @dev` instead of `@inheritdoc`)
   - `emit NativeReceived(msg.sender, msg.value);` Nothing else: native value is the USDC balance on Arc (A1-05).
4. **`withdraw(address to, uint256 amount) external nonReentrant`** → `_withdraw(msg.sender, to, amount);`
   **`_withdraw(address caller, address to, uint256 amount) internal`**, checks in this order:
   1. `_requireOwner(caller);`
   2. `if (to == address(0)) revert ZeroAddress();`
   3. `if (to == address(this) || amount == 0) revert BadParams();`
   4. `uint256 free = freeBalance(); if (amount > free) revert InsufficientFree(free, amount);`
   5. `emit Withdrawn(to, amount);` (no state changes, so the event comes before the external call, 00-conventions §4.6)
   6. `IERC20(USDC).safeTransfer(to, amount);`

### 7.3 Owner settings
Each function below is an external wrapper `name(args) external { _name(msg.sender, args); }` plus the internal function described. The external wrapper uses **exactly the parameter names in `ICzarVault.sol`** (for example `rotateSigners(address agent, address autonomy, address evaluator_)`), and the internal function takes `address caller` first, then the same names.

5. **`_setCategoryLimits(address caller, bytes32 categoryId, uint256 userMax, uint256 autoLimit)`** (spec §5.1, §15.10)
   1. `_requireOwner(caller);`
   2. `if (autoLimit > userMax) revert AutoLimitAboveUserMax();`
   3. `CategoryLimits storage l = limits[categoryId]; l.userMax = userMax; l.autoLimit = autoLimit;` (leave `usedInPeriod`, `periodId`, `lastRaiseAt` unchanged)
   4. `autonomyNonce++;` (D88: a raise signed before this call can never land)
   5. `emit LimitsSet(categoryId, userMax, autoLimit);`
6. **`_freeze(address caller)`** (spec §5.1, RV-030, §15.11)
   1. `_requireOwnerOrAgent(caller);`
   2. `frozen = true;` (no "already frozen" check: idempotent)
   3. `autonomyNonce++;`
   4. `emit Frozen(caller);`
7. **`_unfreeze(address caller)`**
   1. `_requireOwner(caller);`
   2. `frozen = false;`
   3. `emit Unfrozen();`
8. **`_rotateSigners(address caller, address agent, address autonomy, address evaluator_)`** (spec §5.1, §15.11)
   1. `_requireOwner(caller);`
   2. any of the three zero → `revert ZeroAddress();`
   3. `if (agent == evaluator_) revert BadParams();`
   4. `agentSigner = agent; autonomySigner = autonomy; evaluator = evaluator_;`
   5. `emit SignersRotated(agent, autonomy, evaluator_);`
   - The parameter is `evaluator_` (trailing underscore) because `evaluator` is the storage variable.
9. **`_setPasskey(address caller, bytes32 qx, bytes32 qy, bytes32 rpIdHash)`** (spec §5.1, §7, §15.4)
   1. `_requireOwner(caller);`
   2. any of `qx`, `qy`, `rpIdHash` equal to `bytes32(0)` → `revert BadParams();`
   3. `passkey = Passkey({qx: qx, qy: qy, rpIdHash: rpIdHash, set: true});`
   4. `emit PasskeySet(keccak256(abi.encode(qx, qy)));`
10. **`_setMaxPullbackFee(address caller, uint256 newMax)`** (spec §5.1, D81)
    1. `_requireOwner(caller);`
    2. `if (newMax == 0) revert BadParams();`
    3. `if (newMax > MAX_PULLBACK_FEE_CEILING) revert FeeCeilingExceeded(newMax, MAX_PULLBACK_FEE_CEILING);`
    4. `uint256 oldMax = maxPullbackFee; maxPullbackFee = newMax;`
    5. `emit MaxPullbackFeeSet(oldMax, newMax);`

### 7.4 Getters (all `external view`, no checks; an unknown id returns the zero record)
| Function | Returns |
|---|---|
| `stepUsed(uint64 envelopeId, uint32 stepIndex) returns (uint256)` | `_stepUsed[envelopeId][stepIndex]` |
| `envelopePocket(uint64 envelopeId) returns (address)` | `envelopes[envelopeId].pocket` |
| `envelopeShortfall(uint64 envelopeId) returns (uint256)` | `envelopes[envelopeId].shortfall` |
| `getEnvelope(uint64 envelopeId) returns (Envelope memory)` | `envelopes[envelopeId]` |
| `getReservation(uint64 reservationId) returns (Reservation memory)` | `reservations[reservationId]` |
| `getPocket(address pocket) returns (Pocket memory)` | `pockets[pocket]` |
| `getPullback(uint64 pullbackId) returns (Pullback memory)` | `pullbacks[pullbackId]` |
| `getJob(bytes32 jobKey) returns (Job memory)` | `jobs[jobKey]` |
| `getLimits(bytes32 categoryId) returns (CategoryLimits memory)` | `limits[categoryId]` |
| `getPasskey() returns (Passkey memory)` | `passkey` |

### 7.5 Order in the file
Sections in this order, each with a `// ───────────── <Name> ─────────────` divider: Balance (`freeBalance`, `sync`, `receive`, `withdraw`, `_withdraw`), Owner settings (each external wrapper followed by its internal function, in the order 5–10), Getters (in the §7.4 order).

## 8. `test/VaultCoreTest.t.sol`
- 36 tests: constructor rules and the domain-separator vectors (through `CzarVaultHarness` placed at the vector vault address), every function's success path with its events, every error, the RV-011 and RV-037 named tests, and a role matrix over five callers (`czar-vault.md` §2, §15.1).
- `test_freeBalance_saturatesInSettleWindow` sets `committedTotal` with forge-std `stdstore`, because envelopes and settle are not built yet (PRD 06 adds the real settle-window test).
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {stdStorage, StdStorage} from "forge-std/Test.sol";
import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {ICzarVaultFactory} from "../src/interfaces/ICzarVaultFactory.sol";
import {CzarVault} from "../src/CzarVault.sol";
import {
    DEFAULT_MAX_PULLBACK_FEE,
    MAX_PULLBACK_FEE_CEILING,
    MAX_AGENT_POCKET_CAP_BPS,
    POCKET_STEP_INDEX
} from "../src/libraries/CzarConstants.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {CzarVaultHarness} from "./helpers/CzarVaultHarness.sol";

/// @dev 07 PRD 04 (T-013). czar-vault.md §3, §5.1, §15.
contract VaultCoreTest is VaultTestBase {
    using stdStorage for StdStorage;

    address internal constant VECTOR_VAULT = address(0xc2a21); // 02 vectors: example vault
    bytes32 internal constant CATEGORY = keccak256("category.research");

    // ───────────── Constructor ─────────────

    function test_constructor_setsImmutablesAndDefaults() public view {
        assertEq(vault.owner(), owner);
        assertEq(vault.factory(), address(vaultFactory));
        assertEq(vault.jobEscrow(), address(jobEscrow));
        assertEq(vault.jobEscrowKind(), 0);
        assertEq(vault.agentSigner(), agent);
        assertEq(vault.autonomySigner(), autonomy);
        assertEq(vault.evaluator(), evaluatorKey);
        assertEq(vault.maxPullbackFee(), DEFAULT_MAX_PULLBACK_FEE);
        assertFalse(vault.frozen());
        assertEq(vault.committedTotal(), 0);
        assertEq(vault.envelopeCount(), 0);
        assertEq(vault.autonomyNonce(), 0);
    }

    function test_constants_matchSpec() public view {
        assertEq(vault.MAX_PULLBACK_FEE_CEILING(), MAX_PULLBACK_FEE_CEILING);
        assertEq(vault.MAX_PULLBACK_FEE_CEILING(), 500_000);
        assertEq(vault.MAX_AGENT_POCKET_CAP_BPS(), MAX_AGENT_POCKET_CAP_BPS);
        assertEq(vault.POCKET_STEP_INDEX(), POCKET_STEP_INDEX);
        assertEq(vault.POCKET_STEP_INDEX(), type(uint32).max);
    }

    function test_constructor_zeroOwner_reverts() public {
        vm.expectRevert(ICzarVault.ZeroAddress.selector);
        vaultFactory.deploy(address(0));
    }

    function test_constructor_zeroNetworkAddress_reverts() public {
        ICzarVaultFactory.NetworkConfig memory cfg = _networkConfig();
        cfg.gatewayMinter = address(0);
        vaultFactory.setNetworkConfig(cfg);
        vm.expectRevert(ICzarVault.ZeroAddress.selector);
        vaultFactory.deploy(owner);
    }

    function test_constructor_zeroDefaultSigner_reverts() public {
        ICzarVaultFactory.Defaults memory d = _defaults();
        d.autonomySigner = address(0);
        vaultFactory.setDefaults(d);
        vm.expectRevert(ICzarVault.ZeroAddress.selector);
        vaultFactory.deploy(owner);
    }

    function test_constructor_unknownEscrowKind_reverts() public {
        ICzarVaultFactory.NetworkConfig memory cfg = _networkConfig();
        cfg.jobEscrowKind = 2;
        vaultFactory.setNetworkConfig(cfg);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vaultFactory.deploy(owner);
    }

    function test_constructor_agentEqualsEvaluator_reverts() public {
        ICzarVaultFactory.Defaults memory d = _defaults();
        d.evaluator = d.agentSigner;
        vaultFactory.setDefaults(d);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vaultFactory.deploy(owner);
    }

    function test_constructor_domainSeparatorsMatchVectors() public {
        bytes memory initcode = abi.encodePacked(type(CzarVaultHarness).creationCode, abi.encode(owner));
        CzarVaultHarness h = CzarVaultHarness(payable(vaultFactory.deployCodeAt(VECTOR_VAULT, initcode)));
        assertEq(h.exposed_usdcDomainSeparator(), 0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0);
        assertEq(h.exposed_slDomainSeparator(), 0x4937387a5eb9c824f88751eb9abc6792a901e035deb9ec3fa75f584cc4669f69);
        assertEq(h.exposed_vaultDomainSeparator(), 0x64b8044ade387c82cd664c7d2b51859e664c6cee481b628977a3b94c6f77b6b0);
        assertEq(h.exposed_gatewayDomain(), ARC_GATEWAY_DOMAIN);
        assertEq(h.owner(), owner);
        assertEq(h.factory(), address(vaultFactory));
    }

    // ───────────── freeBalance, sync, receive ─────────────

    function test_freeBalance_equalsBalanceWhenNothingCommitted() public {
        _fundVault(5 * ONE_USDC);
        assertEq(vault.freeBalance(), 5 * ONE_USDC);
    }

    /// @dev RV-011 named test. Until PRD 06 builds settle, the settle window is set up with stdstore: committedTotal
    ///      above the balance, as after a USDC authorization moved money before settle.
    function test_freeBalance_saturatesInSettleWindow() public {
        _fundVault(3 * ONE_USDC);
        stdstore.target(address(vault)).sig("committedTotal()").checked_write(5 * ONE_USDC);
        assertEq(vault.freeBalance(), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.InsufficientFree.selector, 0, ONE_USDC));
        vault.withdraw(owner, ONE_USDC);
    }

    function test_sync_emitsBalanceSynced() public {
        _fundVault(2 * ONE_USDC);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.BalanceSynced(2 * ONE_USDC, 0);
        vm.prank(stranger);
        vault.sync();
    }

    function test_receive_nativeCountsAsFreeBalance() public {
        uint256 weiValue = 3 * ONE_USDC * 1e12;
        vm.deal(stranger, weiValue);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.NativeReceived(stranger, weiValue);
        vm.prank(stranger);
        (bool ok,) = address(vault).call{value: weiValue}("");
        assertTrue(ok);
        assertEq(usdc.balanceOf(address(vault)), 3 * ONE_USDC);
        assertEq(vault.freeBalance(), 3 * ONE_USDC);
    }

    // ───────────── withdraw ─────────────

    function test_withdraw_owner_transfers() public {
        _fundVault(5 * ONE_USDC);
        address to = makeAddr("to");
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Withdrawn(to, 2 * ONE_USDC);
        vm.prank(owner);
        vault.withdraw(to, 2 * ONE_USDC);
        assertEq(usdc.balanceOf(to), 2 * ONE_USDC);
        assertEq(vault.freeBalance(), 3 * ONE_USDC);
    }

    function test_withdraw_notOwner_reverts() public {
        _fundVault(ONE_USDC);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.NotOwner.selector);
        vault.withdraw(agent, ONE_USDC);
    }

    function test_withdraw_zeroTo_reverts() public {
        _fundVault(ONE_USDC);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.ZeroAddress.selector);
        vault.withdraw(address(0), ONE_USDC);
    }

    function test_withdraw_toVault_reverts() public {
        _fundVault(ONE_USDC);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.withdraw(address(vault), ONE_USDC);
    }

    function test_withdraw_zeroAmount_reverts() public {
        vm.prank(owner);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.withdraw(owner, 0);
    }

    function test_withdraw_aboveFree_reverts() public {
        _fundVault(ONE_USDC);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.InsufficientFree.selector, ONE_USDC, ONE_USDC + 1));
        vault.withdraw(owner, ONE_USDC + 1);
    }

    function test_withdraw_allowedWhileFrozenAndPaused() public {
        _fundVault(ONE_USDC);
        vm.prank(owner);
        vault.freeze();
        vaultFactory.setGuardianPaused(true);
        vm.prank(owner);
        vault.withdraw(owner, ONE_USDC);
        assertEq(usdc.balanceOf(owner), ONE_USDC);
    }

    // ───────────── setCategoryLimits ─────────────

    function test_setCategoryLimits_ownerSetsAndBumpsNonce() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.LimitsSet(CATEGORY, 10 * ONE_USDC, 4 * ONE_USDC);
        vm.prank(owner);
        vault.setCategoryLimits(CATEGORY, 10 * ONE_USDC, 4 * ONE_USDC);
        ICzarVault.CategoryLimits memory l = vault.getLimits(CATEGORY);
        assertEq(l.userMax, 10 * ONE_USDC);
        assertEq(l.autoLimit, 4 * ONE_USDC);
        assertEq(vault.autonomyNonce(), 1);
    }

    function test_setCategoryLimits_autoAboveUserMax_reverts() public {
        vm.prank(owner);
        vm.expectRevert(ICzarVault.AutoLimitAboveUserMax.selector);
        vault.setCategoryLimits(CATEGORY, ONE_USDC, ONE_USDC + 1);
    }

    function test_setCategoryLimits_notOwner_reverts() public {
        vm.prank(autonomy);
        vm.expectRevert(ICzarVault.NotOwner.selector);
        vault.setCategoryLimits(CATEGORY, ONE_USDC, ONE_USDC);
    }

    // ───────────── freeze, unfreeze ─────────────

    function test_freeze_ownerOrAgent_setsAndBumpsNonce() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Frozen(agent);
        vm.prank(agent);
        vault.freeze();
        assertTrue(vault.frozen());
        assertEq(vault.autonomyNonce(), 1);
        vm.prank(owner);
        vault.freeze(); // idempotent; bumps again (§15.11)
        assertEq(vault.autonomyNonce(), 2);
    }

    function test_freeze_stranger_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(ICzarVault.NotAuthorized.selector);
        vault.freeze();
    }

    function test_unfreeze_ownerOnly() public {
        vm.prank(agent);
        vault.freeze();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.NotOwner.selector);
        vault.unfreeze();
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Unfrozen();
        vm.prank(owner);
        vault.unfreeze();
        assertFalse(vault.frozen());
    }

    // ───────────── rotateSigners ─────────────

    function test_rotateSigners_ownerRotates() public {
        address a2 = makeAddr("agent2");
        address s2 = makeAddr("autonomy2");
        address e2 = makeAddr("evaluator2");
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.SignersRotated(a2, s2, e2);
        vm.prank(owner);
        vault.rotateSigners(a2, s2, e2);
        assertEq(vault.agentSigner(), a2);
        assertEq(vault.autonomySigner(), s2);
        assertEq(vault.evaluator(), e2);
    }

    function test_rotateSigners_zero_reverts() public {
        vm.prank(owner);
        vm.expectRevert(ICzarVault.ZeroAddress.selector);
        vault.rotateSigners(agent, address(0), evaluatorKey);
    }

    function test_rotateSigners_agentEqualsEvaluator_reverts() public {
        vm.prank(owner);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.rotateSigners(agent, autonomy, agent);
    }

    function test_rotateSigners_notOwner_reverts() public {
        vm.prank(agent);
        vm.expectRevert(ICzarVault.NotOwner.selector);
        vault.rotateSigners(agent, autonomy, evaluatorKey);
    }

    // ───────────── setPasskey ─────────────

    function test_setPasskey_ownerSetsAndEmitsKeyHash() public {
        bytes32 qx = bytes32(uint256(1));
        bytes32 qy = bytes32(uint256(2));
        bytes32 rp = sha256("localhost");
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.PasskeySet(keccak256(abi.encode(qx, qy)));
        vm.prank(owner);
        vault.setPasskey(qx, qy, rp);
        ICzarVault.Passkey memory p = vault.getPasskey();
        assertEq(p.qx, qx);
        assertEq(p.qy, qy);
        assertEq(p.rpIdHash, rp);
        assertTrue(p.set);
    }

    function test_setPasskey_zeroField_reverts() public {
        bytes32 rp = sha256("localhost"); // sha256 is a precompile call: compute it before prank/expectRevert
        vm.prank(owner);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.setPasskey(bytes32(uint256(1)), bytes32(0), rp);
    }

    // ───────────── setMaxPullbackFee (D81) ─────────────

    function test_setMaxPullbackFee_ownerSets() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.MaxPullbackFeeSet(DEFAULT_MAX_PULLBACK_FEE, 20_000);
        vm.prank(owner);
        vault.setMaxPullbackFee(20_000);
        assertEq(vault.maxPullbackFee(), 20_000);
    }

    /// @dev RV-037 named test.
    function test_setMaxPullbackFee_aboveCeiling_reverts() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICzarVault.FeeCeilingExceeded.selector, MAX_PULLBACK_FEE_CEILING + 1, MAX_PULLBACK_FEE_CEILING
            )
        );
        vault.setMaxPullbackFee(MAX_PULLBACK_FEE_CEILING + 1);
    }

    function test_setMaxPullbackFee_zero_reverts() public {
        vm.prank(owner);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.setMaxPullbackFee(0);
    }

    // ───────────── Getters of unknown records ─────────────

    function test_getters_unknownRecordsAreZero() public view {
        assertEq(uint8(vault.getEnvelope(1).state), uint8(ICzarVault.EnvelopeState.None));
        assertEq(uint8(vault.getReservation(1).state), uint8(ICzarVault.ReservationState.None));
        assertEq(vault.getPocket(stranger).envelopeId, 0);
        assertEq(vault.getPullback(1).pocket, address(0));
        assertEq(vault.getJob(bytes32(uint256(1))).jobId, 0);
        assertEq(vault.stepUsed(1, 0), 0);
        assertEq(vault.envelopePocket(1), address(0));
        assertEq(vault.envelopeShortfall(1), 0);
        assertFalse(vault.getPasskey().set);
    }

    // ───────────── Role matrix for the core functions (czar-vault.md §2, §15.1) ─────────────

    function test_roleMatrix_coreFunctions() public {
        address[5] memory callers = [owner, agent, autonomy, evaluatorKey, stranger];
        for (uint256 i = 0; i < callers.length; i++) {
            address c = callers[i];
            bool isOwner = c == owner;
            bool isOwnerOrAgent = isOwner || c == agent;
            _fundVault(1);
            _expectCall(c, abi.encodeCall(ICzarVault.withdraw, (owner, 1)), isOwner, ICzarVault.NotOwner.selector);
            _expectCall(
                c, abi.encodeCall(ICzarVault.setCategoryLimits, (CATEGORY, 2, 1)), isOwner, ICzarVault.NotOwner.selector
            );
            _expectCall(c, abi.encodeCall(ICzarVault.freeze, ()), isOwnerOrAgent, ICzarVault.NotAuthorized.selector);
            _expectCall(c, abi.encodeCall(ICzarVault.unfreeze, ()), isOwner, ICzarVault.NotOwner.selector);
            _expectCall(
                c,
                abi.encodeCall(ICzarVault.rotateSigners, (agent, autonomy, evaluatorKey)),
                isOwner,
                ICzarVault.NotOwner.selector
            );
            _expectCall(
                c,
                abi.encodeCall(ICzarVault.setPasskey, (bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)))),
                isOwner,
                ICzarVault.NotOwner.selector
            );
            _expectCall(
                c,
                abi.encodeCall(ICzarVault.setMaxPullbackFee, (DEFAULT_MAX_PULLBACK_FEE)),
                isOwner,
                ICzarVault.NotOwner.selector
            );
            _expectCall(c, abi.encodeCall(ICzarVault.sync, ()), true, bytes4(0));
        }
    }

    function _expectCall(address caller, bytes memory data, bool allowed, bytes4 err) internal {
        if (!allowed) vm.expectRevert(err);
        vm.prank(caller);
        (bool ok,) = address(vault).call(data);
        if (allowed) assertTrue(ok);
    }
}
```

## 9. Build steps (tests first)
1. Create `test/VaultCoreTest.t.sol` (§8). Run `FOUNDRY_PROFILE=arc arc-forge test --match-path test/VaultCoreTest.t.sol`. Expected: `8 passed; 28 failed`. The 8 constructor and constant tests already pass because PRD 03 built the constructor; 26 failures say `NotBuilt()` (the stubs) and 2 say `assertion failed` (`receive()` does not exist yet). Paste the summary line into your report.
2. Write `src/vault/VaultCore.sol` from §7.
3. Do §6 (delete the 19 stubs, replace `CzarVault.sol`).
4. Run the test file again: 36 passed.
5. `arc-forge fmt src/vault/VaultCore.sol src/vault/VaultStubs.sol src/CzarVault.sol`, then `arc-forge fmt --check` on those files plus `test/VaultCoreTest.t.sol`: nothing printed.
6. Run the full build with sizes and the full suite (00-conventions §2.2).

## 10. Definition of done
- `FOUNDRY_PROFILE=arc arc-forge test --match-contract VaultCoreTest` → 36 passed, 0 failed (T-013 acceptance command).
- `FOUNDRY_PROFILE=arc arc-forge test` → 141 passed, 0 failed.
- `FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes` → no warnings; `CzarVault` runtime about 9,849 B (paste the line; more than 300 B off means your code differs from §7).
- `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` → 25.
- `diff -r src/interfaces ../docs/specs/03-smart-contracts/interfaces` → nothing.
- T-013's acceptance lines: `USDC_DOMAIN_SEPARATOR` equals the vector (checked by `test_constructor_domainSeparatorsMatchVectors`); the role-matrix test passes; the RV-011 and RV-037 named tests pass.

## 11. Stop conditions
- A test fails after you have compared the function with its numbered steps in §7: stop and report the test name and failure line. Never change a test.
- A lint or compiler warning you cannot remove by the rules in 00-conventions §2.4 and §4.11: stop and report it.

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version, verified on Arc Foundry v0.8.0-2 against a reference implementation. |
| 2026-10-20 | Pilot build by a small model from this PRD alone: 141 passed, sizes identical, its `VaultCore` identical to the reference apart from whitespace. Its feedback applied: exact red-phase counts, wrapper parameter names, stub deletion method. |
