// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../../src/interfaces/ICzarVault.sol";
import {PERIOD_LENGTH, MAX_RAISE_STEP_BPS, BPS} from "../../src/libraries/CzarConstants.sol";
import {VaultTestBase} from "../helpers/VaultTestBase.sol";

/// @dev 07 PRD 12 (T-021; security-and-testing.md §3.2): earned-autonomy raises, lowerings, limit changes, freezes and
///      agent envelope openings across period boundaries. After every step: INV-9 (autoLimit ≤ userMax), INV-10
///      (autonomyNonce only increases, and by one on every raise, lowering, freeze and setCategoryLimits), raises at
///      least PERIOD_LENGTH apart (RV-031), and no step reverts with a panic (RV-008). Rounding of the raise step.
contract AutonomyFuzz is VaultTestBase {
    bytes32 internal constant CATEGORY = keccak256("category");
    uint256 internal constant STEPS = 16;
    bytes4 internal constant PANIC_SELECTOR = 0x4e487b71; // Panic(uint256)

    uint256 internal lastRaiseAt;

    function setUp() public override {
        super.setUp();
        _fundVault(1_000 * ONE_USDC);
        vm.prank(owner);
        vault.setCategoryLimits(CATEGORY, 10 * ONE_USDC, ONE_USDC);
    }

    function _noPanic(bytes memory reason) internal pure {
        assertTrue(reason.length < 4 || bytes4(reason) != PANIC_SELECTOR, "panic");
    }

    function _step(uint8 op, uint256 amount) internal {
        uint256 nonceBefore = vault.autonomyNonce();
        ICzarVault.CategoryLimits memory l = vault.getLimits(CATEGORY);
        bool bumped;
        if (op == 0) {
            uint256 deadline = block.timestamp;
            uint64 period = uint64(block.timestamp / PERIOD_LENGTH);
            vm.prank(owner);
            try vault.raiseAutoLimit(CATEGORY, bound(amount, 0, 2 * l.userMax + 1), period, deadline, "") {
                bumped = true;
                if (lastRaiseAt != 0) assertGe(block.timestamp, lastRaiseAt + PERIOD_LENGTH, "RV-031 spacing");
                lastRaiseAt = block.timestamp;
            } catch (bytes memory reason) {
                _noPanic(reason);
            }
        } else if (op == 1) {
            vm.prank(agent);
            try vault.lowerAutoLimit(CATEGORY, bound(amount, 0, l.autoLimit + 1)) {
                bumped = true;
            } catch (bytes memory reason) {
                _noPanic(reason);
            }
        } else if (op == 2) {
            uint256 userMax = bound(amount, 0, 20 * ONE_USDC);
            vm.prank(owner);
            try vault.setCategoryLimits(CATEGORY, userMax, bound(amount >> 128, 0, userMax + 1)) {
                bumped = true;
            } catch (bytes memory reason) {
                _noPanic(reason);
            }
        } else if (op == 3) {
            vm.prank(agent);
            vault.freeze();
            bumped = true;
        } else if (op == 4) {
            vm.prank(owner);
            vault.unfreeze();
        } else if (op == 5) {
            ICzarVault.OpenEnvelopeParams memory p;
            p.cap = bound(amount, 1, 3 * ONE_USDC);
            p.maxStepAmount = p.cap;
            p.expiresAt = uint64(block.timestamp + 1 hours);
            p.categoryId = CATEGORY;
            p.payeeRoot = keccak256("root");
            vm.prank(agent);
            try vault.openEnvelope(p) {} // the allowance is sat(autoLimit, usedInPeriod): never a panic (RV-008)
                catch (bytes memory reason) {
                _noPanic(reason);
            }
        } else {
            vm.warp(block.timestamp + bound(amount, 1, 2 * PERIOD_LENGTH));
        }
        uint256 nonceAfter = vault.autonomyNonce();
        assertEq(nonceAfter, nonceBefore + (bumped ? 1 : 0), "INV-10");
        ICzarVault.CategoryLimits memory after_ = vault.getLimits(CATEGORY);
        assertLe(after_.autoLimit, after_.userMax, "INV-9");
    }

    function testFuzz_autonomy_sequence(uint8[STEPS] calldata ops, uint256[STEPS] calldata amounts) public {
        for (uint256 i = 0; i < STEPS; i++) {
            _step(ops[i] % 7, amounts[i]);
        }
    }

    /// @dev Rounding: the largest raise is userMax × MAX_RAISE_STEP_BPS / BPS rounded down; one unit more reverts.
    function testFuzz_raiseStep_rounding(uint256 userMaxSeed, uint256 autoSeed) public {
        uint256 userMax = bound(userMaxSeed, 5, 1_000_000 * ONE_USDC);
        uint256 step = userMax * MAX_RAISE_STEP_BPS / BPS;
        uint256 autoLimit = bound(autoSeed, 0, userMax - step - 1);
        vm.prank(owner);
        vault.setCategoryLimits(CATEGORY, userMax, autoLimit);
        uint64 period = uint64(block.timestamp / PERIOD_LENGTH);
        uint256 deadline = block.timestamp;
        vm.prank(owner);
        vm.expectRevert(ICzarVault.RaiseTooLarge.selector);
        vault.raiseAutoLimit(CATEGORY, autoLimit + step + 1, period, deadline, "");
        vm.prank(owner);
        vault.raiseAutoLimit(CATEGORY, autoLimit + step, period, deadline, "");
        assertEq(vault.getLimits(CATEGORY).autoLimit, autoLimit + step);
    }
}
