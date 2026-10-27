# 04 — Vault core

## 1. Scope
- **Task:** T-013 (CzarVault core: balance, owner settings, freeze; the getters were built by PRD 03).
- **You build:**
  - `contracts/src/vault/logic/CoreLogic.sol`: a linked library with 7 external functions (§7).
  - `contracts/src/CzarVault.sol`: replaced with the version in §6 (`receive()`, `sync()` and 7 wrappers).
  - `contracts/test/VaultCoreTest.t.sol` (§8).
  - You delete 8 stubs from `VaultStubs.sol`.
- **Functions in this PRD:**
  - balance: `sync`, `withdraw`, and `receive()` (not in the interface)
  - owner settings: `setCategoryLimits`, `freeze`, `unfreeze`, `rotateSigners`, `setPasskey`, `setMaxPullbackFee`
- **You do not build:** envelopes (PRD 05) or anything later. Their stubs stay.
- **Dependencies:** PRD 03 done (`FactoryTest` 22 passed, 107 tests in total, 32 stubs).

## 2. This PRD is already verified
- A reference `CoreLogic` written from §7 below was built and tested on **Arc Foundry v0.8.0-2** with `FOUNDRY_PROFILE=arc`: clean `--deny-warnings` build (compiler and lint), `fmt --check` clean, 143 tests passed (107 earlier plus the 36 in §8).
- Sizes after this PRD: `CzarVault` runtime 9,976 B, initcode 11,669 B; `CzarVaultFactory` runtime 16,183 B; `CoreLogic` runtime 2,921 B.
- The test file in §8 is the acceptance gate. Copy it exactly.

## 3. Sources (read these, nothing else)
- `07-contract-build/00-conventions.md` (§3, §3.1 stubs, §3.2 library rules, §4 style, §5 tests, §5.6 traps).
- `07-contract-build/03-factory-and-vault-skeleton.md` §7 (`VaultState`, `VaultGuards`, `VaultBase`: the fields and helpers you use).
- `docs/specs/03-smart-contracts/czar-vault.md`: §2 and §15.1 (callers), §5.1 (functions), §9 (events and errors), §15.2 (errors), §15.4 (`PasskeySet` key hash), §15.5 (guarded functions), §15.10 (`setCategoryLimits` nonce), §15.11 (`freeze` while frozen, `rotateSigners`, `withdraw`).
- `docs/specs/03-smart-contracts/interfaces/ICzarVault.sol`.
- `docs/specs/03-smart-contracts/security-and-testing.md` §3.7 rows RV-011 and RV-037.

## 4. Files
| File | Action | Section |
|---|---|---|
| `contracts/test/VaultCoreTest.t.sol` | create | §8 |
| `contracts/src/vault/logic/CoreLogic.sol` | create | §7 |
| `contracts/src/vault/VaultStubs.sol` | delete 8 stubs | §6 |
| `contracts/src/CzarVault.sol` | replace | §6 |

## 5. Rules that apply to every function here
- **Wrapper and library.** Every state-changing interface function is a thin wrapper in `CzarVault` that calls `CoreLogic.<name>(_s, _config(), msg.sender, …)`. All checks, effects and events are in the library function. PRD 10's passkey path calls the same library functions with `caller = owner` (`czar-vault.md` §15.5, §15.9; 00-conventions §3.2).
- **Library signature:** `function <name>(VaultState storage s, VaultConfig memory c, address caller, <interface arguments>) external`. The interface arguments keep the interface's names, except `rotateSigners`, whose library parameter is `evaluator` (the library has no `evaluator` variable to clash with).
- **Caller checks** use only `VaultGuards`: `VaultGuards.requireOwner(c, caller)` (raises `NotOwner`), `VaultGuards.requireOwnerOrAgent(s, c, caller)` (raises `NotAuthorized`). Never compare `msg.sender` yourself.
- **Guard:** `nonReentrant` is on the wrapper in `CzarVault`, and only on `withdraw` and `sync` in this PRD (`czar-vault.md` §15.5: they call USDC).
- **Errors and events** are qualified in the library: `revert ICzarVault.BadParams();`, `emit ICzarVault.Frozen(caller);` (00-conventions §3.2).
- **Freeze and pause gate nothing in this PRD.** `withdraw` is the owner's own money and is never gated (§15.11). Do not call `requireNotPausedOrFrozen` here.
- **USDC** is `c.usdc`, used as `IERC20(c.usdc)`. Transfers use `SafeERC20` (`using SafeERC20 for IERC20;`).

