// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockUSDC3009} from "./mocks/MockUSDC3009.sol";
import {MockGatewayWallet} from "./mocks/MockGatewayWallet.sol";
import {MockGatewayMinter} from "./mocks/MockGatewayMinter.sol";
import {MockCircleAgenticCommerce} from "./mocks/MockCircleAgenticCommerce.sol";
import {MockCzarJobEscrow} from "./mocks/MockCzarJobEscrow.sol";

/// @dev ERC-1271 wallet whose answer the test sets: the magic value, a wrong value, a short return or a revert.
contract ScriptedWallet {
    enum Mode {
        Magic,
        WrongValue,
        ShortReturn,
        Revert
    }

    Mode public mode;

    function setMode(Mode m) external {
        mode = m;
    }

    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        if (mode == Mode.Magic) return 0x1626ba7e;
        if (mode == Mode.WrongValue) return 0xffffffff;
        if (mode == Mode.ShortReturn) {
            assembly ("memory-safe") {
                mstore(0, 0x1626ba7e)
                return(28, 4)
            }
        }
        revert("no");
    }
}

contract MockSelfTest is Test {
    // A1-01: Arc USDC address; A1-03: domain separator for chain 5042002 (02 vectors `USDC_5042002`).
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    bytes32 internal constant USDC_DOMAIN_5042002 = 0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0;
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;
    uint256 internal constant ONE_USDC = 1_000_000;

    MockUSDC3009 internal usdc;
    ScriptedWallet internal wallet;
    uint256 internal alicePk = 0xA11CE;
    address internal alice;
    address internal bob = address(0xB0B);

    function setUp() public {
        vm.warp(1_760_000_000);
        usdc = new MockUSDC3009();
        wallet = new ScriptedWallet();
        alice = vm.addr(alicePk);
        usdc.mint(alice, 10 * ONE_USDC);
        usdc.mint(address(wallet), 10 * ONE_USDC);
    }

    // ─────────────── USDC: EIP-3009 with ERC-1271 (A1-08, A1-09) ───────────────

    function _digest(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, validAfter, validBefore, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
    }

    function _eoaSig(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_usdc_domainSeparatorMatchesArcTestnet() public {
        vm.chainId(ARC_TESTNET_CHAIN_ID);
        vm.etch(ARC_USDC, address(usdc).code);
        assertEq(MockUSDC3009(ARC_USDC).DOMAIN_SEPARATOR(), USDC_DOMAIN_5042002);
        assertEq(MockUSDC3009(ARC_USDC).decimals(), 6);
    }

    function test_usdc_eoaBytesOverloadTransfers() public {
        bytes32 nonce = keccak256("n1");
        uint256 validBefore = block.timestamp + 60;
        bytes memory sig = _eoaSig(_digest(alice, bob, ONE_USDC, 0, validBefore, nonce));
        vm.expectEmit(true, true, false, false, address(usdc));
        emit MockUSDC3009.AuthorizationUsed(alice, nonce);
        usdc.transferWithAuthorization(alice, bob, ONE_USDC, 0, validBefore, nonce, sig);
        assertEq(usdc.balanceOf(bob), ONE_USDC);
        assertTrue(usdc.authorizationState(alice, nonce));
    }

    function test_usdc_eoaVrsOverloadTransfers() public {
        bytes32 nonce = keccak256("n2");
        uint256 validBefore = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, _digest(alice, bob, ONE_USDC, 0, validBefore, nonce));
        usdc.transferWithAuthorization(alice, bob, ONE_USDC, 0, validBefore, nonce, v, r, s);
        assertEq(usdc.balanceOf(bob), ONE_USDC);
    }

    function test_usdc_rejectsReusedNonce() public {
        bytes32 nonce = keccak256("reuse");
        uint256 validBefore = block.timestamp + 60;
        bytes memory sig = _eoaSig(_digest(alice, bob, ONE_USDC, 0, validBefore, nonce));
        usdc.transferWithAuthorization(alice, bob, ONE_USDC, 0, validBefore, nonce, sig);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        usdc.transferWithAuthorization(alice, bob, ONE_USDC, 0, validBefore, nonce, sig);
    }

    function test_usdc_rejectsExpiredAuthorization() public {
        bytes32 nonce = keccak256("expired");
        uint256 validBefore = block.timestamp + 60;
        bytes memory sig = _eoaSig(_digest(alice, bob, ONE_USDC, 0, validBefore, nonce));
        vm.warp(validBefore); // `now < validBefore` is strict
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        usdc.transferWithAuthorization(alice, bob, ONE_USDC, 0, validBefore, nonce, sig);
    }

    function test_usdc_rejectsNotYetValidAuthorization() public {
        bytes32 nonce = keccak256("early");
        uint256 validAfter = block.timestamp; // `now > validAfter` is strict
        bytes memory sig = _eoaSig(_digest(alice, bob, ONE_USDC, validAfter, validAfter + 60, nonce));
        vm.expectRevert(bytes("FiatTokenV2: authorization is not yet valid"));
        usdc.transferWithAuthorization(alice, bob, ONE_USDC, validAfter, validAfter + 60, nonce, sig);
    }

    function test_usdc_contractSignerAcceptedOnlyWithMagicValue() public {
        uint256 validBefore = block.timestamp + 60;
        bytes memory longSig = new bytes(200); // contract signatures are longer than 65 bytes (A1-20)
        usdc.transferWithAuthorization(address(wallet), bob, ONE_USDC, 0, validBefore, keccak256("w0"), longSig);
        assertEq(usdc.balanceOf(bob), ONE_USDC);

        ScriptedWallet.Mode[3] memory bad =
            [ScriptedWallet.Mode.WrongValue, ScriptedWallet.Mode.ShortReturn, ScriptedWallet.Mode.Revert];
        for (uint256 i = 0; i < bad.length; i++) {
            wallet.setMode(bad[i]);
            bytes32 nonce = keccak256(abi.encode("w", i));
            vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
            usdc.transferWithAuthorization(address(wallet), bob, ONE_USDC, 0, validBefore, nonce, longSig);
            assertFalse(usdc.authorizationState(address(wallet), nonce));
        }
    }

    function test_usdc_contractSignerReceivesDigestAndSignature() public {
        wallet.setMode(ScriptedWallet.Mode.Magic);
        bytes32 digest = _digest(address(wallet), bob, ONE_USDC, 0, block.timestamp + 60, keccak256("sc"));
        vm.expectCall(address(wallet), abi.encodeWithSelector(ScriptedWallet.isValidSignature.selector, digest, bytes("x")));
        usdc.transferWithAuthorization(address(wallet), bob, ONE_USDC, 0, block.timestamp + 60, keccak256("sc"), bytes("x"));
    }

    function test_usdc_rejectsWrongEoaSigner() public {
        bytes32 nonce = keccak256("wrong");
        uint256 validBefore = block.timestamp + 60;
        bytes memory sig = _eoaSig(_digest(alice, bob, ONE_USDC, 0, validBefore, nonce));
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(alice, bob, 2 * ONE_USDC, 0, validBefore, nonce, sig);
    }

    function test_usdc_pauseAndBlacklistBlockTransfers() public {
        bytes32 nonce = keccak256("p");
        uint256 validBefore = block.timestamp + 60;
        bytes memory sig = _eoaSig(_digest(alice, bob, ONE_USDC, 0, validBefore, nonce));
        usdc.pause();
        vm.expectRevert(bytes("Pausable: paused"));
        usdc.transferWithAuthorization(alice, bob, ONE_USDC, 0, validBefore, nonce, sig);
        usdc.unpause();
        usdc.blacklist(bob);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        usdc.transferWithAuthorization(alice, bob, ONE_USDC, 0, validBefore, nonce, sig);
        usdc.unBlacklist(bob);
        usdc.transferWithAuthorization(alice, bob, ONE_USDC, 0, validBefore, nonce, sig);
    }

    function test_usdc_receiveRequiresPayeeCaller() public {
        bytes32 nonce = keccak256("r");
        uint256 validBefore = block.timestamp + 60;
        bytes32 structHash = keccak256(
            abi.encode(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), alice, bob, ONE_USDC, 0, validBefore, nonce)
        );
        bytes memory sig = _eoaSig(keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        vm.expectRevert(bytes("FiatTokenV2: caller must be the payee"));
        usdc.receiveWithAuthorization(alice, bob, ONE_USDC, 0, validBefore, nonce, sig);
        vm.prank(bob);
        usdc.receiveWithAuthorization(alice, bob, ONE_USDC, 0, validBefore, nonce, sig);
        assertEq(usdc.balanceOf(bob), ONE_USDC);
    }

    // ─────────────── Gateway (A2-02, A2-04, A2-05, AR-15) ───────────────

    function test_gateway_depositForCreditsDepositor() public {
        MockGatewayWallet gw = new MockGatewayWallet(address(usdc));
        address pocket = address(0xF0C);
        vm.startPrank(alice);
        usdc.approve(address(gw), ONE_USDC);
        vm.expectEmit(true, true, true, true, address(gw));
        emit MockGatewayWallet.Deposited(address(usdc), pocket, alice, ONE_USDC);
        gw.depositFor(address(usdc), pocket, ONE_USDC);
        vm.stopPrank();
        assertEq(gw.availableBalance(address(usdc), pocket), ONE_USDC);
        assertEq(usdc.balanceOf(address(gw)), ONE_USDC);
    }

    function test_gateway_depositForRejectsZeroAndBlacklistedDepositor() public {
        MockGatewayWallet gw = new MockGatewayWallet(address(usdc));
        vm.prank(alice);
        usdc.approve(address(gw), ONE_USDC);
        vm.prank(alice);
        vm.expectRevert(MockGatewayWallet.InvalidAddress.selector);
        gw.depositFor(address(usdc), address(0), ONE_USDC);
        usdc.blacklist(bob);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockGatewayWallet.DepositorIsBlacklisted.selector, bob));
        gw.depositFor(address(usdc), bob, ONE_USDC);
        vm.prank(alice);
        vm.expectRevert(MockGatewayWallet.DepositValueMustBePositive.selector);
        gw.depositFor(address(usdc), address(0xF0C), 0);
    }

    function test_gateway_delegateLifecycle() public {
        MockGatewayWallet gw = new MockGatewayWallet(address(usdc));
        address pocket = address(0xF0C);
        address vault = address(0xCA11);
        assertTrue(gw.isAuthorizedForBalance(address(usdc), pocket, pocket));
        assertFalse(gw.isAuthorizedForBalance(address(usdc), pocket, vault));
        vm.startPrank(pocket);
        gw.addDelegate(address(usdc), vault);
        assertTrue(gw.isAuthorizedForBalance(address(usdc), pocket, vault));
        vm.expectRevert(MockGatewayWallet.CannotDelegateToSelf.selector);
        gw.addDelegate(address(usdc), pocket);
        gw.removeDelegate(address(usdc), vault);
        vm.stopPrank();
        assertFalse(gw.isAuthorizedForBalance(address(usdc), pocket, vault));
    }

    function test_minter_transferSpecHashReplaySet() public {
        MockGatewayMinter minter = new MockGatewayMinter();
        bytes32 specHash = keccak256("spec");
        assertFalse(minter.isTransferSpecHashUsed(specHash));
        minter.testMarkTransferSpecHashUsed(specHash);
        assertTrue(minter.isTransferSpecHashUsed(specHash));
        vm.expectRevert(abi.encodeWithSelector(MockGatewayMinter.TransferSpecHashUsed.selector, specHash));
        minter.testMarkTransferSpecHashUsed(specHash);
    }

    // ─────────────── ERC-8183, Circle testnet ABI (A4-05, A4-06) ───────────────

    address internal provider = address(0xBEEF);
    address internal evaluator = address(0xE7A1);

    function test_circle8183_completePaysProvider() public {
        MockCircleAgenticCommerce acp = new MockCircleAgenticCommerce(address(usdc), address(0x7EA5));
        vm.prank(alice);
        uint256 jobId = acp.createJob(provider, evaluator, block.timestamp + 1 hours, "brief", address(0));
        vm.prank(provider);
        acp.setBudget(jobId, ONE_USDC, "");
        vm.startPrank(alice);
        usdc.approve(address(acp), ONE_USDC);
        acp.fund(jobId, "");
        vm.stopPrank();
        vm.prank(provider);
        acp.submit(jobId, keccak256("deliverable"), "");
        vm.prank(evaluator);
        acp.complete(jobId, keccak256("report"), "");
        assertEq(usdc.balanceOf(provider), ONE_USDC);
        (,,,,, uint256 budget,, MockCircleAgenticCommerce.JobStatus status,) = acp.jobs(jobId);
        assertEq(budget, ONE_USDC);
        assertEq(uint8(status), uint8(MockCircleAgenticCommerce.JobStatus.Completed));
    }

    function test_circle8183_fundHasNoBudgetCheck() public {
        // A4-05: a provider can raise the budget before `fund`, and fund pulls the new amount.
        MockCircleAgenticCommerce acp = new MockCircleAgenticCommerce(address(usdc), address(0x7EA5));
        vm.prank(alice);
        uint256 jobId = acp.createJob(provider, evaluator, block.timestamp + 1 hours, "brief", address(0));
        vm.prank(provider);
        acp.setBudget(jobId, ONE_USDC, "");
        vm.prank(provider);
        acp.setBudget(jobId, 2 * ONE_USDC, "");
        vm.startPrank(alice);
        usdc.approve(address(acp), 2 * ONE_USDC);
        acp.fund(jobId, "");
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(acp)), 2 * ONE_USDC);
    }

    function test_circle8183_claimRefundByAnyoneAfterExpiry() public {
        MockCircleAgenticCommerce acp = new MockCircleAgenticCommerce(address(usdc), address(0x7EA5));
        vm.prank(alice);
        uint256 jobId = acp.createJob(provider, evaluator, block.timestamp + 1 hours, "brief", address(0));
        vm.prank(provider);
        acp.setBudget(jobId, ONE_USDC, "");
        vm.startPrank(alice);
        usdc.approve(address(acp), ONE_USDC);
        acp.fund(jobId, "");
        vm.stopPrank();
        vm.expectRevert(MockCircleAgenticCommerce.WrongStatus.selector);
        acp.claimRefund(jobId);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(address(0xD00D));
        acp.claimRefund(jobId);
        assertEq(usdc.balanceOf(alice), 10 * ONE_USDC);
    }

    function test_circle8183_onlyNoHookAllowed() public {
        MockCircleAgenticCommerce acp = new MockCircleAgenticCommerce(address(usdc), address(0x7EA5));
        vm.expectRevert(MockCircleAgenticCommerce.HookNotWhitelisted.selector);
        acp.createJob(provider, evaluator, block.timestamp + 1 hours, "brief", address(0x400C));
    }

    // ─────────────── ERC-8183, base-contracts ABI (RV-009) ───────────────

    function _czarFundedJob(MockCzarJobEscrow escrow, uint256 budget) internal returns (uint256 jobId) {
        escrow.setPaymentTokenAllowed(address(usdc), true);
        vm.prank(alice);
        jobId = escrow.createJob(provider, evaluator, uint48(block.timestamp + 1 hours), "brief", address(0), 0);
        vm.prank(provider);
        escrow.setBudget(jobId, address(usdc), budget, "");
        vm.startPrank(alice);
        usdc.approve(address(escrow), budget);
        escrow.fund(jobId, address(usdc), budget, "");
        vm.stopPrank();
    }

    function test_czar8183_fundChecksExpectedBudget() public {
        MockCzarJobEscrow escrow = new MockCzarJobEscrow(address(0x7EA5), address(this));
        escrow.setPaymentTokenAllowed(address(usdc), true);
        vm.prank(alice);
        uint256 jobId = escrow.createJob(provider, evaluator, uint48(block.timestamp + 1 hours), "brief", address(0), 0);
        vm.prank(provider);
        escrow.setBudget(jobId, address(usdc), 2 * ONE_USDC, "");
        vm.startPrank(alice);
        usdc.approve(address(escrow), 2 * ONE_USDC);
        vm.expectRevert(MockCzarJobEscrow.BudgetMismatch.selector);
        escrow.fund(jobId, address(usdc), ONE_USDC, "");
        vm.expectRevert(MockCzarJobEscrow.PaymentTokenMismatch.selector);
        escrow.fund(jobId, address(0x1234), 2 * ONE_USDC, "");
        vm.stopPrank();
    }

    function test_czar8183_partialClaimThenRefundOfRemainder() public {
        MockCzarJobEscrow escrow = new MockCzarJobEscrow(address(0x7EA5), address(this));
        uint256 jobId = _czarFundedJob(escrow, 3 * ONE_USDC);
        bytes32 deliverable = keccak256("part-1");
        vm.prank(provider);
        escrow.submitClaim(jobId, ONE_USDC, deliverable, "");
        vm.prank(evaluator);
        escrow.approveClaim(jobId, ONE_USDC, deliverable, "");
        assertEq(escrow.getJob(jobId).settledAmount, ONE_USDC);
        assertEq(usdc.balanceOf(provider), ONE_USDC);

        vm.warp(block.timestamp + 1 hours);
        escrow.claimRefund(jobId);
        assertEq(usdc.balanceOf(alice), 10 * ONE_USDC - ONE_USDC);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(MockCzarJobEscrow.JobStatus.Expired));
    }

    function test_czar8183_claimRefundFromOpen() public {
        MockCzarJobEscrow escrow = new MockCzarJobEscrow(address(0x7EA5), address(this));
        vm.prank(alice);
        uint256 jobId = escrow.createJob(provider, evaluator, uint48(block.timestamp + 1 hours), "brief", address(0), 0);
        vm.expectRevert(MockCzarJobEscrow.WrongStatus.selector);
        escrow.claimRefund(jobId);
        vm.warp(block.timestamp + 1 hours);
        escrow.claimRefund(jobId);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(MockCzarJobEscrow.JobStatus.Expired));
    }

    function test_czar8183_submittedRefundWaitsForGracePeriod() public {
        MockCzarJobEscrow escrow = new MockCzarJobEscrow(address(0x7EA5), address(this));
        uint256 jobId = _czarFundedJob(escrow, ONE_USDC);
        vm.prank(provider);
        escrow.submit(jobId, keccak256("d"), "");
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(MockCzarJobEscrow.GracePeriodActive.selector);
        escrow.claimRefund(jobId);
        vm.warp(block.timestamp + escrow.EVALUATION_GRACE_PERIOD());
        escrow.claimRefund(jobId);
        assertEq(usdc.balanceOf(alice), 10 * ONE_USDC);
    }

    function test_czar8183_completePaysOnlyTheUnsettledRemainder() public {
        MockCzarJobEscrow escrow = new MockCzarJobEscrow(address(0x7EA5), address(this));
        uint256 jobId = _czarFundedJob(escrow, 3 * ONE_USDC);
        vm.prank(alice);
        escrow.settleClaim(jobId, ONE_USDC, keccak256("p1"), "");
        vm.prank(provider);
        escrow.submit(jobId, keccak256("final"), "");
        vm.prank(evaluator);
        escrow.complete(jobId, keccak256("report"), "");
        assertEq(usdc.balanceOf(provider), 3 * ONE_USDC);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }
}
