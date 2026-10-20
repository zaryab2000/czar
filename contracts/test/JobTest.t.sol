// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {ICzarVault} from "../src/interfaces/ICzarVault.sol";
import {ICzarVaultFactory} from "../src/interfaces/ICzarVaultFactory.sol";
import {ICircleTestnetAgenticCommerce} from "../src/interfaces/IJobEscrowAdapter.sol";
import {PayeeLeaf} from "../src/libraries/PayeeLeaf.sol";
import {
    USDC_ADDRESS,
    MIN_JOB_EXPIRY_LEAD,
    CANCEL_REASON,
    CZAR_ESCROW_EVALUATION_GRACE,
    FORCE_CLOSE_DELAY,
    PAYEE_KIND_X402,
    PAYEE_KIND_JOB
} from "../src/libraries/CzarConstants.sol";
import {MockCzarJobEscrow} from "./mocks/MockCzarJobEscrow.sol";
import {MockVaultFactory} from "./mocks/MockVaultFactory.sol";
import {VaultTestBase} from "./helpers/VaultTestBase.sol";
import {PayeeTree} from "./helpers/PayeeTree.sol";

/// @dev The escrow event both instances emit on a reject (ERC-8183), declared here for expectEmit.
interface IEscrowRejectEvent {
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
}