## 6. Wire the library in
1. In `VaultStubs.sol`, delete (with your editor or a script; any method is fine) the whole stub (from its `function` line through its closing `}`, plus one blank line) for each of these 8 functions:
   `freeze`, `rotateSigners`, `setCategoryLimits`, `setMaxPullbackFee`, `setPasskey`, `sync`, `unfreeze`, `withdraw`.
   Afterwards `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` prints `24`.
2. Replace `src/CzarVault.sol` with:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICzarVault} from "./interfaces/ICzarVault.sol";
import {VaultBase} from "./vault/VaultBase.sol";
import {VaultStubs} from "./vault/VaultStubs.sol";
import {CoreLogic} from "./vault/logic/CoreLogic.sol";

/// @title CzarVault
/// @notice The per-user vault (czar-vault.md). Immutable; no proxy (D33). Every state-changing function is a thin
///         wrapper: the reentrancy guard (§15.5) stays here, the logic runs in a linked library by DELEGATECALL on
///         this vault's storage (07 PRD 03). `msg.sender` is passed as `caller`, so the passkey path can pass the owner.
contract CzarVault is VaultBase, VaultStubs {
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
}
```
- `receive()` and `sync()` have no library function: each only emits one event, and `sync` reads `_s.committedTotal` directly.
- If a stub is left behind, the build fails with `Error (9456)` and `Error (4334)` (00-conventions §3.1): delete that stub.

## 7. `src/vault/logic/CoreLogic.sol`

### 7.1 Header
- `// SPDX-License-Identifier: MIT`, `pragma solidity 0.8.30;`
- Imports, exactly:
  - `{IERC20}` from `@openzeppelin/contracts/token/ERC20/IERC20.sol`
  - `{SafeERC20}` from `@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol`
  - `{ICzarVault}` from `../../interfaces/ICzarVault.sol`
  - `{VaultState, VaultConfig}` from `../VaultState.sol`
  - `{VaultGuards}` from `../VaultGuards.sol`
  - `{MAX_PULLBACK_FEE_CEILING}` from `../../libraries/CzarConstants.sol`
- `/// @title CoreLogic` and a `/// @notice` saying: withdraw and owner settings (`czar-vault.md` §5.1, §15; T-013); linked library run by `DELEGATECALL`.
- `library CoreLogic { using SafeERC20 for IERC20; … }`
- Every function: one `/// @notice` line citing its spec section.

### 7.2 Functions, in this order
1. **`withdraw(VaultState storage s, VaultConfig memory c, address caller, address to, uint256 amount) external`** (spec §5.1, §15.2, §15.11)
   1. `VaultGuards.requireOwner(c, caller);`
   2. `if (to == address(0)) revert ICzarVault.ZeroAddress();`
   3. `if (to == address(this) || amount == 0) revert ICzarVault.BadParams();` (`address(this)` is the vault)
   4. `uint256 free = VaultGuards.freeBalance(s, c); if (amount > free) revert ICzarVault.InsufficientFree(free, amount);`
   5. `IERC20(c.usdc).safeTransfer(to, amount);`
   6. `emit ICzarVault.Withdrawn(to, amount);` (the event comes last, after the external call, 00-conventions §4.6)
2. **`setCategoryLimits(s, c, caller, bytes32 categoryId, uint256 userMax, uint256 autoLimit) external`** (spec §5.1, §15.10)
   1. `VaultGuards.requireOwner(c, caller);`
   2. `if (autoLimit > userMax) revert ICzarVault.AutoLimitAboveUserMax();`
   3. `ICzarVault.CategoryLimits storage l = s.limits[categoryId]; l.userMax = userMax; l.autoLimit = autoLimit;` (leave `usedInPeriod`, `periodId`, `lastRaiseAt` unchanged)
   4. `s.autonomyNonce++;` (D88: a raise signed before this call can never land)
   5. `emit ICzarVault.LimitsSet(categoryId, userMax, autoLimit);`
3. **`freeze(s, c, caller) external`** (spec §5.1, RV-030, §15.11)
   1. `VaultGuards.requireOwnerOrAgent(s, c, caller);`
   2. `s.frozen = true;` (no "already frozen" check: idempotent)
   3. `s.autonomyNonce++;`
   4. `emit ICzarVault.Frozen(caller);`
4. **`unfreeze(s, c, caller) external`**
   1. `VaultGuards.requireOwner(c, caller);`
   2. `s.frozen = false;`
   3. `emit ICzarVault.Unfrozen();`
