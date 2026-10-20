// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../../src/interfaces/ICzarVault.sol";
import {FINALIZE_CHUNK, MAX_DIGEST_MODE_COUNT} from "../../src/libraries/CzarConstants.sol";
import {VaultTestBase} from "../helpers/VaultTestBase.sol";
import {PayeeTree} from "../helpers/PayeeTree.sol";

/// @dev 07 PRD 12 (T-021; security-and-testing.md §3.2): random reserve / use / settle / finalize lifecycles.
///      INV-1, INV-5, INV-8, INV-12, INV-13, and `reserved` back to 0 with the envelope closable (RV-001).
contract ReservationFuzz is VaultTestBase, PayeeTree {
    uint256 internal constant ENVELOPE_CAP = 2 * ONE_USDC;
    uint64 internal constant TTL = 300;

    uint64 internal env;

    function setUp() public override {
        super.setUp();
        _fundVault(ENVELOPE_CAP);
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = ENVELOPE_CAP;
        p.maxStepAmount = ONE_USDC;
        p.expiresAt = uint64(block.timestamp + 1 days);
        p.categoryId = keccak256("category");
        p.payeeRoot = PAYEE_ROOT;
        vm.prank(owner);
        env = vault.openEnvelope(p);
    }

    function _bit(uint128 mask, uint32 i) internal pure returns (bool) {
        return mask & (uint128(1) << i) != 0;
    }

    function _assertReservedAndStep(uint64 rid, uint256 unit, uint32 count) internal view {
        ICzarVault.Reservation memory r = vault.getReservation(rid);
        uint32 notDone;
        for (uint32 i = 0; i < count; i++) {
            if (!_bit(r.doneMask, i)) notDone++;
        }
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.reserved, uint256(notDone) * unit, "INV-8");
        assertEq(vault.stepUsed(env, STEP_X402), uint256(count - r.releasedCount) * unit, "INV-12");
        assertLe(vault.stepUsed(env, STEP_X402), STEP_X402_CAP, "INV-12 cap");
        assertLe(e.spent + e.reserved + e.pocketOutstanding + e.jobEscrowed + e.shortfall, e.cap, "INV-1");
        assertEq(vault.committedTotal(), e.cap - e.spent, "INV-2");
        bool isFinal = r.state == ICzarVault.ReservationState.Final;
        assertEq(isFinal, r.settledCount + r.releasedCount == count, "INV-13");
        assertEq(e.openReservations, isFinal ? 0 : 1, "INV-13 openReservations");
    }

    function testFuzz_reservation_lifecycle(
        uint32 countSeed,
        uint256 unitSeed,
        uint128 usedMask,
        uint128 settleMask,
        bool digestMode
    ) public {
        uint32 count = uint32(bound(countSeed, 1, digestMode ? MAX_DIGEST_MODE_COUNT : 128));
        uint256 unit = bound(unitSeed, 1, STEP_X402_CAP / count);
        bytes32[] memory proof = _proofBeef();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(agent);
        uint64 rid = digestMode
            ? vault.reserveWithDigests(env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, unit, count, vb)
            : vault.reserve(env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, unit, count, vb);
        _assertReservedAndStep(rid, unit, count);

        // The payee is paid once per used index (INV-5: one nonce per index, value == unit).
        uint32 used;
        for (uint32 i = 0; i < count; i++) {
            if (!_bit(usedMask, i)) continue;
            usdc.consumeAuthorizationForTest(address(vault), PAYEE_BEEF, unit, vault.derivedNonce(rid, i));
            used++;
        }
        assertEq(usdc.balanceOf(PAYEE_BEEF), uint256(used) * unit, "INV-5");

        // Settle a random subset of the used indices before validBefore, at most one chunk.
        uint32[] memory idx = new uint32[](FINALIZE_CHUNK);
        uint256 n;
        for (uint32 i = 0; i < count && n < FINALIZE_CHUNK; i++) {
            if (_bit(usedMask, i) && _bit(settleMask, i)) idx[n++] = i;
        }
        if (n > 0) {
            assembly ("memory-safe") {
                mstore(idx, n) // shrink to the n chosen indices
            }
            vault.settle(rid, idx);
        }
        _assertReservedAndStep(rid, unit, count);

        // After validBefore, finalize everything in chunks: used indices settle, the rest release.
        vm.warp(vb + 1);
        for (uint32 from = 0; from < count; from += uint32(FINALIZE_CHUNK)) {
            if (vault.getReservation(rid).state == ICzarVault.ReservationState.Final) break; // settled in full
            uint32 to = from + uint32(FINALIZE_CHUNK) > count ? count : from + uint32(FINALIZE_CHUNK);
            vault.finalize(rid, from, to);
            _assertReservedAndStep(rid, unit, count);
        }
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(uint8(vault.getReservation(rid).state), uint8(ICzarVault.ReservationState.Final));
        assertEq(e.reserved, 0, "reserved back to 0");
        assertEq(e.spent, uint256(used) * unit, "spent = used units");
        vm.prank(owner);
        vault.closeEnvelope(env);
        assertEq(vault.committedTotal(), 0);
    }
}
