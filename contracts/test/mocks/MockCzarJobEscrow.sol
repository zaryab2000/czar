// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice base-contracts IERC8183Hook.sol @ 142e669.
interface IERC8183Hook is IERC165 {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

/// @notice base-contracts IDisburser.sol @ 142e669.
interface IDisburser is IERC165 {
    function onDisbursement(uint256 jobId, bytes4 selector, address token, uint256 amount, bytes calldata data) external;
}

/// @title MockCzarJobEscrow
/// @notice Non-upgradeable test copy of the job logic of erc-8183/base-contracts `contracts/ERC8183.sol` @ 142e669,
///         the base of CzarJobEscrow (D32, ICzarJobEscrow). Functions, checks, events and errors follow the base
///         contract line by line, including partial claims (`settledAmount`, lines 921–1076) and `claimRefund`
///         from `Open` (lines 863–885, RV-009). The constructor replaces `initialize(treasury, admin)` (line 313);
///         the EIP-712 authorization extension (ERC8183WithAuthorization) is not part of the vault's ABI. The
///         reentrancy guard uses storage instead of transient storage (same behaviour, no solc 0.8.30 warning).
contract MockCzarJobEscrow is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    /// @notice Lines 56–70; field order is the base struct's (ICzarJobEscrowClient.Job).
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

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    uint256 public constant EVALUATION_GRACE_PERIOD = 1 hours; // line 78
    uint256 internal constant BPS_DENOMINATOR = 10000;
    uint256 internal constant MIN_EXPIRY_LEAD = 5 minutes;

    uint256 public platformFeeBP;
    address public platformTreasury;
    uint256 public evaluatorFeeBP;
    mapping(uint256 => Job) public jobs;
    uint256 public jobCounter;
    mapping(address => bool) public whitelistedHooks;
    mapping(address => bool) public allowedPaymentTokens;
    mapping(uint256 => bytes32) public pendingClaimHash;
    mapping(uint256 => mapping(bytes32 => bool)) public submittedClaimHash;

