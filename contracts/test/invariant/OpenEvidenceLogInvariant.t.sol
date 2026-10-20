// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IOpenEvidenceLog} from "../../src/interfaces/IOpenEvidenceLog.sol";
import {OpenEvidenceLog} from "../../src/OpenEvidenceLog.sol";
import {MockUSDC3009} from "../mocks/MockUSDC3009.sol";

/// @notice Drives random commits and reveals from several publishers and keeps ghost copies of what each
///         call must have done, so the invariants can compare storage against them.
contract OpenEvidenceLogHandler is Test {
    OpenEvidenceLog internal immutable oel;
    /// Deployed here so the handler holds the mock's controller role and can mint donations.
    MockUSDC3009 public immutable usdc;
    address[] public publishers;
    bytes32[] internal roots;

    /// ghost: publisher → kind → number of successful commits.
    mapping(address => mapping(uint8 => uint256)) public ghostCount;
    /// ghost: publisher → root → highest status seen (0 unknown, 1 committed, 2 revealed).
    mapping(address => mapping(bytes32 => uint8)) public ghostStatus;
    mapping(address => mapping(bytes32 => bytes32)) public ghostBatch;
    uint256 public alreadyCommittedReverts;
    uint256 public wrongPublisherWrites;
    /// ghost: total mock USDC sent to the log (OEL-5 is checked against it; G-61 moved it here from the invariant).
    uint256 public ghostDonated;

    uint256 internal constant KIND_COUNT = 6;

    constructor(OpenEvidenceLog oel_) {
        oel = oel_;
        usdc = new MockUSDC3009();
        publishers.push(address(0xA11CE));
        publishers.push(address(0xB0B));
        publishers.push(address(0xCA11));
        for (uint256 i = 0; i < 8; i++) {
            roots.push(keccak256(abi.encode("root", i)));
        }
    }

    function publisherCount() external view returns (uint256) {
        return publishers.length;
    }

    function rootAt(uint256 i) external view returns (bytes32) {
        return roots[i];
    }

    function rootCount() external view returns (uint256) {
        return roots.length;
    }

    function _snapshotOthers(address actor) internal view returns (uint256[18] memory counts) {
        uint256 j;
        for (uint256 p = 0; p < publishers.length; p++) {
            for (uint8 k = 0; k < KIND_COUNT; k++) {
                counts[j++] = publishers[p] == actor ? 0 : oel.count(publishers[p], IOpenEvidenceLog.Kind(k));
            }
        }
    }

    /// @dev One hash over every other publisher's intent status and batch root for every known root (G-61).
    function _intentsOfOthers(address actor) internal view returns (bytes32 h) {
        for (uint256 p = 0; p < publishers.length; p++) {
            if (publishers[p] == actor) continue;
            for (uint256 r = 0; r < roots.length; r++) {
                (bool committed, bool revealed, bytes32 batchRoot) = oel.intentStatus(publishers[p], roots[r]);
                h = keccak256(abi.encode(h, committed, revealed, batchRoot));
            }
        }
    }

    function _checkOthersUnchanged(address actor, uint256[18] memory before, bytes32 intentsBefore) internal {
        uint256[18] memory afterCounts = _snapshotOthers(actor);
        for (uint256 i = 0; i < before.length; i++) {
            if (before[i] != afterCounts[i]) wrongPublisherWrites++;
        }
        if (_intentsOfOthers(actor) != intentsBefore) wrongPublisherWrites++;
    }

    function commit(uint256 actorSeed, uint8 kindSeed, uint256 rootSeed, bool usePrev) external {
        address actor = publishers[actorSeed % publishers.length];
        IOpenEvidenceLog.Kind kind = IOpenEvidenceLog.Kind(kindSeed % KIND_COUNT);
        bytes32 root = roots[rootSeed % roots.length];
        bytes32 prev = usePrev ? oel.latest(actor, kind).root : bytes32(0);
        uint256[18] memory before = _snapshotOthers(actor);
        bytes32 intentsBefore = _intentsOfOthers(actor);
        vm.prank(actor);
        try oel.commit(kind, root, prev, keccak256(abi.encode(root)), "czar-archive:x") {
            ghostCount[actor][uint8(kind)]++;
            if (kind == IOpenEvidenceLog.Kind.PROBE_INTENT) ghostStatus[actor][root] = 1;
        } catch (bytes memory reason) {
            if (bytes4(reason) == IOpenEvidenceLog.AlreadyCommitted.selector) alreadyCommittedReverts++;
        }
        _checkOthersUnchanged(actor, before, intentsBefore);
    }

    function reveal(uint256 actorSeed, uint256 rootSeed, uint256 batchSeed) external {
        address actor = publishers[actorSeed % publishers.length];
        bytes32 root = roots[rootSeed % roots.length];
        bytes32 batch = keccak256(abi.encode("batch", batchSeed));
        uint256[18] memory before = _snapshotOthers(actor);
        bytes32 intentsBefore = _intentsOfOthers(actor);
        vm.prank(actor);
        try oel.reveal(root, batch, keccak256(abi.encode(batch)), "czar-archive:y") {
            ghostStatus[actor][root] = 2;
            ghostBatch[actor][root] = batch;
        } catch {}
        _checkOthersUnchanged(actor, before, intentsBefore);
    }

    /// Anyone may send the oel mock USDC; it can never move it out (OEL-5).
    function donate(uint256 amount) external {
        amount = bound(amount, 1, 1_000_000);
        usdc.mint(address(oel), amount);
        ghostDonated += amount;
    }
}

