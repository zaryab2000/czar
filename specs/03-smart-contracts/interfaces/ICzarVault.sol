// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ICzarVault
/// @notice Interface of the per-user Czar vault: envelopes, reservations, pocket wallets,
///         ERC-8183 jobs, earned autonomy, freeze, and the ERC-1271 dispatcher.
/// @dev Specification: specs/03-smart-contracts/czar-vault.md. Shared types: specs/02 §5–§7.
///      Immutable per deployment (D33). Owner acts as msg.sender through a UserOp (D30).
interface ICzarVault {
    // ─────────────────────────────── Types ───────────────────────────────

    /// @notice Envelope lifecycle (czar-vault.md §8.1).
    enum EnvelopeState { None, Open, Closed }
    /// @notice Reservation lifecycle (§8.2).
    enum ReservationState { None, Active, Finalizing, Final }
    /// @notice Pocket lifecycle (§8.3).
    enum PocketState { None, Registered, Funded, Draining, Closed }
    /// @notice Pullback lifecycle (§8.3).
    enum PullbackState { None, Pending, Confirmed, Cancelled }
    /// @notice Job lifecycle as mirrored by the vault (§8.4).
    enum JobState { None, Opened, Funded, Submitted, Completed, Refunded }
    /// @notice Reservation signature mode (02 §6.3.1 vs §6.3.4).
    enum ReservationMode { Envelope, Digest }
    /// @notice Owner actions executable through a passkey assertion (02 §6.2).
    enum OwnerActionKind {
        None,
        OpenEnvelope,
        SetLimits,
        Freeze,
        Unfreeze,
        Withdraw,
        RotateSigners,
        SetPasskey,
        CloseEnvelope
    }

    /// @notice Parameters of openEnvelope (02 §4.5 / §4.8).
    struct OpenEnvelopeParams {
        uint256 cap;
        uint256 maxStepAmount;
        uint16 pocketCapBps;
        uint64 expiresAt;
        bytes32 categoryId;
        bytes32 objectiveHash;
        bytes32 planHash;
        bytes32 payeeRoot;
    }

    /// @notice WebAuthn assertion for the D30 fallback (OpenZeppelin v5.7.0 WebAuthn.WebAuthnAuth shape).
    struct WebAuthnAuth {
        uint256 challengeIndex;
        uint256 typeIndex;
        bytes32 r;
        bytes32 s;
        bytes authenticatorData;
        string clientDataJSON;
    }

    // ─────────────────────────────── Events ──────────────────────────────

    event EnvelopeOpened(
        uint64 indexed envelopeId,
        bytes32 indexed categoryId,
        bytes32 indexed objectiveHash,
        uint256 cap,
        bytes32 planHash,
        bytes32 payeeRoot,
        uint256 maxStepAmount,
        uint16 pocketCapBps,
        uint64 expiresAt,
        bool approverIsOwner
    );
    event EnvelopeClosed(uint64 indexed envelopeId, uint256 spent, uint256 released);
    event EnvelopeForceClosed(uint64 indexed envelopeId, uint256 spent, uint256 released, uint256 writtenOffPockets);
    event Reserved(
        uint64 indexed reservationId,
        uint64 indexed envelopeId,
        address indexed payee,
        uint32 stepIndex,
        uint256 unitAmount,
        uint32 count,
        uint64 validBefore,
        uint8 mode
    );
    event Settled(uint64 indexed reservationId, uint32 index, uint256 amount);
    event Released(uint64 indexed reservationId, uint32 index, uint256 amount);
    event ReservationFinal(uint64 indexed reservationId, uint32 settledCount, uint32 releasedCount);
    event PocketRegistered(uint64 indexed envelopeId, address indexed pocket);
    event PocketGasGranted(address indexed pocket, uint256 units);
    event PocketFunded(address indexed pocket, uint64 indexed envelopeId, uint256 amount, uint256 fundedTotal);
    event PullbackRequested(
        uint64 indexed pullbackId,
        address indexed pocket,
        uint256 value,
        uint256 maxFee,
        uint256 maxBlockHeight,
        bytes32 indexed transferSpecHash,
        bytes32 salt
    );
    event PullbackConfirmed(uint64 indexed pullbackId, address indexed pocket, uint256 value);
    event PullbackCancelled(uint64 indexed pullbackId);
    event PocketClosed(address indexed pocket, uint256 writtenOff);
    event ManualReturnRecorded(address indexed pocket, uint256 amount);
    event JobOpened(
        bytes32 indexed jobKey,
        uint64 indexed envelopeId,
        address indexed provider,
        uint32 stepIndex,
        address jobEscrow,
        uint256 jobId,
        address evaluator,
        uint256 reservedCap,
        bytes32 descriptionHash
    );
    event JobFunded(bytes32 indexed jobKey, uint256 budget);
    event JobSynced(bytes32 indexed jobKey, uint8 state, bool creditedToEnvelope);
    event JobRefunded(bytes32 indexed jobKey, uint256 budget, bool creditedToEnvelope);
    event LimitsSet(bytes32 indexed categoryId, uint256 userMax, uint256 autoLimit);
    event AutoLimitRaised(bytes32 indexed categoryId, uint256 oldLimit, uint256 newLimit, uint64 periodId);
    event AutoLimitLowered(bytes32 indexed categoryId, uint256 oldLimit, uint256 newLimit, address by);
    event Frozen(address by);
    event Unfrozen();
    event SignersRotated(address agent, address autonomy, address evaluator);
    event PasskeySet(bytes32 keyHash);
    event OwnerActionExecuted(uint8 indexed action, uint256 nonce);
    event Withdrawn(address indexed to, uint256 amount);
    event BalanceSynced(uint256 balance, uint256 committedTotal);
    event NativeReceived(address indexed sender, uint256 weiValue);