/// @notice T-018, 07 PRD 09. Every test in JobTestBase runs against both escrow kinds: JobCircleTest (kind 0,
///         Circle's testnet instance) and JobCzarTest (kind 1, CzarJobEscrow). czar-vault.md §5.5, §8.4, §15;
///         job-escrow-adapter.md; INV-2, INV-12, INV-16, JOB-1 … JOB-5; security-and-testing.md §3.7, §3.7a.
abstract contract JobTestBase is VaultTestBase, PayeeTree {
    uint256 internal constant CAP = 4 * ONE_USDC;
    uint64 internal constant LIFETIME = 1 days;
    uint64 internal constant JOB_LIFETIME = 1 hours;
    uint256 internal constant BUDGET = 300_000;
    bytes32 internal constant DESCRIPTION_HASH = 0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff;
    string internal constant DESCRIPTION = "czar:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    bytes32 internal constant DELIVERABLE = keccak256("deliverable");
    bytes32 internal constant REPORT = keccak256("report");
    uint8 internal constant ESCROW_SUBMITTED = 2;
    uint8 internal constant ESCROW_REJECTED = 4;
    address internal constant PROVIDER_ALT = address(0xd00e); // a second job leaf on STEP_JOB (two-leaf trees)

    uint64 internal env;

    function setUp() public virtual override {
        super.setUp();
        _fundVault(10 * ONE_USDC);
        env = _openEnvelope(CAP, ONE_USDC, PAYEE_ROOT);
    }

    // ───────────── Kind hooks ─────────────

    function _escrow() internal view virtual returns (address);
    function _setBudget(uint256 jobId, uint256 amount) internal virtual;
    function _escrowDescription(uint256 jobId) internal view virtual returns (string memory);
    function _escrowStatus(uint256 jobId) internal view virtual returns (uint8);

    // ───────────── Helpers ─────────────

    function _openEnvelope(uint256 cap, uint256 maxStep, bytes32 root) internal returns (uint64 id) {
        ICzarVault.OpenEnvelopeParams memory p;
        p.cap = cap;
        p.maxStepAmount = maxStep;
        p.expiresAt = uint64(block.timestamp + LIFETIME);
        p.categoryId = keccak256("category");
        p.payeeRoot = root;
        vm.prank(owner);
        id = vault.openEnvelope(p);
    }

    /// @dev A two-leaf payeeRoot (czar-merkle-v1: the root is the sorted-pair hash; each proof is the other leaf).
    function _twoLeafRoot(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return Hashes.commutativeKeccak256(a, b);
    }

    function _one(bytes32 x) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = x;
    }

    function _open() internal returns (bytes32 jobKey) {
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(agent);
        jobKey = vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
    }

    function _openAndFund(uint256 budget) internal returns (bytes32 jobKey) {
        jobKey = _open();
        _setBudget(vault.getJob(jobKey).jobId, budget);
        vm.prank(agent);
        vault.fundJob(jobKey, budget);
    }

    function _escrowCall() internal view returns (ICircleTestnetAgenticCommerce) {
        return ICircleTestnetAgenticCommerce(_escrow()); // submit / complete / reject / claimRefund share selectors
    }

    function _submit(uint256 jobId) internal {
        vm.prank(PROVIDER_D00D);
        _escrowCall().submit(jobId, DELIVERABLE, "");
    }

    function _evaluatorReject(uint256 jobId) internal {
        vm.prank(evaluatorKey);
        _escrowCall().reject(jobId, REPORT, "");
    }

    function _evaluatorComplete(uint256 jobId) internal {
        vm.prank(evaluatorKey);
        _escrowCall().complete(jobId, REPORT, "");
    }

    function _assertInv2() internal view {
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        if (e.state == ICzarVault.EnvelopeState.Open) {
            assertEq(vault.committedTotal(), e.cap - e.spent - e.pocketOutstanding - e.jobEscrowed - e.shortfall);
        }
        assertLe(vault.committedTotal(), usdc.balanceOf(address(vault)));
    }

    /// @dev The Released transition left nothing behind: reserved, stepUsed and openJobs are back to 0.
    function _assertReleased(bytes32 jobKey) internal view {
        assertEq(uint8(vault.getJob(jobKey).state), uint8(ICzarVault.JobState.Released));
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.reserved, 0);
        assertEq(e.openJobs, 0);
        assertEq(vault.stepUsed(env, STEP_JOB), 0);
    }

    // ───────────── openJob ─────────────

    function test_openJob_createsEscrowJobAndReserves() public {
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        bytes32 expectedKey = keccak256(abi.encode(_escrow(), uint256(1)));
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobOpened(
            expectedKey, env, PROVIDER_D00D, STEP_JOB, _escrow(), 1, evaluatorKey, STEP_JOB_CAP, DESCRIPTION_HASH
        );
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_JOB, STEP_JOB_CAP);
        vm.prank(agent);
        bytes32 jobKey = vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
        assertEq(jobKey, expectedKey);
        ICzarVault.Job memory j = vault.getJob(jobKey);
        assertEq(j.provider, PROVIDER_D00D);
        assertEq(j.envelopeId, env);
        assertEq(j.stepIndex, STEP_JOB);
        assertEq(uint8(j.state), uint8(ICzarVault.JobState.Opened));
        assertEq(j.expiredAt, expiredAt);
        assertEq(j.jobId, 1);
        assertEq(j.reservedCap, STEP_JOB_CAP);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.reserved, STEP_JOB_CAP);
        assertEq(e.openJobs, 1);
        assertEq(vault.stepUsed(env, STEP_JOB), STEP_JOB_CAP);
        assertEq(_escrowDescription(1), DESCRIPTION); // JOB-3: 69 ASCII characters, no "0x"
        assertEq(bytes(_escrowDescription(1)).length, 69);
        _assertInv2();
    }

    function test_openJob_notAgent_reverts() public {
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.NotAgent.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
    }

    function test_openJob_frozenOrPaused_reverts() public {
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(owner);
        vault.freeze();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.FrozenVault.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
        vm.prank(owner);
        vault.unfreeze();
        vaultFactory.setGuardianPaused(true);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.Paused.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
    }

    function test_openJob_envelopeState_revert() public {
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.EnvelopeNotOpen.selector);
        vault.openJob(env + 1, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
        vm.warp(block.timestamp + LIFETIME);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.EnvelopeExpired.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
    }

    function test_openJob_badParams_revert() public {
        bytes32[] memory proof = _proofD00d();
        uint64 ok = uint64(block.timestamp + JOB_LIFETIME);
        uint64 tooSoon = uint64(block.timestamp + MIN_JOB_EXPIRY_LEAD - 1);
        uint64 afterEnvelope = vault.getEnvelope(env).expiresAt + 1;
        uint32 pocketStep = vault.POCKET_STEP_INDEX();
        vm.startPrank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.openJob(env, pocketStep, PROVIDER_D00D, STEP_JOB_CAP, proof, ok, DESCRIPTION_HASH);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, ONE_USDC + 1, proof, ok, DESCRIPTION_HASH);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, tooSoon, DESCRIPTION_HASH);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, afterEnvelope, DESCRIPTION_HASH);
        vm.stopPrank();
    }

    function test_openJob_minimumLead_accepted() public {
        bytes32[] memory proof = _proofD00d();
        uint64 edge = uint64(block.timestamp + MIN_JOB_EXPIRY_LEAD);
        vm.prank(agent);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, edge, DESCRIPTION_HASH);
    }

    /// @dev JOB-2: the vault always names its own evaluator, which may never be the provider.
    function test_openJob_providerIsEvaluator_reverts() public {
        vm.prank(owner);
        vault.rotateSigners(agent, autonomy, PROVIDER_D00D);
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
    }

    /// @dev JOB-2: the provider must be a kind-2 leaf of payeeRoot with the exact step and cap.
    function test_openJob_notInPlan_reverts() public {
        bytes32[] memory proof = _proofD00d();
        bytes32[] memory payeeProof = _proofBeef();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.startPrank(agent);
        vm.expectRevert(ICzarVault.PayeeNotInPlan.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP - 1, proof, expiredAt, DESCRIPTION_HASH);
        vm.expectRevert(ICzarVault.PayeeNotInPlan.selector);
        vault.openJob(env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, payeeProof, expiredAt, DESCRIPTION_HASH);
        vm.stopPrank();
    }

    /// @dev RV-002 named test: a job needs the whole step cap free, so a reservation on the step blocks it.
    function test_openJob_afterReserveOnSameStep_reverts() public {
        bytes32 x402Leaf = PayeeLeaf.hash(PAYEE_BEEF, PAYEE_KIND_X402, STEP_JOB, STEP_JOB_CAP);
        bytes32 jobLeaf = PayeeLeaf.hash(PROVIDER_D00D, PAYEE_KIND_JOB, STEP_JOB, STEP_JOB_CAP);
        env = _openEnvelope(CAP, ONE_USDC, _twoLeafRoot(x402Leaf, jobLeaf));
        vm.prank(agent);
        vault.reserve(env, STEP_JOB, PAYEE_BEEF, STEP_JOB_CAP, _one(jobLeaf), 10_000, 1, uint64(block.timestamp + 60));
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        bytes32[] memory proof = _one(x402Leaf);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(ICzarVault.StepCapExceeded.selector, STEP_JOB, 10_000, STEP_JOB_CAP, STEP_JOB_CAP)
        );
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
    }

    /// @dev RV-009 named test (D88, G-19): two openJob calls on one step can never both succeed.
    function test_closeEnvelope_afterDuplicateOpenJobRetry() public {
        bytes32 first = _open(); // the agent lost this receipt and retries
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICzarVault.StepCapExceeded.selector, STEP_JOB, STEP_JOB_CAP, STEP_JOB_CAP, STEP_JOB_CAP
            )
        );
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
        vm.warp(vault.getJob(first).expiredAt);
        vault.syncJob(first);
        _assertReleased(first);
        vm.prank(owner);
        vault.closeEnvelope(env);
    }

    function test_openJob_envelopeCap_reverts() public {
        env = _openEnvelope(ONE_USDC, ONE_USDC, PAYEE_ROOT);
        bytes32[] memory payeeProof = _proofBeef();
        vm.prank(agent);
        vault.reserve(env, STEP_X402, PAYEE_BEEF, STEP_X402_CAP, payeeProof, 70_000, 10, uint64(block.timestamp + 60));
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.CapExceeded.selector);
        vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
    }

    // ───────────── fundJob ─────────────

    function test_fundJob_movesBudgetIntoEscrow() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        uint256 committedBefore = vault.committedTotal();
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobFunded(jobKey, BUDGET);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_JOB, BUDGET); // the unused 100,000 of the step cap is free again
        vm.prank(agent);
        vault.fundJob(jobKey, BUDGET);
        ICzarVault.Job memory j = vault.getJob(jobKey);
        assertEq(uint8(j.state), uint8(ICzarVault.JobState.Funded));
        assertEq(j.budget, BUDGET);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.reserved, 0);
        assertEq(e.jobEscrowed, BUDGET);
        assertEq(vault.committedTotal(), committedBefore - BUDGET);
        assertEq(vault.stepUsed(env, STEP_JOB), BUDGET);
        assertEq(usdc.balanceOf(_escrow()), BUDGET);
        assertEq(usdc.allowance(address(vault), _escrow()), 0); // approval reset
        _assertInv2();
    }

    function test_fundJob_fullStepCap_emitsNoStepUsed() public {
        bytes32 jobKey = _open();
        _setBudget(1, STEP_JOB_CAP);
        vm.recordLogs();
        vm.prank(agent);
        vault.fundJob(jobKey, STEP_JOB_CAP);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(vault)) assertTrue(logs[i].topics[0] != ICzarVault.StepUsed.selector);
        }
    }

    function test_fundJob_notAgent_reverts() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        vm.prank(owner);
        vm.expectRevert(ICzarVault.NotAgent.selector);
        vault.fundJob(jobKey, BUDGET);
    }

    /// @dev RV-006 named test.
    function test_fundJob_whileFrozenOrPaused_reverts() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        vm.prank(agent);
        vault.freeze();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.FrozenVault.selector);
        vault.fundJob(jobKey, BUDGET);
        vm.prank(owner);
        vault.unfreeze();
        vaultFactory.setGuardianPaused(true);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.Paused.selector);
        vault.fundJob(jobKey, BUDGET);
    }

    function test_fundJob_wrongState_reverts() public {
        vm.prank(agent);
        vm.expectRevert(ICzarVault.JobWrongState.selector);
        vault.fundJob(keccak256("unknown"), BUDGET);
        bytes32 jobKey = _openAndFund(BUDGET);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.JobWrongState.selector);
        vault.fundJob(jobKey, BUDGET);
    }

    /// @dev RV-005 / RV-006: no funding once the envelope is expired.
    function test_fundJob_envelopeExpired_reverts() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        vm.warp(vault.getEnvelope(env).expiresAt);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.EnvelopeExpired.selector);
        vault.fundJob(jobKey, BUDGET);
    }

    /// @dev RV-005 named test: after a force-close, fundJob reverts and syncJob releases without accounting.
    function test_forceClose_openedJob_fundJobReverts() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        vm.warp(vault.getEnvelope(env).expiresAt + FORCE_CLOSE_DELAY);
        vm.prank(owner);
        vault.forceCloseEnvelope(env);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.EnvelopeNotOpen.selector);
        vault.fundJob(jobKey, BUDGET);
        uint256 committed = vault.committedTotal();
        vm.recordLogs();
        vault.syncJob(jobKey);
        assertEq(vm.getRecordedLogs().length, 1); // JobSynced only: no StepUsed for a closed envelope
        assertEq(uint8(vault.getJob(jobKey).state), uint8(ICzarVault.JobState.Released));
        assertEq(vault.committedTotal(), committed);
    }

    /// @dev H1 named test: a provider's zero-budget submit leaves nothing to fund.
    function test_fundJob_afterEarlySubmit_revertsJobNotOpen() public {
        bytes32 jobKey = _open();
        _submit(1);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.JobNotOpen.selector);
        vault.fundJob(jobKey, 0);
    }

    function test_fundJob_atOrAfterJobExpiry_revertsJobNotOpen() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        vm.warp(vault.getJob(jobKey).expiredAt);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.JobNotOpen.selector);
        vault.fundJob(jobKey, BUDGET);
    }

    /// @dev M1-b named test: the provider changed the budget after the agent read it.
    function test_fundJob_budgetChanged_reverts() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET + 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.BudgetChanged.selector, BUDGET, BUDGET + 1));
        vault.fundJob(jobKey, BUDGET);
    }

    /// @dev R2 named test: both instances accept a budget of 0 at fund, so the vault refuses it.
    function test_fundJob_zeroBudget_reverts() public {
        bytes32 jobKey = _open();
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.fundJob(jobKey, 0); // never set
        _setBudget(1, 0);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BadParams.selector);
        vault.fundJob(jobKey, 0);
    }

    /// @dev JOB-1.
    function test_fundJob_budgetAboveReservedCap_reverts() public {
        bytes32 jobKey = _open();
        _setBudget(1, STEP_JOB_CAP + 1);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.BudgetExceedsReserved.selector);
        vault.fundJob(jobKey, STEP_JOB_CAP + 1);
    }

    // ───────────── cancelJob ─────────────

    /// @dev H2 named test: the client reject releases the step, and the alternate payee can then open on it.
    function test_cancelJob_open_releasesAndAlternateOpens() public {
        bytes32 leafA = PayeeLeaf.hash(PROVIDER_D00D, PAYEE_KIND_JOB, STEP_JOB, STEP_JOB_CAP);
        bytes32 leafB = PayeeLeaf.hash(PROVIDER_ALT, PAYEE_KIND_JOB, STEP_JOB, STEP_JOB_CAP);
        env = _openEnvelope(CAP, ONE_USDC, _twoLeafRoot(leafA, leafB));
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        bytes32[] memory proofA = _one(leafB);
        vm.prank(agent);
        bytes32 jobKey = vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proofA, expiredAt, DESCRIPTION_HASH);
        vm.expectEmit(true, true, true, true, _escrow());
        emit IEscrowRejectEvent.JobRejected(1, address(vault), CANCEL_REASON);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobCancelled(jobKey);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_JOB, 0);
        vm.prank(agent);
        vault.cancelJob(jobKey);
        assertEq(_escrowStatus(1), ESCROW_REJECTED);
        _assertReleased(jobKey);
        bytes32[] memory proofB = _one(leafA);
        vm.prank(agent);
        vault.openJob(env, STEP_JOB, PROVIDER_ALT, STEP_JOB_CAP, proofB, expiredAt, DESCRIPTION_HASH);
        assertEq(vault.stepUsed(env, STEP_JOB), STEP_JOB_CAP);
    }

    function test_cancelJob_owner_releasesAndEnvelopeCloses() public {
        bytes32 jobKey = _open();
        vm.prank(owner);
        vault.cancelJob(jobKey);
        _assertReleased(jobKey);
        vm.prank(owner);
        vault.closeEnvelope(env);
    }

    /// @dev H2 named test: cancelJob only releases exposure, so freeze and pause do not block it.
    function test_cancelJob_frozen_allowed() public {
        bytes32 a = _open();
        vm.prank(owner);
        vault.freeze();
        vm.prank(agent);
        vault.cancelJob(a);
        _assertReleased(a);
        bytes32[] memory proof = _proofD00d();
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(owner);
        vault.unfreeze();
        vm.prank(agent);
        bytes32 b = vault.openJob(env, STEP_JOB, PROVIDER_D00D, STEP_JOB_CAP, proof, expiredAt, DESCRIPTION_HASH);
        vaultFactory.setGuardianPaused(true);
        vm.prank(owner);
        vault.cancelJob(b);
        _assertReleased(b);
    }

    function test_cancelJob_stranger_reverts() public {
        bytes32 jobKey = _open();
        vm.prank(stranger);
        vm.expectRevert(ICzarVault.NotAuthorized.selector);
        vault.cancelJob(jobKey);
    }

    /// @dev H2 named test.
    function test_cancelJob_funded_reverts() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        vm.prank(agent);
        vm.expectRevert(ICzarVault.JobWrongState.selector);
        vault.cancelJob(jobKey);
    }

    /// @dev N7 named test: a zero-budget submit landed first; cancel refuses and syncJob releases.
    function test_cancelJob_frontRunBySubmit_fallsBackToSync() public {
        bytes32 jobKey = _open();
        _submit(1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.JobNotCancellable.selector, ESCROW_SUBMITTED));
        vault.cancelJob(jobKey);
        vault.syncJob(jobKey);
        _assertReleased(jobKey);
    }

    // ───────────── syncJob from Opened (RV-009, H1) ─────────────

    /// @dev RV-009 named test: an Open escrow job is released once its expiredAt passes.
    function test_syncJob_openedAfterExpiry_released() public {
        bytes32 jobKey = _open();
        vm.expectRevert(ICzarVault.NoChange.selector);
        vault.syncJob(jobKey);
        vm.warp(vault.getJob(jobKey).expiredAt);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Released), false);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_JOB, 0);
        vm.prank(stranger); // anyone
        vault.syncJob(jobKey);
        _assertReleased(jobKey);
        _assertInv2();
        vm.prank(owner);
        vault.closeEnvelope(env);
    }

    /// @dev H1 named test.
    function test_syncJob_zeroBudgetSubmit_releases() public {
        bytes32 jobKey = _open();
        _submit(1);
        vault.syncJob(jobKey);
        _assertReleased(jobKey);
        vm.prank(owner);
        vault.closeEnvelope(env);
    }

    /// @dev H1 named test: the evaluator completed a zero-budget submission; no money ever moved.
    function test_syncJob_unfundedCompleted_releases() public {
        bytes32 jobKey = _open();
        _submit(1);
        _evaluatorComplete(1);
        uint256 balance = usdc.balanceOf(address(vault));
        vault.syncJob(jobKey);
        _assertReleased(jobKey);
        assertEq(usdc.balanceOf(address(vault)), balance);
        assertEq(vault.getEnvelope(env).spent, 0);
    }

    // ───────────── syncJob from Funded / Submitted ─────────────

    function test_syncJob_submittedThenCompleted_booksSpent() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        vm.expectRevert(ICzarVault.NoChange.selector);
        vault.syncJob(jobKey); // escrow still Funded
        _submit(1);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Submitted), false);
        vault.syncJob(jobKey);
        vm.expectRevert(ICzarVault.NoChange.selector);
        vault.syncJob(jobKey);
        _evaluatorComplete(1);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Completed), false);
        vault.syncJob(jobKey);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.jobEscrowed, 0);
        assertEq(e.spent, BUDGET);
        assertEq(e.openJobs, 0);
        assertEq(usdc.balanceOf(PROVIDER_D00D), BUDGET);
        _assertInv2();
        vm.expectRevert(ICzarVault.JobWrongState.selector);
        vault.syncJob(jobKey);
    }

    function test_syncJob_rejected_refundCreditsEnvelope() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        uint256 committedBefore = vault.committedTotal();
        _submit(1);
        _evaluatorReject(1); // D77: a deliverable mismatch is a reject; the escrow refunds in the same transaction
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Refunded), true);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_JOB, 0);
        vault.syncJob(jobKey);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.jobEscrowed, 0);
        assertEq(e.spent, 0);
        assertEq(e.openJobs, 0);
        assertEq(vault.committedTotal(), committedBefore + BUDGET);
        assertEq(uint8(vault.getJob(jobKey).state), uint8(ICzarVault.JobState.Refunded));
        _assertInv2();
    }

    /// @dev RV-011: the refund reached the vault but the owner withdrew it as free balance before the sync.
    function test_syncJob_refundAfterWithdraw_recordsShortfall() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        _evaluatorReject(1);
        uint256 free = vault.freeBalance();
        vm.prank(owner);
        vault.withdraw(owner, free);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.ShortfallRecorded(env, BUDGET, BUDGET);
        vault.syncJob(jobKey);
        assertEq(vault.envelopeShortfall(env), BUDGET);
        _assertInv2();
    }

    /// @dev RV-005: a refund after force-close is free balance (creditedToEnvelope = false).
    function test_syncJob_refundAfterForceClose_isFreeBalance() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        vm.warp(vault.getEnvelope(env).expiresAt + FORCE_CLOSE_DELAY);
        vm.prank(owner);
        vault.forceCloseEnvelope(env);
        assertEq(vault.getEnvelope(env).jobEscrowed, BUDGET); // still tracked for the job (JOB-4)
        uint256 freeBefore = vault.freeBalance();
        _evaluatorReject(1); // the refund lands in the vault as free balance; the sync only closes the record
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Refunded), false);
        vault.syncJob(jobKey);
        assertEq(vault.freeBalance(), freeBefore + BUDGET);
        assertEq(vault.committedTotal(), 0);
        assertEq(vault.getEnvelope(env).jobEscrowed, 0);
    }

    function test_syncJob_unknownJob_reverts() public {
        vm.expectRevert(ICzarVault.JobWrongState.selector);
        vault.syncJob(keccak256("unknown"));
    }

    // ───────────── claimJobRefund ─────────────

    function test_claimJobRefund_afterExpiry_refunds() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        uint64 expiredAt = vault.getJob(jobKey).expiredAt;
        vm.warp(expiredAt - 1);
        vm.expectRevert(ICzarVault.NotExpired.selector);
        vault.claimJobRefund(jobKey);
        vm.warp(expiredAt);
        uint256 committedBefore = vault.committedTotal();
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobRefunded(jobKey, BUDGET, true);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_JOB, 0);
        vm.prank(stranger); // anyone
        vault.claimJobRefund(jobKey);
        assertEq(vault.committedTotal(), committedBefore + BUDGET);
        assertEq(uint8(vault.getJob(jobKey).state), uint8(ICzarVault.JobState.Refunded));
        _assertInv2();
    }

    function test_claimJobRefund_wrongState_reverts() public {
        bytes32 jobKey = _open();
        vm.expectRevert(ICzarVault.JobWrongState.selector);
        vault.claimJobRefund(jobKey);
    }

    // ───────────── Fuzz: JOB-4 and INV-2 across fund and refund ─────────────

    function testFuzz_fundThenReject_restoresAccounting(uint256 budget) public {
        budget = bound(budget, 1, STEP_JOB_CAP);
        uint256 committed0 = vault.committedTotal();
        bytes32 jobKey = _openAndFund(budget);
        assertEq(vault.getEnvelope(env).jobEscrowed, budget); // JOB-4
        assertEq(vault.stepUsed(env, STEP_JOB), budget);
        _assertInv2();
        _evaluatorReject(1);
        vault.syncJob(jobKey);
        assertEq(vault.committedTotal(), committed0);
        assertEq(vault.stepUsed(env, STEP_JOB), 0);
        assertEq(vault.getEnvelope(env).jobEscrowed, 0);
        _assertInv2();
    }
}

