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