5. **`rotateSigners(s, c, caller, address agent, address autonomy, address evaluator) external`** (spec §5.1, §15.11)
   1. `VaultGuards.requireOwner(c, caller);`
   2. any of the three zero → `revert ICzarVault.ZeroAddress();`
   3. `if (agent == evaluator) revert ICzarVault.BadParams();`
   4. `s.agentSigner = agent; s.autonomySigner = autonomy; s.evaluator = evaluator;`
   5. `emit ICzarVault.SignersRotated(agent, autonomy, evaluator);`
6. **`setPasskey(s, c, caller, bytes32 qx, bytes32 qy, bytes32 rpIdHash) external`** (spec §5.1, §7, §15.4)
   1. `VaultGuards.requireOwner(c, caller);`
   2. any of `qx`, `qy`, `rpIdHash` equal to `bytes32(0)` → `revert ICzarVault.BadParams();`
   3. `s.passkey = ICzarVault.Passkey({qx: qx, qy: qy, rpIdHash: rpIdHash, set: true});`
   4. `emit ICzarVault.PasskeySet(keccak256(abi.encode(qx, qy)));`
7. **`setMaxPullbackFee(s, c, caller, uint256 newMax) external`** (spec §5.1, D81)
   1. `VaultGuards.requireOwner(c, caller);`
   2. `if (newMax == 0) revert ICzarVault.BadParams();`
   3. `if (newMax > MAX_PULLBACK_FEE_CEILING) revert ICzarVault.FeeCeilingExceeded(newMax, MAX_PULLBACK_FEE_CEILING);`
   4. `uint256 oldMax = s.maxPullbackFee; s.maxPullbackFee = newMax;`
   5. `emit ICzarVault.MaxPullbackFeeSet(oldMax, newMax);`
- In the steps, `s, c, caller` stands for `VaultState storage s, VaultConfig memory c, address caller`; write the full types.

## 8. `test/VaultCoreTest.t.sol`
- 36 tests: constructor rules and the domain-separator vectors (through `CzarVaultHarness` placed at the vector vault address), every function's success path with its events, every error, the RV-011 and RV-037 named tests, and a role matrix over five callers (`czar-vault.md` §2, §15.1).
- `test_freeBalance_saturatesInSettleWindow` sets `committedTotal` with forge-std `stdstore`, because envelopes and settle are not built yet (PRD 06 adds the real settle-window test). `committedTotal` is a field of `_s` at slot 0; `stdstore` finds it through the `committedTotal()` getter.
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
1. Create `test/VaultCoreTest.t.sol` (§8). Run `FOUNDRY_PROFILE=arc arc-forge test --match-path test/VaultCoreTest.t.sol`. Expected: `10 passed; 26 failed`. The 10 constructor, constant and getter tests already pass because PRD 03 built them; 24 failures mention `NotBuilt()` (the stubs) and 2 say `assertion failed` (`test_receive_nativeCountsAsFreeBalance` and `test_roleMatrix_coreFunctions`: `receive()` does not exist yet). Paste the summary line into your report.
2. Write `src/vault/logic/CoreLogic.sol` from §7.
3. Do §6 (delete the 8 stubs, replace `CzarVault.sol`).
4. Run the test file again: 36 passed.
5. `arc-forge fmt src/vault/logic/CoreLogic.sol src/vault/VaultStubs.sol src/CzarVault.sol`, then `arc-forge fmt --check` on those files plus `test/VaultCoreTest.t.sol`: nothing printed.
6. Run the clean gate build and the full suite (00-conventions §2.2).

## 10. Definition of done
- `FOUNDRY_PROFILE=arc arc-forge test --match-contract VaultCoreTest` → 36 passed, 0 failed (T-013 acceptance command).
- `FOUNDRY_PROFILE=arc arc-forge test` → 143 passed, 0 failed.
- `rm -rf out cache && FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes` → no warnings; `CzarVault` runtime about 9,976 B and `CoreLogic` about 2,921 B (paste the lines; more than 300 B off means your code differs from §6 or §7).
- `grep -c "revert NotBuilt" src/vault/VaultStubs.sol` → 24.
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
| 2026-10-20 | D89: the logic moves from the `VaultCore` module into the linked library `CoreLogic`; the getters moved to PRD 03; 8 stubs deleted here (was 19); new `CzarVault.sol`; red phase 10 passed / 26 failed; sizes re-measured. The test file is unchanged. |
| 2026-10-20 | `withdraw`: the event comes after `safeTransfer` (00-conventions §4.6, review). |
