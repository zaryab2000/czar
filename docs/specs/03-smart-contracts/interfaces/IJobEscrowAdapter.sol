// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IJobEscrowAdapter
/// @notice The vault-internal adapter surface over two ERC-8183 instances:
///         Circle's Arc testnet instance (EIP-reference ABI) and CzarJobEscrow (erc-8183/base-contracts).
/// @dev Specification: docs/specs/03-smart-contracts/job-escrow-adapter.md. Implemented as an internal library
///      selected by the vault's immutable `jobEscrowKind`; this interface documents the surface and the
///      two external ABIs it targets. No implementation code here.
interface IJobEscrowAdapter {
    /// @notice Which external ABI the vault targets.
    enum JobEscrowKind { CircleTestnet, CzarBase }

    /// @notice Status as the vault normalizes it from either instance's enum.
    enum EscrowStatus { Open, Funded, Submitted, Completed, Rejected, Expired }

    /// @notice Budget, status and payment token of a job, read in the same transaction as any fund call.
    function readBudget(JobEscrowKind kind, address escrow, uint256 jobId)
        external
        view
        returns (uint256 budget, EscrowStatus status, address token);

    /// @notice platformFeeBP and evaluatorFeeBP as reported by the instance.
    function readFees(JobEscrowKind kind, address escrow) external view returns (uint256 platformBp, uint256 evaluatorBp);

    /// @notice Status, budget and the amount already paid out through claims, as syncJob reads them (RV-009).
    ///         `settledAmount` is always 0 on Circle's instance (no partial claims).
    function readOutcome(JobEscrowKind kind, address escrow, uint256 jobId)
        external
        view
        returns (EscrowStatus status, uint256 budget, uint256 settledAmount, uint64 expiredAt);

    /// @notice Client reject while the job is Open (H2). Called with the vault as msg.sender, which is job.client.
    ///         Circle's instance: reject(jobId, reason, "") requires msg.sender == job.client while Open (R5).
    function cancel(JobEscrowKind kind, address escrow, uint256 jobId, bytes32 reason) external;
}

/// @title ICircleTestnetAgenticCommerce
/// @notice Exact subset of the verified ABI of Arc testnet implementation 0xA316fd02827242D537F84730F8a37D0BA5fd351a
///         (proxy 0x0747EEf0706327138c69792bF28Cd525089e4583) used by the vault and the evaluator. A4-06, p1-E2.
interface ICircleTestnetAgenticCommerce {
    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook)
        external
        returns (uint256);
    function fund(uint256 jobId, bytes calldata optParams) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function claimRefund(uint256 jobId) external;
    function jobs(uint256 jobId)
        external
        view
        returns (
            uint256 id,
            address client,
            address provider,
            address evaluator,
            string memory description,
            uint256 budget,
            uint256 expiredAt,
            uint8 status,
            address hook
        );
    function jobHasBudget(uint256 jobId) external view returns (bool hasBudget);
    function paymentToken() external view returns (address);
    function platformFeeBP() external view returns (uint256);
    function evaluatorFeeBP() external view returns (uint256);
    function whitelistedHooks(address hook) external view returns (bool);
}

/// @title ICzarJobEscrowClient
/// @notice Exact subset of erc-8183/base-contracts ERC8183.sol @ 142e669 used by the vault (lines 512, 661, 863, 1081).
interface ICzarJobEscrowClient {
    /// @notice Job record as returned by getJob (ERC8183.sol lines 56–70, 1081). Field order follows the base struct.
    struct Job {
        address client;
        uint8 status;
        address provider;
        uint48 expiredAt;
        address evaluator;
        uint48 submittedAt;
        uint256 budget;
        address hook;
        address paymentToken;
        uint256 providerAgentId;
        string description;
        uint256 settledAmount;
        address payoutReceiver;
    }

    function createJob(
        address provider,
        address evaluator,
        uint48 expiredAt,
        string calldata description,
        address hook,
        uint256 providerAgentId
    ) external returns (uint256);
    function fund(uint256 jobId, address expectedToken, uint256 expectedBudget, bytes calldata optParams) external;
    function claimRefund(uint256 jobId) external;
    function platformFeeBP() external view returns (uint256);
    function evaluatorFeeBP() external view returns (uint256);
    /// @notice Read by the adapter for the Czar kind (budget, status, paymentToken, settledAmount; RV-009).
    function getJob(uint256 jobId) external view returns (Job memory);
}
