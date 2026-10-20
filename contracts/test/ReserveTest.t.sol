// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {CzarVault} from "../src/CzarVault.sol";
import {
    MIN_RESERVATION_TTL,
    MAX_RESERVATION_TTL,
    MAX_AUTHORIZATIONS_PER_RESERVATION,
    MAX_DIGEST_MODE_COUNT,
    FINALIZE_CHUNK
} from "../src/libraries/CzarConstants.sol";
import {CzarHashing} from "../src/libraries/CzarHashing.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {CzarVaultHarness} from "./helpers/CzarVaultHarness.sol";
import {PayeeTree} from "./helpers/PayeeTree.sol";

/// @dev 07 PRD 06 (T-015). czar-vault.md §5.3, §6.5, §8.2, §15; INV-5, INV-8, INV-12, INV-13.
contract ReserveTest is VaultTestBase, PayeeTree {
    bytes32 internal constant CATEGORY = keccak256("category.research");
    uint64 internal constant LIFETIME = 1 days;
    uint64 internal constant TTL = 300; // between MIN_RESERVATION_TTL and MAX_RESERVATION_TTL

    CzarVaultHarness internal hv;
    uint64 internal env; // envelope of `vault`

    function setUp() public override {
        super.setUp();
        hv = CzarVaultHarness(
            payable(vaultFactory.deployCode(abi.encodePacked(type(CzarVaultHarness).creationCode, abi.encode(owner))))
        );
        env = _openEnvelope(vault, 2 * ONE_USDC, ONE_USDC);
    }

    // ───────────── Helpers ─────────────

    function _openEnvelope(ICzarVault v, uint256 cap, uint256 maxStep) internal returns (uint64 id) {
        usdc.mint(address(v), cap);
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = cap;
        p.maxStepAmount = maxStep;
        p.expiresAt = uint64(block.timestamp + LIFETIME);
        p.categoryId = CATEGORY;
        p.objectiveHash = keccak256("objective");
        p.planHash = keccak256("plan");
        p.payeeRoot = PAYEE_ROOT;
        vm.prank(owner);
        id = v.openEnvelope(p);
    }

    function _reserve(ICzarVault v, uint64 id, address payee, uint256 unit, uint32 count) internal returns (uint64) {
        bytes32[] memory proof = payee == PAYEE_BEEF ? _proofBeef() : _proofCafe();
        uint64 validBefore = uint64(block.timestamp + TTL);
        vm.prank(agent);
        return v.reserve(id, STEP_X402, payee, STEP_X402_CAP, proof, unit, count, validBefore);
    }

    /// @dev Simulates the payee settling index `i` through USDC (the authorization is consumed, money moves).
    function _use(ICzarVault v, uint64 rid, uint32 i) internal {
        ICzarVault.Reservation memory r = v.getReservation(rid);
        bytes32 nonce = v.derivedNonce(rid, i);
        usdc.consumeAuthorizationForTest(address(v), r.payee, r.unitAmount, nonce);
    }

    function _indices(uint32 from, uint32 to) internal pure returns (uint32[] memory a) {
        a = new uint32[](to - from);
        for (uint32 i = from; i < to; i++) {
            a[i - from] = i;
        }
    }

    function _expectReserveRevert(
        bytes memory err,
        uint64 id,
        address payee,
        uint256 cap,
        uint256 unit,
        uint32 count,
        uint64 vb
    ) internal {
        bytes32[] memory proof = _proofBeef();
        vm.prank(agent);
        vm.expectRevert(err);
        vault.reserve(id, STEP_X402, payee, cap, proof, unit, count, vb);
    }

    // ───────────── derivedNonce ─────────────

    function test_derivedNonce_vector() public {
        address v = vaultFactory.deployCodeAt(
            address(0xc2a21), abi.encodePacked(type(CzarVault).creationCode, abi.encode(owner))
        );
        assertEq(
            CzarVault(payable(v)).derivedNonce(12, 3),
            0x1f7eb762975d3148f76637d5498c320aa01d5daa71be09a5e6ca4947371fd59f
        );
    }

    // ───────────── reserve: happy path ─────────────

    function test_reserve_storesAndBooks() public {
        uint64 vb = uint64(block.timestamp + TTL);
        bytes32[] memory proof = _proofBeef();
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Reserved(1, env, PAYEE_BEEF, STEP_X402, 100_000, 4, vb, 0);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_X402, 400_000);
        vm.prank(agent);
        uint64 rid = vault.reserve(env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, 100_000, 4, vb);
        assertEq(rid, 1);
        assertEq(vault.reservationCount(), 1);
        ICzarVault.Reservation memory r = vault.getReservation(rid);
        assertEq(r.envelopeId, env);
        assertEq(r.stepIndex, STEP_X402);
        assertEq(r.payee, PAYEE_BEEF);
        assertEq(r.unitAmount, 100_000);
        assertEq(r.count, 4);
        assertEq(r.validBefore, vb);
        assertEq(uint8(r.mode), uint8(ICzarVault.ReservationMode.Envelope));
        assertEq(uint8(r.state), uint8(ICzarVault.ReservationState.Active));
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.reserved, 400_000);
        assertEq(e.openReservations, 1);
        assertEq(vault.stepUsed(env, STEP_X402), 400_000);
        assertEq(vault.committedTotal(), 2 * ONE_USDC); // reserving does not change committedTotal
    }

    function test_reserve_maxCount128() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 1, uint32(MAX_AUTHORIZATIONS_PER_RESERVATION));
        assertEq(vault.getReservation(rid).count, 128);
    }

    // ───────────── reserve: every error ─────────────

    function test_reserve_notAgent_reverts() public {
        bytes32[] memory proof = _proofBeef();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.NotAgent.selector);
        vault.reserve(env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, 1, 1, vb);
    }

    function test_reserve_frozen_reverts() public {
        vm.prank(owner);
        vault.freeze();
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.FrozenVault.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    function test_reserve_paused_reverts() public {
        vaultFactory.setGuardianPaused(true);
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.Paused.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    function test_reserve_envelopeNotOpen_reverts() public {
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.EnvelopeNotOpen.selector),
            99,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
        vm.prank(owner);
        vault.closeEnvelope(env);
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.EnvelopeNotOpen.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    function test_reserve_envelopeExpired_reverts() public {
        vm.warp(block.timestamp + LIFETIME);
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.EnvelopeExpired.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    function test_reserve_pocketStepIndex_reverts() public {
        bytes32[] memory proof = _proofBeef();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.reserve(env, type(uint32).max, PAYEE_BEEF, STEP_X402_CAP, proof, 1, 1, vb);
    }

    function test_reserve_zeroUnitAmount_reverts() public {
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.BadParams.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            0,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    /// @dev RV-002 named test.
    function test_reserve_stepCapAboveMaxStepAmount_reverts() public {
        uint64 small = _openEnvelope(vault, ONE_USDC, ONE_USDC - 1); // maxStepAmount below the leaf's stepCap
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.BadParams.selector),
            small,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    function test_reserve_badCount_reverts() public {
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.BadCount.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            0,
            uint64(block.timestamp + TTL)
        );
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.BadCount.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            129,
            uint64(block.timestamp + TTL)
        );
    }

    function test_reserve_ttlBounds_revertBadTtl() public {
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.BadTtl.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + MIN_RESERVATION_TTL - 1)
        );
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.BadTtl.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + MAX_RESERVATION_TTL + 1)
        );
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 1, 1); // TTL inside the bounds works
        assertEq(rid, 1);
    }

    /// @dev RV-056 named test.
    function test_reserve_validBeforeAfterEnvelopeExpiry_reverts() public {
        vm.warp(block.timestamp + LIFETIME - 100); // envelope expires in 100 s
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.BadTtl.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + 101)
        );
    }

    function test_reserve_payeeNotInPlan_reverts() public {
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.PayeeNotInPlan.selector),
            env,
            makeAddr("unknown"),
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.PayeeNotInPlan.selector),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP - 1,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
        // the job leaf (kind 2) cannot be used for an x402 reservation
        bytes32[] memory proof = _proofD00d();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.PayeeNotInPlan.selector);
        vault.reserve(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, 1, 1, vb);
    }

    /// @dev RV-002 named test.
    function test_reserve_sameStepTwice_revertsStepCapExceeded() public {
        _reserve(vault, env, PAYEE_BEEF, 250_000, 4); // uses the whole 1,000,000 step cap
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.StepCapExceeded.selector, STEP_X402, STEP_X402_CAP, STEP_X402_CAP, 1),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    /// @dev RV-002 named test: an alternate payee of the same step shares one step cap.
    function test_reserve_alternatePayee_sharesStepCap() public {
        _reserve(vault, env, PAYEE_BEEF, 300_000, 2); // 600,000
        bytes32[] memory proof = _proofCafe();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(ICzarVault.StepCapExceeded.selector, STEP_X402, 600_000, STEP_X402_CAP, 500_000)
        );
        vault.reserve(env, STEP_X402, PAYEE_CAFE, STEP_X402_CAP, proof, 250_000, 2, vb);
        _reserve(vault, env, PAYEE_CAFE, 200_000, 2); // 400,000 fits exactly
        assertEq(vault.stepUsed(env, STEP_X402), STEP_X402_CAP);
    }

    function test_reserve_envelopeCap_revertsCapExceeded() public {
        usdc.mint(address(hv), 5 * ONE_USDC);
        uint64 id = _openEnvelope(hv, ONE_USDC, ONE_USDC);
        hv.exposed_simulateFundedPocket(id, makeAddr("pocket"), 600_000); // room left: 400,000
        bytes32[] memory proof = _proofBeef();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.CapExceeded.selector);
        hv.reserve(id, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, 100_000, 5, vb);
    }

    // ───────────── settle ─────────────

    function test_settle_usedIndices_bookSpent() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 100_000, 4);
        _use(vault, rid, 0);
        _use(vault, rid, 2);
        uint32[] memory idx = new uint32[](2);
        idx[0] = 0;
        idx[1] = 2;
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Settled(rid, 0, 100_000);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Settled(rid, 2, 100_000);
        vm.prank(stranger); // anyone may settle
        vault.settle(rid, idx);
        ICzarVault.Reservation memory r = vault.getReservation(rid);
        assertEq(r.settledCount, 2);
        assertEq(r.settledMask, 5);
        assertEq(r.doneMask, 5);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.spent, 200_000);
        assertEq(e.reserved, 200_000);
        assertEq(vault.committedTotal(), 2 * ONE_USDC - 200_000);
        assertEq(vault.stepUsed(env, STEP_X402), 400_000); // unchanged: spent on the step
        assertEq(usdc.balanceOf(PAYEE_BEEF), 200_000);
        assertEq(vault.freeBalance(), 0); // balance and committed fell together (INV-2)
    }

    function test_settle_notUsed_reverts() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 100_000, 4);
        uint32[] memory idx = _indices(1, 2);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.NotUsed.selector, 1));
        vault.settle(rid, idx);
    }

    function test_settle_twice_revertsAlreadyDone() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 100_000, 4);
        _use(vault, rid, 1);
        uint32[] memory idx = _indices(1, 2);
        vault.settle(rid, idx);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.AlreadyDone.selector, 1));
        vault.settle(rid, idx);
        uint32[] memory dup = new uint32[](2); // the same index twice in one call
        _use(vault, rid, 3);
        dup[0] = 3;
        dup[1] = 3;
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.AlreadyDone.selector, 3));
        vault.settle(rid, dup);
    }

    function test_settle_badIndices_revertBadParams() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 1_000, 40);
        uint32[] memory none = new uint32[](0);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.settle(rid, none);
        uint32[] memory tooMany = _indices(0, uint32(FINALIZE_CHUNK) + 1);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.settle(rid, tooMany);
        uint32[] memory outOfRange = _indices(40, 41);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.settle(rid, outOfRange);
    }

    function test_settle_unknownReservation_reverts() public {
        uint32[] memory idx = _indices(0, 1);
        vm.expectRevert(ICzarVault.ReservationNotActive.selector);
        vault.settle(7, idx);
    }

    /// @dev RV-001 named test.
    function test_settleAllIndices_reservationFinal_envelopeCloses() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 10_000, 10);
        for (uint32 i = 0; i < 10; i++) {
            _use(vault, rid, i);
        }
        uint32[] memory idx = _indices(0, 10);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.ReservationFinal(rid, 10, 0);
        vault.settle(rid, idx);
        assertEq(uint8(vault.getReservation(rid).state), uint8(ICzarVault.ReservationState.Final));
        assertEq(vault.getEnvelope(env).openReservations, 0);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.EnvelopeClosed(env, 100_000, 2 * ONE_USDC - 100_000);
        vm.prank(owner);
        vault.closeEnvelope(env);
        vm.expectRevert(ICzarVault.ReservationNotActive.selector);
        vault.settle(rid, _indices(0, 1)); // Final reservations refuse settle
    }

    // ───────────── finalize ─────────────

    function test_finalize_beforeValidBefore_revertsNotExpired() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 100_000, 4);
        vm.warp(vault.getReservation(rid).validBefore); // equal is still not expired
        vm.expectRevert(ICzarVault.NotExpired.selector);
        vault.finalize(rid, 0, 4);
    }

    function test_finalize_badRange_revertsBadParams() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 1_000, 40);
        vm.warp(vault.getReservation(rid).validBefore + 1);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.finalize(rid, 4, 4);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.finalize(rid, 0, 41);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.finalize(rid, 0, uint32(FINALIZE_CHUNK) + 1);
    }

    function test_finalize_releasesUnusedAndSettlesUsed() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 100_000, 4);
        _use(vault, rid, 1);
        vm.warp(vault.getReservation(rid).validBefore + 1);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Released(rid, 0, 100_000);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Settled(rid, 1, 100_000);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Released(rid, 2, 100_000);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.Released(rid, 3, 100_000);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_X402, 100_000);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.ReservationFinal(rid, 1, 3);
        vm.prank(stranger);
        vault.finalize(rid, 0, 4);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.reserved, 0);
        assertEq(e.spent, 100_000);
        assertEq(e.openReservations, 0);
        assertEq(vault.committedTotal(), 2 * ONE_USDC - 100_000); // releases stay committed to the envelope
    }

    /// @dev RV-001 named test.
    function test_finalize_skipsDoneIndices() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 10_000, 10);
        for (uint32 i = 0; i < 5; i++) {
            _use(vault, rid, i);
        }
        vault.settle(rid, _indices(0, 5));
        vm.warp(vault.getReservation(rid).validBefore + 1);
        vault.finalize(rid, 0, 10);
        ICzarVault.Reservation memory r = vault.getReservation(rid);
        assertEq(r.settledCount, 5);
        assertEq(r.releasedCount, 5);
        assertEq(uint8(r.state), uint8(ICzarVault.ReservationState.Final));
    }

    function test_finalize_chunked_finalAfterLastChunk() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 1_000, 100);
        vm.warp(vault.getReservation(rid).validBefore + 1);
        vault.finalize(rid, 0, 32);
        assertEq(uint8(vault.getReservation(rid).state), uint8(ICzarVault.ReservationState.Finalizing));
        vault.finalize(rid, 32, 64);
        vault.finalize(rid, 64, 96);
        assertEq(vault.getEnvelope(env).openReservations, 1);
        vault.finalize(rid, 96, 100);
        assertEq(uint8(vault.getReservation(rid).state), uint8(ICzarVault.ReservationState.Final));
        assertEq(vault.getEnvelope(env).openReservations, 0);
        assertEq(vault.stepUsed(env, STEP_X402), 0);
    }

    /// @dev RV-002 named test.
    function test_releasedIndices_restoreStepRoom() public {
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, 250_000, 4); // the whole step cap
        _use(vault, rid, 0);
        vm.warp(vault.getReservation(rid).validBefore + 1);
        vault.finalize(rid, 0, 4); // 1 settled, 3 released → 750,000 free on the step again
        assertEq(vault.stepUsed(env, STEP_X402), 250_000);
        _reserve(vault, env, PAYEE_CAFE, 250_000, 3);
        _expectReserveRevert(
            abi.encodeWithSelector(ICzarVault.StepCapExceeded.selector, STEP_X402, STEP_X402_CAP, STEP_X402_CAP, 1),
            env,
            PAYEE_BEEF,
            STEP_X402_CAP,
            1,
            1,
            uint64(block.timestamp + TTL)
        );
    }

    // ───────────── digest mode ─────────────

    function test_reserveWithDigests_storesSlotsAndCleansUp() public {
        uint64 id = _openEnvelope(hv, 2 * ONE_USDC, ONE_USDC);
        bytes32[] memory proof = _proofBeef();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(agent);
        uint64 rid = hv.reserveWithDigests(id, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, 50_000, 3, vb);
        assertEq(uint8(hv.getReservation(rid).mode), uint8(ICzarVault.ReservationMode.Digest));
        for (uint32 i = 0; i < 3; i++) {
            bytes32 expected = CzarHashing.typedDataHash(
                hv.exposed_usdcDomainSeparator(),
                CzarHashing.transferWithAuthorizationHash(
                    address(hv), PAYEE_BEEF, 50_000, 0, vb, hv.derivedNonce(rid, i)
                )
            );
            assertEq(hv.exposed_usdcDigest(rid, i), expected);
            (uint64 r, uint32 index, bool set) = hv.exposed_digestSlot(expected);
            assertEq(r, rid);
            assertEq(index, i);
            assertTrue(set);
        }
        vm.warp(vb + 1);
        hv.finalize(rid, 0, 3);
        for (uint32 i = 0; i < 3; i++) {
            (,, bool set) = hv.exposed_digestSlot(hv.exposed_usdcDigest(rid, i));
            assertFalse(set); // deleted when the reservation became Final (§15.11)
        }
    }

    function test_reserveWithDigests_countAbove8_revertsBadCount() public {
        bytes32[] memory proof = _proofBeef();
        uint64 vb = uint64(block.timestamp + TTL);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadCount.selector);
        vault.reserveWithDigests(
            env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, proof, 1, uint32(MAX_DIGEST_MODE_COUNT) + 1, vb
        );
    }

    // ───────────── Fuzz: INV-8, INV-12, INV-13 and INV-2 over reserve, settle, finalize ─────────────

    function testFuzz_reserveSettleFinalize_invariants(uint8 countSeed, uint32 unitSeed, uint256 usedMask) public {
        uint32 count = uint32(bound(countSeed, 1, 64));
        uint256 unit = bound(unitSeed, 1, STEP_X402_CAP / count);
        uint64 rid = _reserve(vault, env, PAYEE_BEEF, unit, count);
        uint256 used;
        for (uint32 i = 0; i < count; i++) {
            if ((usedMask >> i) & 1 == 1) {
                _use(vault, rid, i);
                used++;
            }
        }
        vm.warp(vault.getReservation(rid).validBefore + 1);
        for (uint32 from = 0; from < count; from += uint32(FINALIZE_CHUNK)) {
            uint32 to = from + uint32(FINALIZE_CHUNK) > count ? count : from + uint32(FINALIZE_CHUNK);
            vault.finalize(rid, from, to);
        }
        ICzarVault.Reservation memory r = vault.getReservation(rid);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(r.settledCount, used);
        assertEq(r.settledCount + r.releasedCount, count);
        assertEq(uint8(r.state), uint8(ICzarVault.ReservationState.Final)); // INV-13
        assertEq(e.openReservations, 0);
        assertEq(e.reserved, 0); // INV-8
        assertEq(e.spent, used * unit);
        assertEq(vault.stepUsed(env, STEP_X402), used * unit); // INV-12
        assertEq(vault.committedTotal(), e.cap - e.spent); // INV-2
        assertEq(usdc.balanceOf(address(vault)), vault.committedTotal()); // nothing free, nothing lost
    }
}
