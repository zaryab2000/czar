// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {
    IJobEscrowAdapter,
    ICircleTestnetAgenticCommerce,
    ICzarJobEscrowClient
} from "../interfaces/IJobEscrowAdapter.sol";
import {DESCRIPTION_PREFIX} from "./CzarConstants.sol";

/// @title JobEscrowAdapter
/// @notice Vault-internal adapter over the two ERC-8183 instances (job-escrow-adapter.md §3, binding signatures,
///         D88 G-05). Selected by the vault's immutable `jobEscrowKind`. The library raises no errors of its own:
///         the vault does every check in czar-vault.md §15.3 order; external reverts bubble unchanged (§15.5).
///         `optParams` is always empty and `hook` is always `address(0)` (JOB-3, A4-03).
library JobEscrowAdapter {
    using SafeERC20 for IERC20;

    /// @dev Lowercase hex digits for the description encoder (§15.6).
    bytes16 private constant HEX_DIGITS = "0123456789abcdef";
    /// @dev 64 hex characters encode one bytes32.
    uint256 private constant HASH_HEX_LENGTH = 64;

    /// @notice createJob with the vault as client; description = "czar:" + 64 lowercase hex chars (JOB-3).
    function create(
        IJobEscrowAdapter.JobEscrowKind kind,
        address escrow,
        address provider,
        address evaluator,
        uint64 expiredAt,
        bytes32 descriptionHash
    ) internal returns (uint256 jobId) {
        string memory description = _description(descriptionHash);
        if (kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet) {
            jobId = ICircleTestnetAgenticCommerce(escrow)
                .createJob(provider, evaluator, uint256(expiredAt), description, address(0));
        } else {
            jobId = ICzarJobEscrowClient(escrow)
                .createJob(provider, evaluator, SafeCast.toUint48(expiredAt), description, address(0), 0);
        }
    }

    /// @notice Budget, status and payment token, read in the same transaction as fund (A4-05).
    function readBudget(IJobEscrowAdapter.JobEscrowKind kind, address escrow, uint256 jobId)
        internal
        view
        returns (uint256 budget, IJobEscrowAdapter.EscrowStatus status, address token)
    {
        if (kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet) {
            uint8 s;
            (,,,,, budget,, s,) = ICircleTestnetAgenticCommerce(escrow).jobs(jobId);
            status = IJobEscrowAdapter.EscrowStatus(s);
            token = ICircleTestnetAgenticCommerce(escrow).paymentToken();
        } else {
            ICzarJobEscrowClient.Job memory j = ICzarJobEscrowClient(escrow).getJob(jobId);
            (budget, status, token) = (j.budget, IJobEscrowAdapter.EscrowStatus(j.status), j.paymentToken);
        }
    }

    /// @notice platformFeeBP and evaluatorFeeBP (same selectors on both instances).
    function readFees(IJobEscrowAdapter.JobEscrowKind kind, address escrow)
        internal
        view
        returns (uint256 platformBp, uint256 evaluatorBp)
    {
        if (kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet) {
            platformBp = ICircleTestnetAgenticCommerce(escrow).platformFeeBP();
            evaluatorBp = ICircleTestnetAgenticCommerce(escrow).evaluatorFeeBP();
        } else {
            platformBp = ICzarJobEscrowClient(escrow).platformFeeBP();
            evaluatorBp = ICzarJobEscrowClient(escrow).evaluatorFeeBP();
        }
    }

    /// @notice Approve exactly `budget`, fund, reset the approval to 0 (§15.5 fundJob order).
    function fund(IJobEscrowAdapter.JobEscrowKind kind, address escrow, address usdc, uint256 jobId, uint256 budget)
        internal
    {
        IERC20(usdc).forceApprove(escrow, budget);
        if (kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet) {
            ICircleTestnetAgenticCommerce(escrow).fund(jobId, "");
        } else {
            ICzarJobEscrowClient(escrow).fund(jobId, usdc, budget, "");
        }
        IERC20(usdc).forceApprove(escrow, 0);
    }

    /// @notice Status, budget, already-settled amount and expiry, as syncJob reads them (RV-009).
    ///         Circle's instance has no partial claims, so `settledAmount` is 0 there.
    function readOutcome(IJobEscrowAdapter.JobEscrowKind kind, address escrow, uint256 jobId)
        internal
        view
        returns (IJobEscrowAdapter.EscrowStatus status, uint256 budget, uint256 settledAmount, uint64 expiredAt)
    {
        if (kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet) {
            uint8 s;
            uint256 exp;
            (,,,,, budget, exp, s,) = ICircleTestnetAgenticCommerce(escrow).jobs(jobId);
            status = IJobEscrowAdapter.EscrowStatus(s);
            expiredAt = SafeCast.toUint64(exp);
        } else {
            ICzarJobEscrowClient.Job memory j = ICzarJobEscrowClient(escrow).getJob(jobId);
            (status, budget, settledAmount, expiredAt) =
            (IJobEscrowAdapter.EscrowStatus(j.status), j.budget, j.settledAmount, j.expiredAt);
        }
    }

    /// @notice Client reject while Open (H2); the vault is msg.sender, which is job.client.
    function cancel(IJobEscrowAdapter.JobEscrowKind kind, address escrow, uint256 jobId, bytes32 reason) internal {
        if (kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet) {
            ICircleTestnetAgenticCommerce(escrow).reject(jobId, reason, "");
        } else {
            ICzarJobEscrowClient(escrow).reject(jobId, reason, "");
        }
    }

    /// @notice claimRefund on the escrow (never hookable, A4-03).
    function claimRefund(IJobEscrowAdapter.JobEscrowKind kind, address escrow, uint256 jobId) internal {
        if (kind == IJobEscrowAdapter.JobEscrowKind.CircleTestnet) {
            ICircleTestnetAgenticCommerce(escrow).claimRefund(jobId);
        } else {
            ICzarJobEscrowClient(escrow).claimRefund(jobId);
        }
    }

    /// @dev DESCRIPTION_PREFIX + 64 lowercase hex characters of `h`, no "0x": 69 ASCII characters (§15.6).
    ///      OpenZeppelin Strings.toHexString adds "0x", so this fixed-length encoder is used instead.
    function _description(bytes32 h) private pure returns (string memory) {
        bytes memory prefix = bytes(DESCRIPTION_PREFIX);
        bytes memory out = new bytes(prefix.length + HASH_HEX_LENGTH);
        for (uint256 i = 0; i < prefix.length; i++) {
            out[i] = prefix[i];
        }
        uint256 value = uint256(h);
        for (uint256 i = HASH_HEX_LENGTH; i > 0; i--) {
            out[prefix.length + i - 1] = HEX_DIGITS[value & 0xf];
            value >>= 4;
        }
        return string(out);
    }
}