    event JobCreated(
        uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint48 expiredAt, address hook
    );
    event ProviderSet(uint256 indexed jobId, address indexed provider, uint256 agentId);
    event PayoutReceiverSet(uint256 indexed jobId, address indexed payoutReceiver);
    event Disbursed(uint256 indexed jobId, address indexed receiver, bytes4 selector, uint256 amount);
    event BudgetSet(uint256 indexed jobId, address indexed token, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed recipient, uint256 amount);
    event PlatformFeePaid(uint256 indexed jobId, address indexed platformTreasury, uint256 amount);
    event EvaluatorFeePaid(uint256 indexed jobId, address indexed evaluator, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event Settled(uint256 indexed jobId, uint256 cumulativeAmount, uint256 delta);
    event ClaimSubmitted(
        uint256 indexed jobId, address indexed provider, uint256 cumulativeAmount, uint256 delta, bytes32 deliverable, bytes optParams
    );
    event ClaimSettled(uint256 indexed jobId, address indexed settler, uint256 cumulativeAmount, uint256 delta, bytes32 deliverable);
    event ClaimApproved(uint256 indexed jobId, address indexed approver, uint256 cumulativeAmount, uint256 delta, bytes32 deliverable);
    event ClaimRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event HookWhitelistUpdated(address indexed hook, bool status);
    event PaymentTokenAllowlistUpdated(address indexed token, bool status);
    event PlatformFeeUpdated(uint256 feeBP, address indexed treasury);
    event EvaluatorFeeUpdated(uint256 feeBP);

    error InvalidJob();
    error InvalidHook();
    error InvalidReceiver();
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
    error NoNewSettlement();
    error ExceedsBudget();
    error ClaimAlreadySubmitted();
    error EmptyDeliverable();
    error PendingClaimExists();
    error NoPendingClaim();

    constructor(address treasury_, address admin_) {
        if (treasury_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        platformTreasury = treasury_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
        whitelistedHooks[address(0)] = true;
    }

    // ─────────────── Admin (lines 330–410) ───────────────

    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    function setPlatformFee(uint256 feeBP_, address treasury_) external onlyRole(ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBP_ + evaluatorFeeBP > BPS_DENOMINATOR) revert FeesTooHigh();
        platformFeeBP = feeBP_;
        platformTreasury = treasury_;
        emit PlatformFeeUpdated(feeBP_, treasury_);
    }

    function setEvaluatorFee(uint256 feeBP_) external onlyRole(ADMIN_ROLE) {
        if (feeBP_ + platformFeeBP > BPS_DENOMINATOR) revert FeesTooHigh();
        evaluatorFeeBP = feeBP_;
        emit EvaluatorFeeUpdated(feeBP_);
    }

    function setHookWhitelist(address hook, bool status) external onlyRole(ADMIN_ROLE) {
        if (hook == address(0)) revert ZeroAddress();
        whitelistedHooks[hook] = status;
        emit HookWhitelistUpdated(hook, status);
    }

    function setPaymentTokenAllowed(address token, bool status) external onlyRole(ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        allowedPaymentTokens[token] = status;
        emit PaymentTokenAllowlistUpdated(token, status);
    }

    // ─────────────── Job lifecycle (lines 512–885) ───────────────

    function createJob(
        address provider,
        address evaluator,
        uint48 expiredAt,
        string calldata description,
        address hook,
        uint256 providerAgentId
    ) external whenNotPaused nonReentrant returns (uint256) {
        if (expiredAt <= block.timestamp + MIN_EXPIRY_LEAD) revert ExpiryTooShort();
        if (msg.sender == provider) revert ClientCannotBeProvider();
        if (evaluator == address(0)) revert ZeroAddress();
        if (evaluator == provider) revert ProviderCannotBeEvaluator();
        if (!whitelistedHooks[hook]) revert HookNotWhitelisted();
        if (hook != address(0) && !ERC165Checker.supportsInterface(hook, type(IERC8183Hook).interfaceId)) {
            revert InvalidHook();
        }
        uint256 jobId = ++jobCounter;
        Job storage job = jobs[jobId];
        job.client = msg.sender;
        job.provider = provider;
        job.expiredAt = expiredAt;
        job.evaluator = evaluator;
        job.hook = hook;
        job.providerAgentId = provider != address(0) ? providerAgentId : 0;
        job.description = description;
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, hook);
        return jobId;
    }

