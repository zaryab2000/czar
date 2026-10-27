// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IOpenEvidenceLog} from "../src/interfaces/IOpenEvidenceLog.sol";
import {OpenEvidenceLog} from "../src/OpenEvidenceLog.sol";

/// @notice T-011: one test per function and per error of `OpenEvidenceLog` (03 open-evidence-log.md §6, §8),
///         plus the RV-014 named tests from 03 security-and-testing.md §3.7.
contract OpenEvidenceLogTest is Test {
    OpenEvidenceLog internal oel;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    bytes32 internal constant R1 = keccak256("root-1");
    bytes32 internal constant R2 = keccak256("root-2");
    bytes32 internal constant B1 = keccak256("batch-1");
    bytes32 internal constant B2 = keccak256("batch-2");
    bytes32 internal constant U1 = keccak256("czar-archive:1");
    string internal constant URI = "czar-archive:0x0000000000000000000000000000000000000000000000000000000000000001";
    uint256 internal constant TX_BASE_GAS = 21_000; // intrinsic gas of every transaction
    uint256 internal constant COMMIT_GAS_ESTIMATE_MAX = 135_000; // open-evidence-log.md §6 table

    function setUp() public {
        oel = new OpenEvidenceLog();
        vm.warp(1_760_000_000);
        vm.roll(67_000_000);
    }

    // ─────────────── commit ───────────────

    function test_commit_firstHasZeroPrevAndStoresFields() public {
        vm.expectEmit(true, true, true, true, address(oel));
        emit IOpenEvidenceLog.Committed(alice, IOpenEvidenceLog.Kind.EVIDENCE_BATCH, 0, R1, bytes32(0), U1, URI);
        vm.prank(alice);
        uint256 seq = oel.commit(IOpenEvidenceLog.Kind.EVIDENCE_BATCH, R1, bytes32(0), U1, URI);
        assertEq(seq, 0);
        IOpenEvidenceLog.Commitment memory c = oel.get(alice, IOpenEvidenceLog.Kind.EVIDENCE_BATCH, 0);
        assertEq(c.root, R1);
        assertEq(c.prev, bytes32(0));
        assertEq(c.uriHash, U1);
        assertEq(c.timestamp, 1_760_000_000);
        assertEq(c.blockNumber, 67_000_000);
        assertEq(uint8(c.kind), uint8(IOpenEvidenceLog.Kind.EVIDENCE_BATCH));
    }

    function test_commit_chainsPrevPerPublisherAndKind() public {
        vm.startPrank(alice);
        oel.commit(IOpenEvidenceLog.Kind.EVIDENCE_BATCH, R1, bytes32(0), U1, URI);
        uint256 seq = oel.commit(IOpenEvidenceLog.Kind.EVIDENCE_BATCH, R2, R1, U1, URI);
        // A different kind starts its own chain at 0.
        oel.commit(IOpenEvidenceLog.Kind.FEATURE_SNAPSHOT, R1, bytes32(0), U1, URI);
        vm.stopPrank();
        assertEq(seq, 1);
        assertEq(oel.get(alice, IOpenEvidenceLog.Kind.EVIDENCE_BATCH, 1).prev, R1);
        // Another publisher also starts at 0.
        vm.prank(bob);
        oel.commit(IOpenEvidenceLog.Kind.EVIDENCE_BATCH, R2, bytes32(0), U1, URI);
        assertEq(oel.count(bob, IOpenEvidenceLog.Kind.EVIDENCE_BATCH), 1);
    }

    function test_commit_revertsPrevMismatch() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOpenEvidenceLog.PrevMismatch.selector, bytes32(0), R2));
        oel.commit(IOpenEvidenceLog.Kind.EVIDENCE_BATCH, R1, R2, U1, URI);
        oel.commit(IOpenEvidenceLog.Kind.EVIDENCE_BATCH, R1, bytes32(0), U1, URI);
        vm.expectRevert(abi.encodeWithSelector(IOpenEvidenceLog.PrevMismatch.selector, R1, bytes32(0)));
        oel.commit(IOpenEvidenceLog.Kind.EVIDENCE_BATCH, R2, bytes32(0), U1, URI);
        vm.stopPrank();
    }

    function test_commitProbeIntent_setsCommitted() public {
        vm.prank(alice);
        oel.commit(IOpenEvidenceLog.Kind.PROBE_INTENT, R1, bytes32(0), U1, URI);
        (bool committed, bool revealed, bytes32 batchRoot) = oel.intentStatus(alice, R1);
        assertTrue(committed);
        assertFalse(revealed);
        assertEq(batchRoot, bytes32(0));
        (committed,,) = oel.intentStatus(bob, R1);
        assertFalse(committed);
    }

    /// @notice RV-014 named test (security-and-testing.md §3.7).
    function test_commitProbeIntent_twice_revertsAlreadyCommitted() public {
        vm.startPrank(alice);
        oel.commit(IOpenEvidenceLog.Kind.PROBE_INTENT, R1, bytes32(0), U1, URI);
        // prev = R1 passes the chain check; the intent rule still refuses.
        vm.expectRevert(abi.encodeWithSelector(IOpenEvidenceLog.AlreadyCommitted.selector, R1));
        oel.commit(IOpenEvidenceLog.Kind.PROBE_INTENT, R1, R1, U1, URI);
        vm.stopPrank();
        assertEq(oel.count(alice, IOpenEvidenceLog.Kind.PROBE_INTENT), 1);
    }

    /// @notice RV-014 named test: commit R, reveal B1, commit R again, reveal B2 must be impossible.
    /// @dev G-61: the prev check comes first, so a repeat PROBE_INTENT commit with a stale prev is PrevMismatch.
    function test_commitProbeIntent_stalePrev_revertsPrevMismatch() public {
        vm.prank(alice);
        oel.commit(IOpenEvidenceLog.Kind.PROBE_INTENT, R1, bytes32(0), U1, URI);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOpenEvidenceLog.PrevMismatch.selector, R1, bytes32(0)));
        oel.commit(IOpenEvidenceLog.Kind.PROBE_INTENT, R1, bytes32(0), U1, URI);
    }

    function test_recommitAfterReveal_reverts() public {
        vm.startPrank(alice);
        oel.commit(IOpenEvidenceLog.Kind.PROBE_INTENT, R1, bytes32(0), U1, URI);
        oel.reveal(R1, B1, U1, URI);
        vm.expectRevert(abi.encodeWithSelector(IOpenEvidenceLog.AlreadyCommitted.selector, R1));
        oel.commit(IOpenEvidenceLog.Kind.PROBE_INTENT, R1, R1, U1, URI);
        vm.expectRevert(abi.encodeWithSelector(IOpenEvidenceLog.AlreadyRevealed.selector, R1));
        oel.reveal(R1, B2, U1, URI);
        vm.stopPrank();
        (,, bytes32 batchRoot) = oel.intentStatus(alice, R1);
        assertEq(batchRoot, B1);
    }

    function test_commitProbeIntent_sameRootByAnotherPublisherIsIndependent() public {
        vm.prank(alice);
        oel.commit(IOpenEvidenceLog.Kind.PROBE_INTENT, R1, bytes32(0), U1, URI);
        vm.prank(bob);
        oel.commit(IOpenEvidenceLog.Kind.PROBE_INTENT, R1, bytes32(0), U1, URI);
        (bool committed,,) = oel.intentStatus(bob, R1);
        assertTrue(committed);
    }

    function test_commit_otherKindDoesNotTouchIntent() public {
        vm.prank(alice);
        oel.commit(IOpenEvidenceLog.Kind.EVIDENCE_BATCH, R1, bytes32(0), U1, URI);
        (bool committed,,) = oel.intentStatus(alice, R1);
        assertFalse(committed);
    }

    // ─────────────── reveal ───────────────

    function test_reveal_linksBatchAndEmits() public {
        vm.startPrank(alice);
        oel.commit(IOpenEvidenceLog.Kind.PROBE_INTENT, R1, bytes32(0), U1, URI);
        vm.expectEmit(true, true, true, true, address(oel));
        emit IOpenEvidenceLog.Revealed(alice, R1, B1, U1, URI);
        oel.reveal(R1, B1, U1, URI);
        vm.stopPrank();
        (bool committed, bool revealed, bytes32 batchRoot) = oel.intentStatus(alice, R1);
        assertTrue(committed);
        assertTrue(revealed);
        assertEq(batchRoot, B1);
    }

    function test_reveal_revertsUnknownIntent() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOpenEvidenceLog.UnknownIntent.selector, R1));
        oel.reveal(R1, B1, U1, URI);
    }

    function test_reveal_revertsUnknownIntentForAnotherPublishersRoot() public {
        vm.prank(alice);
        oel.commit(IOpenEvidenceLog.Kind.PROBE_INTENT, R1, bytes32(0), U1, URI);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IOpenEvidenceLog.UnknownIntent.selector, R1));
        oel.reveal(R1, B1, U1, URI);
    }

    /// @dev G-61: a root committed under another kind is not an intent.
    function test_reveal_rootCommittedUnderOtherKind_revertsUnknownIntent() public {
        vm.prank(alice);
        oel.commit(IOpenEvidenceLog.Kind.EVIDENCE_BATCH, R1, bytes32(0), U1, URI);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOpenEvidenceLog.UnknownIntent.selector, R1));
        oel.reveal(R1, B1, U1, URI);
    }

    function test_reveal_revertsAlreadyRevealed() public {
        vm.startPrank(alice);
        oel.commit(IOpenEvidenceLog.Kind.PROBE_INTENT, R1, bytes32(0), U1, URI);
        oel.reveal(R1, B1, U1, URI);
        vm.expectRevert(abi.encodeWithSelector(IOpenEvidenceLog.AlreadyRevealed.selector, R1));
        oel.reveal(R1, B1, U1, URI);
        vm.stopPrank();
    }

    // ─────────────── views ───────────────

    function test_count_startsAtZero() public view {
        assertEq(oel.count(alice, IOpenEvidenceLog.Kind.POLICY_RELEASE), 0);
    }

    function test_get_revertsOutOfRange() public {
        vm.expectRevert();
        oel.get(alice, IOpenEvidenceLog.Kind.EVIDENCE_BATCH, 0);
    }

    function test_latest_zeroStructWhenEmptyThenNewest() public {
        IOpenEvidenceLog.Commitment memory empty = oel.latest(alice, IOpenEvidenceLog.Kind.CORRECTION);
        assertEq(empty.root, bytes32(0));
        assertEq(empty.timestamp, 0);
        vm.startPrank(alice);
        oel.commit(IOpenEvidenceLog.Kind.CORRECTION, R1, bytes32(0), U1, URI);
        oel.commit(IOpenEvidenceLog.Kind.CORRECTION, R2, R1, U1, URI);
        vm.stopPrank();
        assertEq(oel.latest(alice, IOpenEvidenceLog.Kind.CORRECTION).root, R2);
    }

    function test_intentStatus_unknownIsAllFalse() public view {
        (bool committed, bool revealed, bytes32 batchRoot) = oel.intentStatus(alice, R1);
        assertFalse(committed);
        assertFalse(revealed);
        assertEq(batchRoot, bytes32(0));
    }

    // ─────────────── value and gas ───────────────

    function test_rejectsNativeValue() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(oel).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(oel).balance, 0);
    }

    /// @notice 03 open-evidence-log.md §13 estimates 120–135k for `commit`, including the 21k transaction base;
    ///         the measured value plus the base is logged and checked against the upper estimate (G-61).
    function test_gas_commitEvidenceBatch() public {
        vm.prank(alice);
        uint256 before = gasleft();
        oel.commit(IOpenEvidenceLog.Kind.EVIDENCE_BATCH, R1, bytes32(0), U1, URI);
        uint256 used = before - gasleft() + TX_BASE_GAS;
        emit log_named_uint("commit EVIDENCE_BATCH gas (first, including the 21k base)", used);
        assertLe(used, COMMIT_GAS_ESTIMATE_MAX);
    }
}
