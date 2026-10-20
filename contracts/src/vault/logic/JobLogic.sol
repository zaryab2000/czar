// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../../interfaces/ICzarVault.sol";
import {IJobEscrowAdapter} from "../../interfaces/IJobEscrowAdapter.sol";
import {VaultState, VaultConfig} from "../VaultState.sol";
import {VaultGuards} from "../VaultGuards.sol";
import {JobEscrowAdapter} from "../../libraries/JobEscrowAdapter.sol";
import {PayeeLeaf} from "../../libraries/PayeeLeaf.sol";
import {
    PAYEE_KIND_JOB,
    POCKET_STEP_INDEX,
    MIN_JOB_EXPIRY_LEAD,
    MAX_JOB_FEE_BPS,
    CANCEL_REASON,
    CZAR_ESCROW_EVALUATION_GRACE
} from "../../libraries/CzarConstants.sol";

/// @title JobLogic
/// @notice Job lifecycle (czar-vault.md §5.5, §8.4, §15; job-escrow-adapter.md; T-018) in a linked library.
library JobLogic {
    struct OpenJobRequest {
        uint64 envelopeId;
        uint32 stepIndex;
        address provider;
        uint256 stepCap;
        uint64 expiredAt;
        bytes32 descriptionHash;
    }

    // ───────────── Open and fund ─────────────

    /// @notice Opens one planned job with the vault as escrow client (czar-vault.md §5.5, §15.3).
    function openJob(
        VaultState storage s,
        VaultConfig memory c,
        address caller,
        OpenJobRequest memory q,
        bytes32[] calldata proof
    ) external returns (bytes32 jobKey) {
        _checkOpenJob(s, c, caller, q, proof);
        return _storeJob(s, c, q);
    }

    /// @dev Checks role, plan, step exclusivity, and exposure before opening (czar-vault.md §15.3).
    function _checkOpenJob(
        VaultState storage s,
        VaultConfig memory c,
        address caller,
        OpenJobRequest memory q,
        bytes32[] calldata proof
    ) private view {
        VaultGuards.requireAgent(s, caller);
        VaultGuards.requireNotPausedOrFrozen(s, c);
        ICzarVault.Envelope storage e = s.envelopes[q.envelopeId];
        if (e.state != ICzarVault.EnvelopeState.Open) revert ICzarVault.EnvelopeNotOpen();
        if (block.timestamp >= e.expiresAt) revert ICzarVault.EnvelopeExpired();
        if (q.stepIndex == POCKET_STEP_INDEX || q.stepCap > e.maxStepAmount) revert ICzarVault.BadParams();
        if (q.expiredAt < block.timestamp + MIN_JOB_EXPIRY_LEAD || q.expiredAt > e.expiresAt) {
            revert ICzarVault.BadParams();
        }
        if (q.provider == s.evaluator) revert ICzarVault.BadParams();
        if (!PayeeLeaf.verify(proof, e.payeeRoot, q.provider, PAYEE_KIND_JOB, q.stepIndex, q.stepCap)) {
            revert ICzarVault.PayeeNotInPlan();
        }
        uint256 used = s.stepUsed[q.envelopeId][q.stepIndex];
        if (used + q.stepCap > q.stepCap) {
            revert ICzarVault.StepCapExceeded(q.stepIndex, used, q.stepCap, q.stepCap);
        }
        if (VaultGuards.exposure(e) + q.stepCap > e.cap) revert ICzarVault.CapExceeded();
    }

    /// @dev Reserves the step before creating the external job (czar-vault.md §5.5, §15.5).
    function _storeJob(VaultState storage s, VaultConfig memory c, OpenJobRequest memory q)
        private
        returns (bytes32 jobKey)
    {
        ICzarVault.Envelope storage e = s.envelopes[q.envelopeId];
        e.reserved += q.stepCap;
        e.openJobs += 1;
        uint256 used = s.stepUsed[q.envelopeId][q.stepIndex] + q.stepCap;
        s.stepUsed[q.envelopeId][q.stepIndex] = used;
        address evaluator = s.evaluator;
        uint256 jobId =
            JobEscrowAdapter.create(_kind(c), c.jobEscrow, q.provider, evaluator, q.expiredAt, q.descriptionHash);
        jobKey = keccak256(abi.encode(c.jobEscrow, jobId));
        ICzarVault.Job storage j = s.jobs[jobKey];
        j.provider = q.provider;
        j.envelopeId = q.envelopeId;
        j.stepIndex = q.stepIndex;
        j.state = ICzarVault.JobState.Opened;
        j.expiredAt = q.expiredAt;
        j.jobId = jobId;
        j.reservedCap = q.stepCap;
        emit ICzarVault.JobOpened(
            jobKey, q.envelopeId, q.provider, q.stepIndex, c.jobEscrow, jobId, evaluator, q.stepCap, q.descriptionHash
        );
        emit ICzarVault.StepUsed(q.envelopeId, q.stepIndex, used);
    }

    /// @notice Funds an open job at the current expected budget (czar-vault.md §5.5, §15.3).
    function fundJob(VaultState storage s, VaultConfig memory c, address caller, bytes32 jobKey, uint256 expectedBudget)
        external
    {
        ICzarVault.Job storage j = s.jobs[jobKey];
        uint256 b = _checkFundJob(s, c, caller, j, expectedBudget);
        ICzarVault.Envelope storage e = s.envelopes[j.envelopeId];
        uint256 unused = j.reservedCap - b;
        e.reserved -= j.reservedCap;
        e.jobEscrowed += b;
        s.committedTotal -= b;
        s.stepUsed[j.envelopeId][j.stepIndex] -= unused;
        j.budget = b;
        j.state = ICzarVault.JobState.Funded;
        JobEscrowAdapter.fund(_kind(c), c.jobEscrow, c.usdc, j.jobId, b);
        emit ICzarVault.JobFunded(jobKey, b);
        if (unused != 0) {
            emit ICzarVault.StepUsed(j.envelopeId, j.stepIndex, s.stepUsed[j.envelopeId][j.stepIndex]);
        }
    }

    /// @dev Checks escrow budget, fees and token in funding order (czar-vault.md §15.3).
    function _checkFundJob(
        VaultState storage s,
        VaultConfig memory c,
        address caller,
        ICzarVault.Job storage j,
        uint256 expectedBudget
    ) private view returns (uint256 b) {
        VaultGuards.requireAgent(s, caller);
        VaultGuards.requireNotPausedOrFrozen(s, c);
        if (j.state != ICzarVault.JobState.Opened) revert ICzarVault.JobWrongState();
        ICzarVault.Envelope storage e = s.envelopes[j.envelopeId];
        if (e.state != ICzarVault.EnvelopeState.Open) revert ICzarVault.EnvelopeNotOpen();
        if (block.timestamp >= e.expiresAt) revert ICzarVault.EnvelopeExpired();
        IJobEscrowAdapter.EscrowStatus status;
        address token;
        (b, status, token) = JobEscrowAdapter.readBudget(_kind(c), c.jobEscrow, j.jobId);
        if (status != IJobEscrowAdapter.EscrowStatus.Open) revert ICzarVault.JobNotOpen();
        if (block.timestamp >= j.expiredAt) revert ICzarVault.JobNotOpen();
        if (b != expectedBudget) revert ICzarVault.BudgetChanged(expectedBudget, b);
        if (b == 0) revert ICzarVault.BadParams();
        if (b > j.reservedCap) revert ICzarVault.BudgetExceedsReserved();
        (uint256 platformBp, uint256 evaluatorBp) = JobEscrowAdapter.readFees(_kind(c), c.jobEscrow);
        if (_kind(c) == IJobEscrowAdapter.JobEscrowKind.CircleTestnet
                ? platformBp != 0 || evaluatorBp != 0
                : platformBp + evaluatorBp > MAX_JOB_FEE_BPS) revert ICzarVault.UnexpectedFees(platformBp, evaluatorBp);
        if (token != c.usdc) revert ICzarVault.WrongToken();
    }

    // ───────────── Cancel ─────────────

    /// @notice Cancels an opened, unfunded job (czar-vault.md §5.5, H2).
    function cancelJob(VaultState storage s, VaultConfig memory c, address caller, bytes32 jobKey) external {
        VaultGuards.requireOwnerOrAgent(s, c, caller);
        ICzarVault.Job storage j = s.jobs[jobKey];
        if (j.state != ICzarVault.JobState.Opened) revert ICzarVault.JobWrongState();
        (IJobEscrowAdapter.EscrowStatus status,,,) = JobEscrowAdapter.readOutcome(_kind(c), c.jobEscrow, j.jobId);
        if (status != IJobEscrowAdapter.EscrowStatus.Open) {
            revert ICzarVault.JobNotCancellable(uint8(status));
        }
        bool released = _releaseOpened(s, j);
        JobEscrowAdapter.cancel(_kind(c), c.jobEscrow, j.jobId, CANCEL_REASON);
        emit ICzarVault.JobCancelled(jobKey);
        if (released) {
            emit ICzarVault.StepUsed(j.envelopeId, j.stepIndex, s.stepUsed[j.envelopeId][j.stepIndex]);
        }
    }

    // ───────────── Sync and refund ─────────────

    /// @notice Mirrors escrow status into vault accounting (czar-vault.md §5.5, RV-009).
    function syncJob(VaultState storage s, VaultConfig memory c, bytes32 jobKey) external {
        ICzarVault.Job storage j = s.jobs[jobKey];
        ICzarVault.JobState state = j.state;
        if (
            state != ICzarVault.JobState.Opened && state != ICzarVault.JobState.Funded
                && state != ICzarVault.JobState.Submitted
        ) {
            revert ICzarVault.JobWrongState();
        }
        (IJobEscrowAdapter.EscrowStatus status,, uint256 settled,) =
            JobEscrowAdapter.readOutcome(_kind(c), c.jobEscrow, j.jobId);
        if (state == ICzarVault.JobState.Opened) {
            _syncOpened(s, jobKey, j, status);
        } else if (status == IJobEscrowAdapter.EscrowStatus.Submitted && state == ICzarVault.JobState.Funded) {
            j.state = ICzarVault.JobState.Submitted;
            emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Submitted), false);
        } else if (status == IJobEscrowAdapter.EscrowStatus.Completed) {
            ICzarVault.Envelope storage e = s.envelopes[j.envelopeId];
            e.jobEscrowed -= j.budget;
            e.spent += j.budget;
            if (e.state == ICzarVault.EnvelopeState.Open) e.openJobs -= 1;
            j.state = ICzarVault.JobState.Completed;
            emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Completed), false);
        } else if (
            status == IJobEscrowAdapter.EscrowStatus.Rejected || status == IJobEscrowAdapter.EscrowStatus.Expired
        ) {
            (uint256 refund, bool credited) = _bookRefund(s, c, j, settled);
            emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Refunded), credited);
            if (credited && refund != 0) {
                emit ICzarVault.StepUsed(j.envelopeId, j.stepIndex, s.stepUsed[j.envelopeId][j.stepIndex]);
            }
        } else {
            revert ICzarVault.NoChange();
        }
    }

    /// @dev Releases an opened job when escrow or expiry makes it unusable (czar-vault.md §5.5, H1).
    function _syncOpened(
        VaultState storage s,
        bytes32 jobKey,
        ICzarVault.Job storage j,
        IJobEscrowAdapter.EscrowStatus status
    ) private {
        if (status == IJobEscrowAdapter.EscrowStatus.Funded) revert ICzarVault.NoChange();
        bool envelopeClosed = s.envelopes[j.envelopeId].state != ICzarVault.EnvelopeState.Open;
        if (status == IJobEscrowAdapter.EscrowStatus.Open && block.timestamp < j.expiredAt && !envelopeClosed) {
            revert ICzarVault.NoChange();
        }
        bool released = _releaseOpened(s, j);
        emit ICzarVault.JobSynced(jobKey, uint8(ICzarVault.JobState.Released), false);
        if (released) {
            emit ICzarVault.StepUsed(j.envelopeId, j.stepIndex, s.stepUsed[j.envelopeId][j.stepIndex]);
        }
    }

    /// @notice Claims an expired escrow refund and books it (czar-vault.md §5.5, §15.7).
    function claimJobRefund(VaultState storage s, VaultConfig memory c, bytes32 jobKey) external {
        ICzarVault.Job storage j = s.jobs[jobKey];
        if (j.state != ICzarVault.JobState.Funded && j.state != ICzarVault.JobState.Submitted) {
            revert ICzarVault.JobWrongState();
        }
        (IJobEscrowAdapter.EscrowStatus status,,,) = JobEscrowAdapter.readOutcome(_kind(c), c.jobEscrow, j.jobId);
        uint256 opensAt = j.expiredAt;
        if (_kind(c) == IJobEscrowAdapter.JobEscrowKind.CzarBase && status == IJobEscrowAdapter.EscrowStatus.Submitted)
        {
            opensAt += CZAR_ESCROW_EVALUATION_GRACE;
        }
        if (block.timestamp < opensAt) revert ICzarVault.NotExpired();
        JobEscrowAdapter.claimRefund(_kind(c), c.jobEscrow, j.jobId);
        (,, uint256 settled,) = JobEscrowAdapter.readOutcome(_kind(c), c.jobEscrow, j.jobId);
        (uint256 refund, bool credited) = _bookRefund(s, c, j, settled);
        emit ICzarVault.JobRefunded(jobKey, refund, credited);
        if (credited && refund != 0) {
            emit ICzarVault.StepUsed(j.envelopeId, j.stepIndex, s.stepUsed[j.envelopeId][j.stepIndex]);
        }
    }

    // ───────────── Helpers ─────────────

    /// @dev Releases an unfunded cap once (czar-vault.md §5.5, INV-16).
    function _releaseOpened(VaultState storage s, ICzarVault.Job storage j) private returns (bool stepChanged) {
        j.state = ICzarVault.JobState.Released;
        ICzarVault.Envelope storage e = s.envelopes[j.envelopeId];
        if (e.state != ICzarVault.EnvelopeState.Open) return false;
        e.reserved -= j.reservedCap;
        e.openJobs -= 1;
        s.stepUsed[j.envelopeId][j.stepIndex] -= j.reservedCap;
        return j.reservedCap != 0;
    }

    /// @dev Books a refund proven by escrow status (job-escrow-adapter.md §6, RV-011).
    function _bookRefund(VaultState storage s, VaultConfig memory c, ICzarVault.Job storage j, uint256 settled)
        private
        returns (uint256 refund, bool credited)
    {
        ICzarVault.Envelope storage e = s.envelopes[j.envelopeId];
        uint256 budget = j.budget;
        refund = budget - settled;
        e.jobEscrowed -= budget;
        e.spent += budget - refund;
        j.state = ICzarVault.JobState.Refunded;
        if (e.state == ICzarVault.EnvelopeState.Open) {
            VaultGuards.creditEnvelope(s, c, j.envelopeId, e, refund);
            s.stepUsed[j.envelopeId][j.stepIndex] -= refund;
            e.openJobs -= 1;
            credited = true;
        }
    }

    /// @dev Converts the constructor-validated escrow kind (czar-vault.md §15.8).
    function _kind(VaultConfig memory c) private pure returns (IJobEscrowAdapter.JobEscrowKind) {
        return IJobEscrowAdapter.JobEscrowKind(c.jobEscrowKind);
    }
}
