// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {MockUSDC3009} from "./mocks/MockUSDC3009.sol";
import {MockGatewayWallet} from "./mocks/MockGatewayWallet.sol";
import {MockGatewayMinter} from "./mocks/MockGatewayMinter.sol";

/// @notice SCR-150 §1–§4: the Gateway test doubles used on a CLEAN local chain. Covers constructor-free placement
///         (`testInitialize` after copying runtime code), the trustless withdrawal (A2-13 to A2-15) and the local
///         attestation accepted by `gatewayMint`.
contract GatewayDoublesTest is Test {
    uint256 internal constant ONE_USDC = 1_000_000;
    /// @dev Canonical addresses from contracts/script/Deploy.s.sol:21-22 (A2-01).
    address internal constant CANONICAL_GATEWAY_WALLET = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9;
    address internal constant CANONICAL_GATEWAY_MINTER = 0x0022222ABE238Cc2C7Bb1f21003F0a260052475B;

    MockUSDC3009 internal usdc;
    MockGatewayWallet internal gw;
    MockGatewayMinter internal minter;
    address internal pocket = address(0xF0C);
    address internal vault = address(0xCA11);

    function setUp() public {
        usdc = new MockUSDC3009();
        gw = new MockGatewayWallet(address(usdc));
        minter = new MockGatewayMinter();
        minter.testInitialize(address(usdc));
        usdc.mint(pocket, 10 * ONE_USDC);
        vm.startPrank(pocket);
        usdc.approve(address(gw), 5 * ONE_USDC);
        gw.deposit(address(usdc), 5 * ONE_USDC);
        vm.stopPrank();
    }

    // ─────────────── Storage layout ───────────────

    /// @dev `isTokenSupported` must stay at slot 1: replay-anvil.test.ts writes keccak256(abi.encode(token, 1))
    ///      with anvil_setStorageAt after copying the runtime code, and SCR-150 state is appended after it.
    function test_layout_isTokenSupportedStaysAtSlot1() public {
        vm.etch(CANONICAL_GATEWAY_WALLET, address(gw).code);
        MockGatewayWallet placed = MockGatewayWallet(CANONICAL_GATEWAY_WALLET);
        assertFalse(placed.isTokenSupported(address(usdc)));
        vm.store(CANONICAL_GATEWAY_WALLET, keccak256(abi.encode(address(usdc), uint256(1))), bytes32(uint256(1)));
        assertTrue(placed.isTokenSupported(address(usdc)));
    }

    /// @dev `_usedHashes` must stay at slot 0: replay-anvil.test.ts writes keccak256(abi.encode(hash, 0)).
    function test_layout_minterUsedHashesStaysAtSlot0() public {
        bytes32 specHash = keccak256("layout");
        assertFalse(minter.isTransferSpecHashUsed(specHash));
        vm.store(address(minter), keccak256(abi.encode(specHash, uint256(0))), bytes32(uint256(1)));
        assertTrue(minter.isTransferSpecHashUsed(specHash));
    }

    // ─────────────── Placement (SCR-150 §1) ───────────────

    function test_placement_copiedCodeNeedsInitializeOnce() public {
        vm.etch(CANONICAL_GATEWAY_WALLET, address(gw).code);
        MockGatewayWallet placed = MockGatewayWallet(CANONICAL_GATEWAY_WALLET);
        assertFalse(placed.initialized());
        assertFalse(placed.isTokenSupported(address(usdc)));
        placed.testInitialize(address(usdc));
        assertTrue(placed.isTokenSupported(address(usdc)));
        assertEq(placed.withdrawalDelay(), placed.DEFAULT_WITHDRAWAL_DELAY_BLOCKS());
        vm.expectRevert(MockGatewayWallet.AlreadyInitialized.selector);
        placed.testInitialize(address(usdc));
    }

    function test_placement_onlyControllerInitializes() public {
        vm.etch(CANONICAL_GATEWAY_WALLET, address(gw).code);
        vm.prank(address(0xBAD));
        vm.expectRevert("MockGatewayWallet: caller is not the controller");
        MockGatewayWallet(CANONICAL_GATEWAY_WALLET).testInitialize(address(usdc));

        vm.etch(CANONICAL_GATEWAY_MINTER, address(new MockGatewayMinter()).code);
        vm.prank(address(0xBAD));
        vm.expectRevert("MockGatewayMinter: caller is not the controller");
        MockGatewayMinter(CANONICAL_GATEWAY_MINTER).testInitialize(address(usdc));
    }

    function test_placement_constructedWalletIsAlreadyInitialized() public {
        assertTrue(gw.initialized());
        vm.expectRevert(MockGatewayWallet.AlreadyInitialized.selector);
        gw.testInitialize(address(usdc));
    }

    function test_placement_minterInitializeOnce() public {
        vm.expectRevert(MockGatewayMinter.AlreadyInitialized.selector);
        minter.testInitialize(address(usdc));
    }

    // ─────────────── Trustless withdrawal (SCR-150 §2, A2-13 to A2-15) ───────────────

    function test_withdrawal_initiateMovesAvailableToWithdrawing() public {
        vm.prank(pocket);
        gw.initiateWithdrawal(address(usdc), 2 * ONE_USDC);
        assertEq(gw.availableBalance(address(usdc), pocket), 3 * ONE_USDC);
        assertEq(gw.withdrawingBalance(address(usdc), pocket), 2 * ONE_USDC);
        assertEq(gw.withdrawalBlock(address(usdc), pocket), block.number + gw.DEFAULT_WITHDRAWAL_DELAY_BLOCKS());
    }

    function test_withdrawal_repeatAddsAmountAndResetsTimer() public {
        vm.prank(pocket);
        gw.initiateWithdrawal(address(usdc), ONE_USDC);
        uint256 firstBlock = gw.withdrawalBlock(address(usdc), pocket);
        vm.roll(block.number + 5);
        vm.prank(pocket);
        gw.initiateWithdrawal(address(usdc), ONE_USDC);
        assertEq(gw.withdrawingBalance(address(usdc), pocket), 2 * ONE_USDC);
        assertEq(gw.withdrawalBlock(address(usdc), pocket), firstBlock + 5);
    }

    function test_withdrawal_earlyWithdrawReverts() public {
        vm.prank(pocket);
        gw.initiateWithdrawal(address(usdc), ONE_USDC);
        vm.roll(gw.withdrawalBlock(address(usdc), pocket) - 1);
        vm.prank(pocket);
        vm.expectRevert(MockGatewayWallet.WithdrawalNotYetAvailable.selector);
        gw.withdraw(address(usdc));
    }

    function test_withdrawal_withdrawPaysDepositorAndZeroes() public {
        uint256 before = usdc.balanceOf(pocket);
        vm.prank(pocket);
        gw.initiateWithdrawal(address(usdc), 2 * ONE_USDC);
        vm.roll(gw.withdrawalBlock(address(usdc), pocket));
        vm.prank(pocket);
        gw.withdraw(address(usdc));
        assertEq(usdc.balanceOf(pocket), before + 2 * ONE_USDC);
        assertEq(gw.withdrawingBalance(address(usdc), pocket), 0);
        assertEq(gw.withdrawalBlock(address(usdc), pocket), 0);
        vm.prank(pocket);
        vm.expectRevert(MockGatewayWallet.NoWithdrawingBalance.selector);
        gw.withdraw(address(usdc));
    }

    function test_withdrawal_rejectsZeroAndExcess() public {
        vm.startPrank(pocket);
        vm.expectRevert(MockGatewayWallet.WithdrawalValueMustBePositive.selector);
        gw.initiateWithdrawal(address(usdc), 0);
        vm.expectRevert(MockGatewayWallet.InsufficientBalance.selector);
        gw.initiateWithdrawal(address(usdc), 6 * ONE_USDC);
        vm.stopPrank();
    }

    function test_withdrawal_delayIsControllerSet() public {
        gw.testSetWithdrawalDelay(3);
        vm.prank(pocket);
        gw.initiateWithdrawal(address(usdc), ONE_USDC);
        assertEq(gw.withdrawalBlock(address(usdc), pocket), block.number + 3);
        vm.prank(address(0xBAD));
        vm.expectRevert("MockGatewayWallet: caller is not the controller");
        gw.testSetWithdrawalDelay(1);
    }

    // ─────────────── Local attestation mint (SCR-150 §3, §4) ───────────────

    function _attestation(bytes32 specHash, uint256 value) internal view returns (bytes memory) {
        return abi.encode(specHash, vault, value, pocket);
    }

    function test_mint_paysRecipientAndMarksUsed() public {
        bytes32 specHash = keccak256("spec-1");
        // The stand-in moves value + fee from the depositor into the minter with testBurn before the mint.
        gw.testBurn(address(usdc), pocket, ONE_USDC, address(minter));
        vm.expectEmit(true, true, true, true, address(minter));
        emit MockGatewayMinter.AttestationUsed(
            address(usdc), vault, specHash, 26, bytes32(uint256(uint160(pocket))), bytes32(0), ONE_USDC
        );
        minter.gatewayMint(_attestation(specHash, ONE_USDC), new bytes(65));
        assertEq(usdc.balanceOf(vault), ONE_USDC);
        assertTrue(minter.isTransferSpecHashUsed(specHash));
        assertEq(gw.availableBalance(address(usdc), pocket), 4 * ONE_USDC);
    }

    function test_mint_doubleMintReverts() public {
        bytes32 specHash = keccak256("spec-2");
        gw.testBurn(address(usdc), pocket, 2 * ONE_USDC, address(minter));
        minter.gatewayMint(_attestation(specHash, ONE_USDC), "");
        vm.expectRevert(abi.encodeWithSelector(MockGatewayMinter.TransferSpecHashUsed.selector, specHash));
        minter.gatewayMint(_attestation(specHash, ONE_USDC), "");
        assertEq(usdc.balanceOf(vault), ONE_USDC);
    }

    function test_mint_isPermissionless() public {
        bytes32 specHash = keccak256("spec-3");
        gw.testBurn(address(usdc), pocket, ONE_USDC, address(minter));
        vm.prank(address(0xA11));
        minter.gatewayMint(_attestation(specHash, ONE_USDC), "");
        assertEq(usdc.balanceOf(vault), ONE_USDC);
    }

    /// @dev PR #122 P2: the indexer's registered Circle ABI (`apps/indexer/src/external-abis.ts`) decodes this topic.
    function test_mint_attestationUsedTopicMatchesCircleAbi() public {
        bytes32 specHash = keccak256("spec-topic");
        gw.testBurn(address(usdc), pocket, ONE_USDC, address(minter));
        vm.recordLogs();
        minter.gatewayMint(_attestation(specHash, ONE_USDC), "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 circleTopic = keccak256("AttestationUsed(address,address,bytes32,uint32,bytes32,bytes32,uint256)");
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(minter)) continue;
            assertEq(logs[i].topics[0], circleTopic);
            assertEq(logs[i].topics[3], specHash);
            found = true;
        }
        assertTrue(found);
    }

    // ─────────────── Per-spec idempotent burn (SCR-150 §4, PR #122 P1) ───────────────

    function test_burnForSpec_debitsOnceAndRecords() public {
        bytes32 specHash = keccak256("burn-1");
        gw.testBurnForTransferSpec(specHash, address(usdc), pocket, ONE_USDC, address(minter));
        gw.testBurnForTransferSpec(specHash, address(usdc), pocket, ONE_USDC, address(minter));
        assertEq(gw.availableBalance(address(usdc), pocket), 4 * ONE_USDC);
        assertEq(usdc.balanceOf(address(minter)), ONE_USDC);
        (address token, address depositor, uint256 value, address recipient) = gw.burnRecord(specHash);
        assertEq(token, address(usdc));
        assertEq(depositor, pocket);
        assertEq(value, ONE_USDC);
        assertEq(recipient, address(minter));
    }

    function test_burnForSpec_mismatchReverts() public {
        bytes32 specHash = keccak256("burn-2");
        gw.testBurnForTransferSpec(specHash, address(usdc), pocket, ONE_USDC, address(minter));
        vm.expectRevert(abi.encodeWithSelector(MockGatewayWallet.BurnRecordMismatch.selector, specHash));
        gw.testBurnForTransferSpec(specHash, address(usdc), pocket, 2 * ONE_USDC, address(minter));
        assertEq(gw.availableBalance(address(usdc), pocket), 4 * ONE_USDC);
    }

    function test_burnForSpec_repeatSucceedsAfterBalanceDrained() public {
        bytes32 specHash = keccak256("burn-3");
        gw.testBurnForTransferSpec(specHash, address(usdc), pocket, 5 * ONE_USDC, address(minter));
        assertEq(gw.availableBalance(address(usdc), pocket), 0);
        gw.testBurnForTransferSpec(specHash, address(usdc), pocket, 5 * ONE_USDC, address(minter));
        assertEq(usdc.balanceOf(address(minter)), 5 * ONE_USDC);
    }

    function test_burnForSpec_onlyController() public {
        vm.prank(address(0xBAD));
        vm.expectRevert("MockGatewayWallet: caller is not the controller");
        gw.testBurnForTransferSpec(keccak256("burn-4"), address(usdc), pocket, ONE_USDC, address(minter));
    }

    function test_mint_uninitializedMinterReverts() public {
        MockGatewayMinter fresh = new MockGatewayMinter();
        vm.expectRevert(MockGatewayMinter.NotInitialized.selector);
        fresh.gatewayMint(_attestation(keccak256("spec-4"), ONE_USDC), "");
    }
}
