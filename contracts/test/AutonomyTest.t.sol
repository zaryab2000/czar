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