/// @notice T-018, 07 PRD 09: kind 0, Circle's Arc testnet instance (VaultTestBase deploys MockCircleAgenticCommerce).
contract JobCircleTest is JobTestBase {
    function _escrow() internal view override returns (address) {
        return address(jobEscrow);
    }

    function _setBudget(uint256 jobId, uint256 amount) internal override {
        vm.prank(PROVIDER_D00D);
        jobEscrow.setBudget(jobId, amount, "");
    }

    function _escrowDescription(uint256 jobId) internal view override returns (string memory d) {
        (,,,, d,,,,) = jobEscrow.jobs(jobId);
    }

    function _escrowStatus(uint256 jobId) internal view override returns (uint8) {
        return uint8(jobEscrow.getJob(jobId).status);
    }

    /// @dev A4-07: Circle's instance must charge no fees at all.
    function test_fundJob_circleFees_revertUnexpectedFees() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        jobEscrow.setEvaluatorFee(1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.UnexpectedFees.selector, 0, 1));
        vault.fundJob(jobKey, BUDGET);
    }

    /// @dev Circle's instance has no evaluation grace: a Submitted job refunds at expiredAt.
    function test_claimJobRefund_circleSubmitted_noGrace() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        _submit(1);
        vault.syncJob(jobKey);
        vm.warp(vault.getJob(jobKey).expiredAt);
        vault.claimJobRefund(jobKey);
        assertEq(uint8(vault.getJob(jobKey).state), uint8(ICzarVault.JobState.Refunded));
    }
}

