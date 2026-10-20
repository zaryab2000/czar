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