    function setPayoutReceiver(uint256 jobId, address payoutReceiver) external whenNotPaused nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        _validatePayoutReceiver(payoutReceiver, job.paymentToken);
        job.payoutReceiver = payoutReceiver;
        emit PayoutReceiverSet(jobId, payoutReceiver);
    }

    function setProvider(uint256 jobId, address provider_, uint256 agentId) external whenNotPaused nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider != address(0)) revert WrongStatus();
        if (provider_ == address(0)) revert ZeroAddress();
        if (provider_ == job.client) revert ClientCannotBeProvider();
        if (provider_ == job.evaluator) revert ProviderCannotBeEvaluator();
        job.provider = provider_;
        job.providerAgentId = agentId;
        emit ProviderSet(jobId, provider_, agentId);
    }

    function setBudget(uint256 jobId, address token, uint256 amount, bytes calldata optParams)
        external
        whenNotPaused
        nonReentrant
    {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        if (token == address(0)) revert ZeroAddress();
        if (!allowedPaymentTokens[token]) revert PaymentTokenNotAllowed();
        _validatePayoutReceiver(job.payoutReceiver, token);
        bytes memory data = abi.encode(msg.sender, token, amount, optParams);
        _beforeHook(job.hook, jobId, this.setBudget.selector, data);
        job.paymentToken = token;
        job.budget = amount;
        emit BudgetSet(jobId, token, amount);
        _afterHook(job.hook, jobId, this.setBudget.selector, data);
    }

    /// @notice Lines 661–684: reverts PaymentTokenMismatch / BudgetMismatch (front-running protection, A4-05).
    function fund(uint256 jobId, address expectedToken, uint256 expectedBudget, bytes calldata optParams)
        external
        whenNotPaused
        nonReentrant
    {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider == address(0)) revert ProviderNotSet();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();
        if (job.paymentToken != expectedToken) revert PaymentTokenMismatch();
        if (job.budget != expectedBudget) revert BudgetMismatch();
        bytes memory data = abi.encode(msg.sender, optParams);
        _beforeHook(job.hook, jobId, this.fund.selector, data);
        job.status = JobStatus.Funded;
        if (job.budget > 0) {
            IERC20 token = IERC20(job.paymentToken);
            uint256 balanceBefore = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), job.budget);
            if (token.balanceOf(address(this)) - balanceBefore != job.budget) revert UnexpectedFundedAmount();
        }
        emit JobFunded(jobId, msg.sender, job.budget);
        _afterHook(job.hook, jobId, this.fund.selector, data);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external whenNotPaused nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Funded && (job.status != JobStatus.Open || job.budget > 0)) revert WrongStatus();
        if (job.expiredAt != 0 && block.timestamp >= job.expiredAt) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        bytes memory data = abi.encode(msg.sender, deliverable, optParams);
        if (pendingClaimHash[jobId] != bytes32(0)) {
            delete pendingClaimHash[jobId];
            emit ClaimRejected(jobId, msg.sender, bytes32("superseded-by-submit"));
        }
        _beforeHook(job.hook, jobId, this.submit.selector, data);
        job.status = JobStatus.Submitted;
        job.submittedAt = uint48(block.timestamp);
        emit JobSubmitted(jobId, msg.sender, deliverable);
        _afterHook(job.hook, jobId, this.submit.selector, data);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external whenNotPaused nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Submitted) revert WrongStatus();
        if (msg.sender != job.evaluator) revert Unauthorized();
        bytes memory data = abi.encode(msg.sender, reason, optParams);
        _beforeHook(job.hook, jobId, this.complete.selector, data);
        job.status = JobStatus.Completed;
        _distributeSettlement(jobId, job, job.budget - job.settledAmount, this.complete.selector, optParams);
        emit JobCompleted(jobId, msg.sender, reason);
        _afterHook(job.hook, jobId, this.complete.selector, data);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external whenNotPaused nonReentrant {
        Job storage job = _job(jobId);
        if (job.status == JobStatus.Open) {
            if (msg.sender != job.client && msg.sender != job.provider) revert Unauthorized();
        } else if (job.status == JobStatus.Funded || job.status == JobStatus.Submitted) {
            if (msg.sender != job.evaluator) revert Unauthorized();
        } else {
            revert WrongStatus();
        }
        bytes memory data = abi.encode(msg.sender, reason, optParams);
        if (pendingClaimHash[jobId] != bytes32(0)) {
            delete pendingClaimHash[jobId];
            emit ClaimRejected(jobId, msg.sender, reason);
        }
        _beforeHook(job.hook, jobId, this.reject.selector, data);
        JobStatus prev = job.status;
        job.status = JobStatus.Rejected;
        uint256 refundAmount = job.budget - job.settledAmount;
        if ((prev == JobStatus.Funded || prev == JobStatus.Submitted) && refundAmount > 0) {
            IERC20(job.paymentToken).safeTransfer(job.client, refundAmount);
            emit Refunded(jobId, job.client, refundAmount);
        }
        emit JobRejected(jobId, msg.sender, reason);
        _afterHook(job.hook, jobId, this.reject.selector, data);
    }

    /// @notice Lines 863–885: anyone; `Open`/`Funded` after `expiredAt`, `Submitted` after `expiredAt + 1 h`;
    ///         never hookable (A4-03). Refunds only what was not already paid out through claims.
    function claimRefund(uint256 jobId) external whenNotPaused nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Open && job.status != JobStatus.Funded && job.status != JobStatus.Submitted) {
            revert WrongStatus();
        }
        bool hasPendingClaim = pendingClaimHash[jobId] != bytes32(0);
        if (job.status == JobStatus.Submitted) {
            if (block.timestamp < job.expiredAt + EVALUATION_GRACE_PERIOD) revert GracePeriodActive();
        } else if (hasPendingClaim) {
            revert PendingClaimExists();
        } else if (block.timestamp < job.expiredAt) {
            revert WrongStatus();
        }
        JobStatus prev = job.status;
        job.status = JobStatus.Expired;
        uint256 refundAmount = job.budget - job.settledAmount;
        if (refundAmount > 0 && (prev == JobStatus.Funded || prev == JobStatus.Submitted)) {
            IERC20(job.paymentToken).safeTransfer(job.client, refundAmount);
            emit Refunded(jobId, job.client, refundAmount);
        }
        emit JobExpired(jobId);
    }

    // ─────────────── Partial claims (lines 914–1076) ───────────────

    function submitClaim(uint256 jobId, uint256 cumulativeAmount, bytes32 deliverable, bytes calldata optParams)
        external
        whenNotPaused
        nonReentrant
    {
        Job storage job = _job(jobId);
        if (msg.sender != job.provider) revert Unauthorized();
        if (job.status != JobStatus.Funded) revert WrongStatus();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();
        if (deliverable == bytes32(0)) revert EmptyDeliverable();
        if (pendingClaimHash[jobId] != bytes32(0)) revert PendingClaimExists();
        if (cumulativeAmount <= job.settledAmount) revert NoNewSettlement();
        if (cumulativeAmount > job.budget) revert ExceedsBudget();
        uint256 delta = cumulativeAmount - job.settledAmount;
        bytes memory data = abi.encode(msg.sender, cumulativeAmount, deliverable, optParams);
        _beforeHook(job.hook, jobId, this.submitClaim.selector, data);
        bytes32 claimHash = _claimHash(cumulativeAmount, deliverable, keccak256(optParams));
        if (submittedClaimHash[jobId][claimHash]) revert ClaimAlreadySubmitted();
        submittedClaimHash[jobId][claimHash] = true;
        pendingClaimHash[jobId] = claimHash;
        emit ClaimSubmitted(jobId, msg.sender, cumulativeAmount, delta, deliverable, optParams);
        _afterHook(job.hook, jobId, this.submitClaim.selector, data);
    }

    function settleClaim(uint256 jobId, uint256 cumulativeAmount, bytes32 deliverable, bytes calldata optParams)
        external
        whenNotPaused
        nonReentrant
    {
        Job storage job = _job(jobId);
        if (msg.sender != job.client) revert Unauthorized();
        if (job.status != JobStatus.Funded) revert WrongStatus();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();
        if (cumulativeAmount <= job.settledAmount) revert NoNewSettlement();
        if (cumulativeAmount > job.budget) revert ExceedsBudget();
        uint256 delta = cumulativeAmount - job.settledAmount;
        bytes memory data = abi.encode(msg.sender, cumulativeAmount, deliverable, optParams);
        _beforeHook(job.hook, jobId, this.settleClaim.selector, data);
        job.settledAmount = cumulativeAmount;
        _distributeSettlement(jobId, job, delta, this.settleClaim.selector, optParams);
        emit Settled(jobId, cumulativeAmount, delta);
        emit ClaimSettled(jobId, msg.sender, cumulativeAmount, delta, deliverable);
        _afterHook(job.hook, jobId, this.settleClaim.selector, data);
    }

    function approveClaim(uint256 jobId, uint256 cumulativeAmount, bytes32 deliverable, bytes calldata optParams)
        external
        whenNotPaused
        nonReentrant
    {
        Job storage job = _job(jobId);
        if (msg.sender != job.client && msg.sender != job.evaluator) revert Unauthorized();
        if (job.status != JobStatus.Funded) revert WrongStatus();
        bytes32 stored = pendingClaimHash[jobId];
        if (stored == bytes32(0)) revert NoPendingClaim();
        if (stored != _claimHash(cumulativeAmount, deliverable, keccak256(optParams))) revert NoPendingClaim();
        if (cumulativeAmount <= job.settledAmount) revert NoNewSettlement();
        if (cumulativeAmount > job.budget) revert ExceedsBudget();
        uint256 delta = cumulativeAmount - job.settledAmount;
        bytes memory data = abi.encode(msg.sender, cumulativeAmount, deliverable, optParams);
        _beforeHook(job.hook, jobId, this.approveClaim.selector, data);
        delete pendingClaimHash[jobId];
        job.settledAmount = cumulativeAmount;
        _distributeSettlement(jobId, job, delta, this.approveClaim.selector, optParams);
        emit Settled(jobId, cumulativeAmount, delta);
        emit ClaimApproved(jobId, msg.sender, cumulativeAmount, delta, deliverable);
        _afterHook(job.hook, jobId, this.approveClaim.selector, data);
    }

    function rejectClaim(
        uint256 jobId,
        uint256 cumulativeAmount,
        bytes32 deliverable,
        bytes32 reason,
        bytes calldata optParams
    ) external whenNotPaused nonReentrant {
        Job storage job = _job(jobId);
        if (msg.sender != job.client && msg.sender != job.evaluator && msg.sender != job.provider) revert Unauthorized();
        if (job.status != JobStatus.Funded) revert WrongStatus();
        bytes32 stored = pendingClaimHash[jobId];
        if (stored == bytes32(0)) revert NoPendingClaim();
        if (stored != _claimHash(cumulativeAmount, deliverable, keccak256(optParams))) revert NoPendingClaim();
        bytes memory data = abi.encode(msg.sender, cumulativeAmount, deliverable, reason, optParams);
        _beforeHook(job.hook, jobId, this.rejectClaim.selector, data);
        delete pendingClaimHash[jobId];
        emit ClaimRejected(jobId, msg.sender, reason);
        _afterHook(job.hook, jobId, this.rejectClaim.selector, data);
    }

    /// @notice Line 1081.
    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    // ─────────────── Internals ───────────────

    function _job(uint256 jobId) internal view returns (Job storage) {
        if (jobId == 0 || jobId > jobCounter) revert InvalidJob();
        return jobs[jobId];
    }

    function _claimHash(uint256 cumulativeAmount, bytes32 deliverable, bytes32 optParamsHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(cumulativeAmount, deliverable, optParamsHash));
    }

    function _distributeSettlement(uint256 jobId, Job storage job, uint256 amount, bytes4 selector, bytes calldata optParams)
        internal
    {
        uint256 platformFee = (amount * platformFeeBP) / BPS_DENOMINATOR;
        uint256 evalFee = (amount * evaluatorFeeBP) / BPS_DENOMINATOR;
        uint256 net = amount - platformFee - evalFee;
        IERC20 token = IERC20(job.paymentToken);
        if (platformFee > 0) {
            token.safeTransfer(platformTreasury, platformFee);
            emit PlatformFeePaid(jobId, platformTreasury, platformFee);
        }
        if (evalFee > 0) {
            token.safeTransfer(job.evaluator, evalFee);
            emit EvaluatorFeePaid(jobId, job.evaluator, evalFee);
        }
        address recipient = job.payoutReceiver == address(0) ? job.provider : job.payoutReceiver;
        if (net > 0) {
            token.safeTransfer(recipient, net);
            emit PaymentReleased(jobId, recipient, net);
            if (recipient.code.length > 0 && ERC165Checker.supportsInterface(recipient, type(IDisburser).interfaceId)) {
                IDisburser(recipient).onDisbursement(jobId, selector, job.paymentToken, net, optParams);
                emit Disbursed(jobId, recipient, selector, net);
            }
        }
    }

    function _validatePayoutReceiver(address payoutReceiver, address paymentToken) internal view {
        if (payoutReceiver == address(this)) revert InvalidReceiver();
        if (payoutReceiver != address(0) && payoutReceiver == paymentToken) revert InvalidReceiver();
    }

    function _beforeHook(address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        if (hook != address(0)) IERC8183Hook(hook).beforeAction(jobId, selector, data);
    }

    function _afterHook(address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        if (hook != address(0)) IERC8183Hook(hook).afterAction(jobId, selector, data);
    }
}