/// @notice T-018, 07 PRD 09: kind 1, CzarJobEscrow (erc-8183/base-contracts), with USDC on its token allowlist.
contract JobCzarTest is JobTestBase {
    MockCzarJobEscrow internal czarEscrow;

    function setUp() public override {
        VaultTestBase.setUp();
        czarEscrow = new MockCzarJobEscrow(treasury, address(this));
        czarEscrow.setPaymentTokenAllowed(USDC_ADDRESS, true);
        ICzarVaultFactory.NetworkConfig memory cfg = _networkConfig();
        cfg.jobEscrow = address(czarEscrow);
        cfg.jobEscrowKind = 1;
        vaultFactory = new MockVaultFactory(cfg, _defaults());
        vault = vaultFactory.deploy(owner);
        _fundVault(10 * ONE_USDC);
        env = _openEnvelope(CAP, ONE_USDC, PAYEE_ROOT);
    }

    function _escrow() internal view override returns (address) {
        return address(czarEscrow);
    }

    function _setBudget(uint256 jobId, uint256 amount) internal override {
        vm.prank(PROVIDER_D00D);
        czarEscrow.setBudget(jobId, USDC_ADDRESS, amount, "");
    }

    function _escrowDescription(uint256 jobId) internal view override returns (string memory) {
        return czarEscrow.getJob(jobId).description;
    }

    function _escrowStatus(uint256 jobId) internal view override returns (uint8) {
        return uint8(czarEscrow.getJob(jobId).status);
    }

    /// @dev The Czar instance allows fees up to MAX_JOB_FEE_BPS (500) in total.
    function test_fundJob_czarFees_boundedByMaxJobFeeBps() public {
        bytes32 jobKey = _open();
        _setBudget(1, BUDGET);
        czarEscrow.setPlatformFee(300, treasury);
        czarEscrow.setEvaluatorFee(201);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ICzarVault.UnexpectedFees.selector, 300, 201));
        vault.fundJob(jobKey, BUDGET);
        czarEscrow.setEvaluatorFee(200);
        vm.prank(agent);
        vault.fundJob(jobKey, BUDGET);
    }

    function test_fundJob_czarOtherToken_revertsWrongToken() public {
        address other = makeAddr("otherToken");
        czarEscrow.setPaymentTokenAllowed(other, true);
        bytes32 jobKey = _open();
        vm.prank(PROVIDER_D00D);
        czarEscrow.setBudget(1, other, BUDGET, "");
        vm.prank(agent);
        vm.expectRevert(ICzarVault.WrongToken.selector);
        vault.fundJob(jobKey, BUDGET);
    }

    /// @dev RV-009 named test: on the Czar instance the provider may reject while Open; the job is released.
    function test_syncJob_openedRejected_released() public {
        bytes32 jobKey = _open();
        vm.prank(PROVIDER_D00D);
        czarEscrow.reject(1, REPORT, "");
        vault.syncJob(jobKey);
        _assertReleased(jobKey);
        vm.prank(owner);
        vault.closeEnvelope(env);
    }

    /// @dev RV-009 named test, with the spec's figures: budget 1.0, settled 0.3 through approveClaim, then a reject
    ///      → credit 0.7 and spent 0.3. A one-leaf tree gives the provider a 1.0 USDC step (root = the leaf).
    function test_syncJob_czarPartialClaim_refundsBudgetMinusSettled() public {
        bytes32 leaf = PayeeLeaf.hash(PROVIDER_D00D, PAYEE_KIND_JOB, STEP_JOB, ONE_USDC);
        env = _openEnvelope(CAP, ONE_USDC, leaf);
        bytes32[] memory noProof = new bytes32[](0);
        uint64 expiredAt = uint64(block.timestamp + JOB_LIFETIME);
        vm.prank(agent);
        bytes32 jobKey = vault.openJob(env, STEP_JOB, PROVIDER_D00D, ONE_USDC, noProof, expiredAt, DESCRIPTION_HASH);
        _setBudget(1, ONE_USDC);
        vm.prank(agent);
        vault.fundJob(jobKey, ONE_USDC);
        uint256 committedBefore = vault.committedTotal();
        vm.prank(PROVIDER_D00D);
        czarEscrow.submitClaim(1, 300_000, DELIVERABLE, "");
        vm.prank(evaluatorKey);
        czarEscrow.approveClaim(1, 300_000, DELIVERABLE, "");
        _evaluatorReject(1);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Refunded), true);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.StepUsed(env, STEP_JOB, 300_000);
        vault.syncJob(jobKey);
        ICzarVault.Envelope memory e = vault.getEnvelope(env);
        assertEq(e.spent, 300_000);
        assertEq(e.jobEscrowed, 0);
        assertEq(vault.committedTotal(), committedBefore + 700_000);
        assertEq(vault.committedTotal(), CAP + (e.cap - e.spent)); // INV-2 over both open envelopes
    }

    /// @dev §15.7: a Submitted job on the Czar instance refunds only after expiredAt + 1 h; the status is the escrow's.
    function test_claimJobRefund_czarSubmitted_needsGrace() public {
        bytes32 jobKey = _openAndFund(BUDGET);
        _submit(1); // the vault record still says Funded
        uint64 expiredAt = vault.getJob(jobKey).expiredAt;
        vm.warp(expiredAt + CZAR_ESCROW_EVALUATION_GRACE - 1);
        vm.expectRevert(ICzarVault.NotExpired.selector);
        vault.claimJobRefund(jobKey);
        vm.warp(expiredAt + CZAR_ESCROW_EVALUATION_GRACE);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ICzarVault.JobRefunded(jobKey, BUDGET, true);
        vault.claimJobRefund(jobKey);
    }

    /// @dev RV-009: anyone may claimRefund an Open job on the Czar instance after expiry (Expired, no transfer).
    function test_syncJob_czarOpenJobExpiredByThirdParty_released() public {
        bytes32 jobKey = _open();
        vm.warp(vault.getJob(jobKey).expiredAt);
        vm.prank(stranger);
        czarEscrow.claimRefund(1);
        vault.syncJob(jobKey);
        _assertReleased(jobKey);
    }
}