/// @notice OEL-1 to OEL-6 (03 open-evidence-log.md §10) as Foundry invariants.
contract OpenEvidenceLogInvariant is Test {
    OpenEvidenceLog internal oel;
    MockUSDC3009 internal usdc;
    OpenEvidenceLogHandler internal handler;

    function setUp() public {
        oel = new OpenEvidenceLog();
        handler = new OpenEvidenceLogHandler(oel);
        usdc = handler.usdc();
        targetContract(address(handler));
    }

    /// OEL-1: per publisher and kind, each commitment's prev is the previous root; the first prev is 0.
    function invariant_OEL1_hashChain() public view {
        for (uint256 p = 0; p < handler.publisherCount(); p++) {
            address publisher = handler.publishers(p);
            for (uint8 k = 0; k < 6; k++) {
                IOpenEvidenceLog.Kind kind = IOpenEvidenceLog.Kind(k);
                uint256 n = oel.count(publisher, kind);
                for (uint256 i = 0; i < n; i++) {
                    IOpenEvidenceLog.Commitment memory c = oel.get(publisher, kind, i);
                    bytes32 expected = i == 0 ? bytes32(0) : oel.get(publisher, kind, i - 1).root;
                    assertEq(c.prev, expected, "OEL-1");
                    assertEq(uint8(c.kind), k, "OEL-1 kind");
                }
            }
        }
    }

    /// OEL-2: revealed implies committed; status never decreases; the batch root never changes after reveal.
    function invariant_OEL2_intentStatus() public view {
        for (uint256 p = 0; p < handler.publisherCount(); p++) {
            address publisher = handler.publishers(p);
            for (uint256 r = 0; r < handler.rootCount(); r++) {
                bytes32 root = handler.rootAt(r);
                (bool committed, bool revealed, bytes32 batchRoot) = oel.intentStatus(publisher, root);
                if (revealed) assertTrue(committed, "OEL-2 revealed => committed");
                uint8 status = revealed ? 2 : committed ? 1 : 0;
                assertEq(status, handler.ghostStatus(publisher, root), "OEL-2 monotone status");
                if (revealed) assertEq(batchRoot, handler.ghostBatch(publisher, root), "OEL-2 batch root fixed");
                else assertEq(batchRoot, bytes32(0), "OEL-2 no batch before reveal");
            }
        }
    }

    /// OEL-3: counts only increase and match the successful commits; nothing is modified or removed.
    function invariant_OEL3_appendOnly() public view {
        for (uint256 p = 0; p < handler.publisherCount(); p++) {
            address publisher = handler.publishers(p);
            for (uint8 k = 0; k < 6; k++) {
                assertEq(oel.count(publisher, IOpenEvidenceLog.Kind(k)), handler.ghostCount(publisher, k), "OEL-3");
            }
        }
    }

    /// OEL-4: no call changed storage of a publisher other than msg.sender.
    function invariant_OEL4_onlyOwnStorage() public view {
        assertEq(handler.wrongPublisherWrites(), 0, "OEL-4");
    }

    /// OEL-5: no payable function and no way to move value: native balance stays 0, and the log holds exactly the
    ///        USDC sent to it (the ghost lives in the handler: state an invariant function writes is not kept, G-61).
    function invariant_OEL5_noValueMovement() public view {
        assertEq(address(oel).balance, 0, "OEL-5 native");
        assertEq(usdc.balanceOf(address(oel)), handler.ghostDonated(), "OEL-5 usdc never leaves");
    }

    /// OEL-6: a PROBE_INTENT root is committed at most once per publisher.
    function invariant_OEL6_intentCommittedOnce() public view {
        for (uint256 p = 0; p < handler.publisherCount(); p++) {
            address publisher = handler.publishers(p);
            uint256 n = oel.count(publisher, IOpenEvidenceLog.Kind.PROBE_INTENT);
            for (uint256 i = 0; i < n; i++) {
                bytes32 a = oel.get(publisher, IOpenEvidenceLog.Kind.PROBE_INTENT, i).root;
                for (uint256 j = i + 1; j < n; j++) {
                    assertTrue(a != oel.get(publisher, IOpenEvidenceLog.Kind.PROBE_INTENT, j).root, "OEL-6");
                }
            }
        }
    }
}