    // ─────────────────────────────── Errors ──────────────────────────────

    error NotOwner();
    error NotAgent();
    error NotAuthorized();
    error Paused();
    error FrozenVault();
    error ZeroAddress();
    error BadParams();
    error InsufficientFree(uint256 free, uint256 wanted);
    error AllowanceExceeded(bytes32 categoryId, uint256 remaining, uint256 wanted);
    error EnvelopeNotOpen();
    error EnvelopeExpired();
    error EnvelopeBusy(uint32 reservations, uint32 pockets, uint32 jobs);
    error PayeeNotInPlan();
    error StepCapExceeded();
    error CapExceeded();
    error BadTtl();
    error BadCount();
    error ReservationNotActive();
    error NotUsed(uint32 index);
    error AlreadyDone(uint32 index);
    error NotExpired();
    error PocketExists();
    error NotEoa();
    error DelegateNotSet();
    error PocketCapExceeded(uint256 cap, uint256 funded, uint256 wanted);
    error GasGrantExceeded();
    error NativeSendFailed();
    error PullbackTooLarge();
    error FeeTooHigh();
    error NotMinted();
    error AlreadyMinted();
    error TooEarly();
    error PullbackPending();
    error BudgetExceedsReserved();
    error UnexpectedFees(uint256 platformBp, uint256 evaluatorBp);
    error WrongToken();
    error JobNotOpen();
    error JobWrongState();
    error NoChange();
    error AutoLimitAboveUserMax();
    error RaiseTooLarge();
    error RaiseAlreadyThisPeriod();
    error BadSigner();
    error Expired();
    error PasskeyNotSet();
    error InvalidPasskeyAssertion();
    error UnknownAction();

    // ────────────────────────── Balance and owner ────────────────────────

    /// @notice USDC (6-decimal view) not committed to any open envelope.
    function freeBalance() external view returns (uint256);
    /// @notice Emits BalanceSynced; accounting is live, so this changes no state.
    function sync() external;
    /// @notice Owner withdraws free balance. Reverts if `amount` exceeds freeBalance().
    function withdraw(address to, uint256 amount) external;
    /// @notice Owner sets per-category limits; `autoLimit` must not exceed `userMax`.
    function setCategoryLimits(bytes32 categoryId, uint256 userMax, uint256 autoLimit) external;
    /// @notice Owner or agent stops all spending digests and spending functions.
    function freeze() external;
    /// @notice Owner only.
    function unfreeze() external;
    /// @notice Owner rotates the agent, autonomy and evaluator addresses (none may be zero).
    function rotateSigners(address agent, address autonomy, address evaluator_) external;
    /// @notice Owner registers the P-256 passkey public key and the expected rpIdHash (D30 fallback).
    function setPasskey(bytes32 qx, bytes32 qy, bytes32 rpIdHash) external;
    /// @notice Anyone relays an owner action signed by the passkey (02 §6.2 OwnerAction, czar-vault.md §7).
    function executeOwnerAction(uint8 action, bytes calldata payload, uint256 deadline, WebAuthnAuth calldata auth)
        external;

    // ───────────────────────────── Envelopes ─────────────────────────────

    /// @notice Owner, or agent within the category's weekly allowance. Returns the new envelopeId.
    function openEnvelope(OpenEnvelopeParams calldata p) external returns (uint64 envelopeId);
    /// @notice Owner or agent any time; anyone after expiry. Requires no open reservations, pockets or jobs.
    function closeEnvelope(uint64 envelopeId) external;
    /// @notice Owner only, after expiry + 1 day; writes off open pockets.
    function forceCloseEnvelope(uint64 envelopeId) external;

    // ──────────────────────────── Reservations ───────────────────────────

