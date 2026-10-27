# 02 — Open Evidence Log: test follow-up

## 1. Scope
- **Task:** T-011 follow-up (D88, G-61): fixes to the tests of the already-built `OpenEvidenceLog`. **No contract change.**
- **You change:**
  - `contracts/test/OpenEvidenceLogTest.t.sol`: two new unit tests, the header's spec file name, and the gas test now includes the 21,000-gas transaction base (§5).
  - `contracts/test/invariant/OpenEvidenceLogInvariant.t.sol`: the OEL-5 ghost moves into the handler, and the OEL-4 check also compares other publishers' intents and batch roots (§6).
- **Why each change (from `phase-1-tasks.md` T-011, "D88 follow-up (G-61)"):**
  - **OEL-5 ghost.** The old invariant stored the last USDC balance in a variable of the invariant contract. Foundry runs each invariant check in a fresh copy of that state, so the write is not kept and the check compared against 0 every time. The handler now counts what it donates (`ghostDonated`) and the invariant checks the log holds exactly that.
  - **OEL-4 intents.** The handler compared only other publishers' commitment counts. A bug that wrote another publisher's intent status or batch root would have passed. It now hashes every other publisher's `intentStatus` for every known root before and after each call.
  - **Two missing error paths.** A repeat `PROBE_INTENT` commit with a stale `prev` must fail `PrevMismatch` (the `prev` check comes first), not `AlreadyCommitted`; and `reveal` of a root committed under another kind must fail `UnknownIntent`.
  - **Spec name.** The headers cited `open-evidence-oel.md`; the file is `open-evidence-log.md`.
  - **Gas.** `open-evidence-log.md` §6 estimates `commit` at 120–135k gas **including** the 21k base; the old test checked the execution gas alone against 135k.
- **Dependencies:** T-011 done; PRD 01 done (LibrariesTest 34 passed). Do this PRD before PRD 03: the test totals in PRDs 03–11 include its two new tests.

## 2. This PRD is already verified
- Both files passed on **Arc Foundry v0.8.0-2** with `FOUNDRY_PROFILE=arc` against the T-011 contract: `OpenEvidenceLogTest` 20 passed, `OpenEvidenceLogInvariant` 6 passed (256 runs, depth 64), `fmt --check` clean.
- Measured `commit` gas (first `EVIDENCE_BATCH`, including the 21k base): 123,377, inside the 120–135k estimate.

## 3. Sources (read these, nothing else)
- `07-contract-build/00-conventions.md` §5 (tests).
- `docs/specs/03-smart-contracts/open-evidence-log.md` §6 (functions, errors, gas), §10 (OEL-1 … OEL-6).
- `docs/specs/05-build-plan/phase-1-tasks.md` T-011 ("D88 follow-up (G-61)").

## 4. Files
| File | Action | Section |
|---|---|---|
| `contracts/test/OpenEvidenceLogTest.t.sol` | replace | §5 |
| `contracts/test/invariant/OpenEvidenceLogInvariant.t.sol` | replace | §6 |

## 5. `test/OpenEvidenceLogTest.t.sol` (replace the whole file)
- Changes against the T-011 file: the header cites `open-evidence-log.md`; two constants (`TX_BASE_GAS`, `COMMIT_GAS_ESTIMATE_MAX`); `test_commitProbeIntent_stalePrev_revertsPrevMismatch`; `test_reveal_rootCommittedUnderOtherKind_revertsUnknownIntent`; `test_gas_commitEvidenceBatch` adds the base and uses `assertLe` against the estimate.
```solidity
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
```

## 6. `test/invariant/OpenEvidenceLogInvariant.t.sol` (replace the whole file)
- Changes against the T-011 file: the handler's `ghostDonated` and `_intentsOfOthers`; `_checkOthersUnchanged` takes the intent hash too; `invariant_OEL5_noValueMovement` is `view` and compares with `ghostDonated`; the invariant contract no longer has `lastUsdcBalance`; the header cites `open-evidence-log.md`.
```solidity
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
```

## 7. Build steps
1. Replace both files (§5, §6).
2. `FOUNDRY_PROFILE=arc arc-forge test -vv --match-contract OpenEvidenceLogTest`: 20 passed; the log line `commit EVIDENCE_BATCH gas (first, including the 21k base)` shows about 123,377. Paste it into your report.
3. `FOUNDRY_PROFILE=arc arc-forge test --match-contract OpenEvidenceLogInvariant`: 6 passed (about a minute).
4. `arc-forge fmt --check test/OpenEvidenceLogTest.t.sol test/invariant/OpenEvidenceLogInvariant.t.sol`: nothing printed apart from the flag notice.
5. `FOUNDRY_PROFILE=arc arc-forge test`: the full suite.

## 8. Definition of done
- `FOUNDRY_PROFILE=arc arc-forge test --match-contract OpenEvidenceLog` → `OpenEvidenceLogTest` 20 passed and `OpenEvidenceLogInvariant` 6 passed, 0 failed.
- `FOUNDRY_PROFILE=arc arc-forge test` → 85 passed, 0 failed (PRD 01's 34, the repository's earlier tests, and the 2 new ones here).
- `git diff --stat -- contracts/src` → nothing (no contract change).
- The measured `commit` gas is in the task report.

## 9. Stop conditions
- A test fails: the contract may differ from `open-evidence-log.md` §6. Stop and report the test and the failure line; never change the contract in this PRD.

## Change log
| Date | Change |
|---|---|
| 2026-10-20 | First version, verified on Arc Foundry v0.8.0-2. |
