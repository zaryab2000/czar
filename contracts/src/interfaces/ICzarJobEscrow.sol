// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ICzarJobEscrow
/// @notice The Czar-owned ERC-8183 instance (erc-8183/base-contracts ERC8183.sol @ 142e669), deployed and
///         configured by Czar before mainnet (D32). This file lists the functions Czar's vault, providers and
///         evaluator rely on, with the base contract's signatures unchanged. Czar adds no functions.
/// @dev Specification: docs/specs/03-smart-contracts/czar-job-escrow.md. Line numbers refer to ERC8183.sol.
interface ICzarJobEscrow {
    enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }

    /// @notice Job record as stored by the base contract (lines 56–70).
    struct Job {
        address client;
        JobStatus status;
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

    event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook);
    event BudgetSet(uint256 indexed jobId, address indexed token, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed recipient, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event HookWhitelistUpdated(address indexed hook, bool status);
    event PaymentTokenAllowlistUpdated(address indexed token, bool status);
    event PlatformFeeUpdated(uint256 feeBP, address indexed treasury);
    event EvaluatorFeeUpdated(uint256 feeBP);
    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);

    error InvalidJob();
    error WrongStatus();
    error Unauthorized();
    error ZeroAddress();
    error ExpiryTooShort();
    error ProviderNotSet();
    error FeesTooHigh();
    error HookNotWhitelisted();
    error BudgetMismatch();
    error PaymentTokenMismatch();
    error ProviderCannotBeEvaluator();
    error ClientCannotBeProvider();
    error GracePeriodActive();
    error PaymentTokenNotAllowed();
    error UnexpectedFundedAmount();

    /// @notice Client creates a job (line 512). `expiredAt` must exceed now + 5 minutes.
    function createJob(
        address provider,
        address evaluator,
        uint48 expiredAt,
        string calldata description,
        address hook,
        uint256 providerAgentId
    ) external returns (uint256);
    /// @notice Provider sets the budget while Open (line 621).
    function setBudget(uint256 jobId, address token, uint256 amount, bytes calldata optParams) external;
    /// @notice Client funds; reverts BudgetMismatch / PaymentTokenMismatch (lines 661–684).
    function fund(uint256 jobId, address expectedToken, uint256 expectedBudget, bytes calldata optParams) external;
    /// @notice Provider submits a deliverable hash (line 708).
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    /// @notice Evaluator accepts; `reason` is Czar's reportHash (line 754).
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    /// @notice Evaluator (or client while Open) rejects (line 806).
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    /// @notice Anyone after expiry (+1 h grace when Submitted); never hookable (line 863).
    function claimRefund(uint256 jobId) external;
    /// @notice Full job record (line 1081).
    function getJob(uint256 jobId) external view returns (Job memory);
    function jobCounter() external view returns (uint256);
    function platformFeeBP() external view returns (uint256);
    function evaluatorFeeBP() external view returns (uint256);
    function platformTreasury() external view returns (address);
    function whitelistedHooks(address hook) external view returns (bool);
    function EVALUATION_GRACE_PERIOD() external view returns (uint256);
}
