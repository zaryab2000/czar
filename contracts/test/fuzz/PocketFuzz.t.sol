// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../../src/interfaces/ICzarVault.sol";
import {
    USDC_ADDRESS,
    BPS,
    FORCE_CLOSE_DELAY,
    PULLBACK_CANCEL_DELAY_BLOCKS
} from "../../src/libraries/CzarConstants.sol";
import {VaultTestBase} from "../helpers/VaultTestBase.sol";
import {PayeeTree} from "../helpers/PayeeTree.sol";

/// @dev 07 PRD 12 (T-021; security-and-testing.md §3.2): random pocket fund / pullback / mint / confirm / cancel /
///      write-off sequences interleaved with owner withdrawals, manual returns and a force-close. After every step:
///      INV-2 (committedTotal recomputed; ≤ balance), INV-7 and INV-14 (RV-005, RV-011, RV-036). Rounding of the
///      pocket cap: funding exactly cap × bps / BPS succeeds, one unit more reverts.
contract PocketFuzz is VaultTestBase, PayeeTree {
    uint256 internal constant FEE = 3_500;
    uint256 internal constant STEPS = 12;
    uint16 internal constant POCKET_BPS = 2500;

    address internal pocket = POCKET_B0C0;
    address internal feeSink = makeAddr("gatewayFees");
    uint64 internal env;
    uint64[] internal pullbackIds;

    function setUp() public override {
        super.setUp();
        _fundVault(20 * ONE_USDC);
        env = _openEnvelope(4 * ONE_USDC, POCKET_BPS);
        bytes32[] memory proof = _proofB0c0();
        vm.prank(agent);
        vault.registerPocket(env, pocket, proof);
        vm.prank(pocket);
        gatewayWallet.addDelegate(USDC_ADDRESS, address(vault));
    }

    function _openEnvelope(uint256 cap, uint16 bps) internal returns (uint64 id) {
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = cap;
        p.maxStepAmount = ONE_USDC;
        p.pocketCapBps = bps;
        p.expiresAt = uint64(block.timestamp + 1 days);
        p.categoryId = keccak256("category");
        p.payeeRoot = PAYEE_ROOT;
        vm.prank(owner);
        id = vault.openEnvelope(p);
    }

    /// @dev INV-2, INV-7, INV-14 for the one envelope and its pocket.
    function _assertInvariants() internal view {
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        uint256 expected = e.state == ICzarVault.EnvelopeState.Open
            ? e.cap - e.spent - e.pocketOutstanding - e.jobEscrowed - e.shortfall
            : 0;
        assertEq(vault.committedTotal(), expected, "INV-2 sum");
        assertLe(vault.committedTotal(), usdc.balanceOf(address(vault)), "INV-2 balance");
        ICzarVault.Pocket memory k = vault.getPocket(pocket);
        if (k.state != ICzarVault.PocketState.Closed) {
            assertLe(k.pendingPullback, k.outstanding, "INV-7 pending");
            assertLe(k.outstanding, k.funded, "INV-7 outstanding");
            assertLe(k.funded, e.cap * e.pocketCapBps / BPS, "INV-7 funded");
        } else {
            assertEq(k.outstanding, 0, "INV-7 closed outstanding");
            uint256 pendingSum;
            for (uint256 i = 0; i < pullbackIds.length; i++) {
                ICzarVault.Pullback memory p = vault.getPullback(pullbackIds[i]);
                if (p.state == ICzarVault.PullbackState.Pending && !p.recovery) pendingSum += p.value;
            }
            assertEq(k.pendingPullback, pendingSum, "INV-7 closed pending");
        }
        assertEq(vault.envelopePocket(env), pocket, "INV-14 one pocket");
        if (e.state == ICzarVault.EnvelopeState.Closed) {
            assertEq(uint8(k.state), uint8(ICzarVault.PocketState.Closed), "INV-14 closed envelope");
        }
    }

    function _step(uint8 op, uint256 amount) internal {
        ICzarVault.Pocket memory k = vault.getPocket(pocket);
        if (op == 0) {
            // fund within the remaining pocket cap
            ICzarVault.Envelope memory e = vault.getEnvelope(env);
            uint256 room = e.cap * e.pocketCapBps / BPS - k.funded;
            if (room == 0) return;
            vm.prank(agent);
            try vault.fundPocket(pocket, bound(amount, 1, room)) {} catch {}
        } else if (op == 1) {
            // request a pullback, leaving the Gateway fee in the pocket (a Closed pocket gets a recovery record, RV-004)
            uint256 room = k.state == ICzarVault.PocketState.Closed ? ONE_USDC + FEE : k.outstanding - k.pendingPullback;
            if (room <= FEE) return;
            uint256 maxBlock = block.number + 50;
            vm.prank(agent);
            try vault.requestPullback(pocket, bound(amount, 1, room - FEE), FEE, maxBlock) returns (uint64 id) {
                pullbackIds.push(id);
            } catch {}
        } else if (op == 2 && pullbackIds.length > 0) {
            // Circle mints a Pending record (burns value + fee, marks the hash used)
            ICzarVault.Pullback memory p = vault.getPullback(pullbackIds[amount % pullbackIds.length]);
            if (p.state != ICzarVault.PullbackState.Pending || block.number > p.maxBlockHeight) return;
            if (gatewayWallet.availableBalance(USDC_ADDRESS, pocket) < p.value + FEE) return;
            if (gatewayMinter.isTransferSpecHashUsed(p.transferSpecHash)) return;
            gatewayWallet.testBurn(USDC_ADDRESS, pocket, p.value, address(vault));
            gatewayWallet.testBurn(USDC_ADDRESS, pocket, FEE, feeSink);
            gatewayMinter.testMarkTransferSpecHashUsed(p.transferSpecHash);
        } else if (op == 3 && pullbackIds.length > 0) {
            try vault.confirmPullback(pullbackIds[amount % pullbackIds.length]) {} catch {}
        } else if (op == 4 && pullbackIds.length > 0) {
            ICzarVault.Pullback memory p = vault.getPullback(pullbackIds[amount % pullbackIds.length]);
            if (block.number < p.maxBlockHeight + PULLBACK_CANCEL_DELAY_BLOCKS) {
                vm.roll(p.maxBlockHeight + PULLBACK_CANCEL_DELAY_BLOCKS);
            }
            vm.prank(owner);
            try vault.cancelPullback(pullbackIds[amount % pullbackIds.length]) {} catch {}
        } else if (op == 5) {
            uint256 free = vault.freeBalance();
            if (free == 0) return;
            vm.prank(owner);
            vault.withdraw(owner, bound(amount, 1, free)); // RV-011: may withdraw a mint before its confirm
        } else if (op == 6) {
            vm.prank(owner);
            try vault.recordManualReturn(pocket, bound(amount, 1, ONE_USDC)) {} catch {}
        } else if (op == 7) {
            vm.prank(agent);
            try vault.writeOffPocket(pocket) {} catch {}
        } else if (op == 8) {
            ICzarVault.Envelope memory e = vault.getEnvelope(env);
            if (e.state != ICzarVault.EnvelopeState.Open) return;
            vm.warp(uint256(e.expiresAt) + FORCE_CLOSE_DELAY);
            vm.prank(owner);
            vault.forceCloseEnvelope(env); // no reservations exist, so it always succeeds
        } else if (op == 9) {
            vm.roll(block.number + bound(amount, 1, 200));
        }
    }

    function testFuzz_pocket_sequence(uint8[STEPS] calldata ops, uint256[STEPS] calldata amounts) public {
        for (uint256 i = 0; i < STEPS; i++) {
            _step(ops[i] % 10, amounts[i]);
            _assertInvariants();
        }
    }

    /// @dev Rounding: the pocket cap is cap × pocketCapBps / BPS rounded down; exactly that much funds, one more fails.
    ///      Measured on a second vault (a pocket address can be registered once per vault).
    function testFuzz_pocketCap_rounding(uint256 capSeed, uint16 bpsSeed) public {
        uint256 cap = bound(capSeed, ONE_USDC, 5 * ONE_USDC);
        uint16 bps = uint16(bound(bpsSeed, 1, 2500));
        PocketVault memory s2 = _freshVault(cap, bps);
        uint256 pocketCap = cap * bps / BPS;
        vm.prank(agent);
        s2.vault.fundPocket(pocket, pocketCap);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.PocketCapExceeded.selector, pocketCap, pocketCap, 1));
        s2.vault.fundPocket(pocket, 1);
    }

    struct PocketVault {
        ICzarVault vault;
        uint64 env;
    }

    function _freshVault(uint256 cap, uint16 bps) internal returns (PocketVault memory s2) {
        s2.vault = vaultFactory.deploy(makeAddr("owner2"));
        usdc.mint(address(s2.vault), 10 * ONE_USDC);
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = cap;
        p.maxStepAmount = ONE_USDC;
        p.pocketCapBps = bps;
        p.expiresAt = uint64(block.timestamp + 1 days);
        p.categoryId = keccak256("category");
        p.payeeRoot = PAYEE_ROOT;
        vm.prank(makeAddr("owner2"));
        s2.env = s2.vault.openEnvelope(p);
        bytes32[] memory proof = _proofB0c0();
        vm.prank(agent);
        s2.vault.registerPocket(s2.env, pocket, proof);
        vm.prank(pocket);
        gatewayWallet.addDelegate(USDC_ADDRESS, address(s2.vault));
    }
}