    /// @notice Reserve `count` authorizations of `unitAmount` to `payee` for a step (envelope signature mode).
    function reserve(
        uint64 envelopeId,
        uint32 stepIndex,
        address payee,
        uint256 stepCap,
        bytes32[] calldata proof,
        uint256 unitAmount,
        uint32 count,
        uint64 validBefore
    ) external returns (uint64 reservationId);
    /// @notice Same as reserve, but stores each index's USDC digest for the 65-byte fallback (count ≤ 8).
    function reserveWithDigests(
        uint64 envelopeId,
        uint32 stepIndex,
        address payee,
        uint256 stepCap,
        bytes32[] calldata proof,
        uint256 unitAmount,
        uint32 count,
        uint64 validBefore
    ) external returns (uint64 reservationId);
    /// @notice keccak256(abi.encode(NONCE_TAG, address(this), reservationId, index)) (02 §7.2).
    function derivedNonce(uint64 reservationId, uint32 index) external view returns (bytes32);
    /// @notice Anyone: mark indices whose nonce USDC consumed as spent.
    function settle(uint64 reservationId, uint32[] calldata indices) external;
    /// @notice Anyone, after validBefore: settle used indices, release the rest, chunked.
    function finalize(uint64 reservationId, uint32 fromIndex, uint32 toIndex) external;

    // ─────────────────────────────── Pockets ─────────────────────────────

    /// @notice Agent registers an EOA pocket for an envelope (one pocket, one envelope, ever).
    function registerPocket(uint64 envelopeId, address pocket) external;
    /// @notice Agent sends native USDC gas to the pocket; counted as spent from the envelope.
    function grantPocketGas(address pocket, uint256 units) external;
    /// @notice Agent deposits into the pocket's Gateway balance via depositFor, after the delegate check.
    function fundPocket(address pocket, uint256 amount) external;
    /// @notice Agent fixes every field of a same-chain burn intent back to this vault. Returns pullbackId.
    function requestPullback(address pocket, uint256 value, uint256 maxFee, uint256 maxBlockHeight)
        external
        returns (uint64 pullbackId);
    /// @notice Anyone: credit a pullback once GatewayMinter.isTransferSpecHashUsed(transferSpecHash) is true.
    function confirmPullback(uint64 pullbackId) external;
    /// @notice Agent or owner, after PULLBACK_CANCEL_DELAY_BLOCKS, if never minted.
    function cancelPullback(uint64 pullbackId) external;
    /// @notice Agent or owner: treat the remaining outstanding balance as spent and close the pocket.
    function writeOffPocket(address pocket) external;
    /// @notice Owner only: record funds returned through the 7-day on-chain withdrawal path.
    function recordManualReturn(address pocket, uint256 amount) external;

    // ──────────────────────────────── Jobs ───────────────────────────────

    /// @notice Agent creates an ERC-8183 job with the vault as client and vault.evaluator as evaluator.
    function openJob(
        uint64 envelopeId,
        uint32 stepIndex,
        address provider,
        uint256 stepCap,
        bytes32[] calldata proof,
        uint64 expiredAt,
        bytes32 descriptionHash
    ) external returns (bytes32 jobKey);
    /// @notice Agent funds the job after reading budget and fees in the same transaction.
    function fundJob(bytes32 jobKey) external;
    /// @notice Anyone: mirror the escrow's job status into vault accounting.
    function syncJob(bytes32 jobKey) external;
    /// @notice Anyone, after expiry: call the escrow's claimRefund and un-spend the budget.
    function claimJobRefund(bytes32 jobKey) external;

    // ─────────────────────────── Earned autonomy ─────────────────────────

    /// @notice Anyone relays an AutonomyRaise signed by autonomySigner; owner may call with empty sig.
    function raiseAutoLimit(bytes32 categoryId, uint256 newLimit, uint64 periodId, uint256 deadline, bytes calldata sig)
        external;
    /// @notice Owner, agent or autonomy signer lowers the limit.
    function lowerAutoLimit(bytes32 categoryId, uint256 newLimit) external;

    // ──────────────────────────────── Views ──────────────────────────────

    function owner() external view returns (address);
    function agentSigner() external view returns (address);
    function autonomySigner() external view returns (address);
    function evaluator() external view returns (address);
    function frozen() external view returns (bool);
    function committedTotal() external view returns (uint256);
    function envelopeCount() external view returns (uint64);
    function reservationCount() external view returns (uint64);
    function pullbackCount() external view returns (uint64);
    function autonomyNonce() external view returns (uint256);
    function ownerActionNonce() external view returns (uint256);

    /// @notice ERC-1271. Dispatches on the kind tag in `signature` (02 §6.3) or the 65-byte fallback.
    ///         Never reverts; returns 0x1626ba7e or 0xffffffff.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4);
}
