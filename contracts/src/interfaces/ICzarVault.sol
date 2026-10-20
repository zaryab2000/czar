// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ICzarVault
/// @notice Interface of the per-user Czar vault: envelopes, reservations, pocket wallets,
///         ERC-8183 jobs, earned autonomy, freeze, and the ERC-1271 dispatcher.
/// @dev Specification: docs/specs/03-smart-contracts/czar-vault.md. Shared types: docs/specs/02 §5–§7.
///      Immutable per deployment (D33). Owner acts as msg.sender through a UserOp (D30).
///      This file is the canonical ABI: where a czar-vault.md table differs in a name, argument order or
///      event field, this file wins (RV-060). Amended 2026-10-19 for the G0-01 review fixes.
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
    /// @notice Job lifecycle as mirrored by the vault (§8.4). `Released`: an unfunded job released by syncJob (RV-009).
    enum JobState { None, Opened, Funded, Submitted, Completed, Refunded, Released }
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
        CloseEnvelope,
        ForceCloseEnvelope, // 9  (RV-033)
        RecordManualReturn, // 10
        RaiseAutoLimit, // 11 owner path, empty sig
        LowerAutoLimit, // 12
        RequestPullback, // 13
        CancelPullback, // 14
        WriteOffPocket, // 15
        SetMaxPullbackFee // 16 (D81)
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

    /// @notice The 13 fields of the Selection Layer `Receipt` EIP-712 type (SL §5.8), carried inside an
    ///         SL_RECEIPT signature so the vault recomputes the struct hash itself (RV-013).
    struct SlReceipt {
        bytes32 paymentRefHash;
        bytes32 requestCommit;
        bytes32 responseCommit;
        uint16 statusCode;
        string originAsserted;
        bytes32 requirementsHashSeen;
        uint64 tRequest;
        uint64 tPaymentSigned;
        uint64 tComplete;
        uint8 outcome;
        bytes32 localChecksCommit;
        uint8 disclosure;
        uint64 createdAt;
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
    /// @notice New value of the per-step usage counter shared by a step's payee and alternates (RV-002).
    event StepUsed(uint64 indexed envelopeId, uint32 indexed stepIndex, uint256 used);
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
    event PullbackConfirmed(uint64 indexed pullbackId, address indexed pocket, uint256 value, bool creditedToEnvelope);
    event PullbackCancelled(uint64 indexed pullbackId);
    event PocketClosed(address indexed pocket, uint256 writtenOff);
    event ManualReturnRecorded(address indexed pocket, uint256 amount);
    /// @notice An inbound credit found the money already withdrawn as free balance (RV-011).
    event ShortfallRecorded(uint64 indexed envelopeId, uint256 amount, uint256 shortfallTotal);
    /// @notice Owner changed the pullback fee bound (D81).
    event MaxPullbackFeeSet(uint256 oldMax, uint256 newMax);
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
    error StepCapExceeded(uint32 stepIndex, uint256 used, uint256 stepCap, uint256 wanted);
    error PocketNotInPlan();
    error PocketCapZero();
    error PocketWrongState();
    error PullbackWrongState();
    error RaiseNotAbove();
    error FeeCeilingExceeded(uint256 wanted, uint256 ceiling);
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
    /// @notice Owner or agent stops all spending digests and spending functions; also bumps autonomyNonce (RV-030).
    function freeze() external;
    /// @notice Owner only.
    function unfreeze() external;
    /// @notice Owner rotates the agent, autonomy and evaluator addresses (none may be zero).
    function rotateSigners(address agent, address autonomy, address evaluator_) external;
    /// @notice Owner registers the P-256 passkey public key and the expected rpIdHash (D30 fallback).
    function setPasskey(bytes32 qx, bytes32 qy, bytes32 rpIdHash) external;
    /// @notice Owner sets the bound on requestPullback.maxFee; 0 < newMax <= MAX_PULLBACK_FEE_CEILING (D81).
    function setMaxPullbackFee(uint256 newMax) external;
    /// @notice Anyone relays an owner action signed by the passkey (02 §6.2 OwnerAction, czar-vault.md §7).
    function executeOwnerAction(uint8 action, bytes calldata payload, uint256 deadline, WebAuthnAuth calldata auth)
        external;

    // ───────────────────────────── Envelopes ─────────────────────────────

    /// @notice Owner, or agent within the category's weekly allowance. Returns the new envelopeId.
    function openEnvelope(OpenEnvelopeParams calldata p) external returns (uint64 envelopeId);
    /// @notice Owner or agent any time; anyone after expiry. Requires no open reservations, pockets or jobs.
    function closeEnvelope(uint64 envelopeId) external;
    /// @notice Owner only, after expiry + 1 day; writes off and closes the envelope's pocket, releases unfunded jobs (RV-005).
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
    /// @notice Anyone: mark indices whose nonce USDC consumed as spent; makes the reservation Final when every
    ///         index is done (popcount(doneMask) == count, RV-001).
    function settle(uint64 reservationId, uint32[] calldata indices) external;
    /// @notice Anyone, after validBefore: settle used indices, release the rest, chunked. Skips done indices.
    function finalize(uint64 reservationId, uint32 fromIndex, uint32 toIndex) external;

    // ─────────────────────────────── Pockets ─────────────────────────────

    /// @notice Agent registers an EOA pocket for an envelope (one pocket per envelope, one envelope per pocket).
    ///         `proof` proves leaf(pocket, kind 4, POCKET_STEP_INDEX, 0) under the envelope's payeeRoot (D71).
    function registerPocket(uint64 envelopeId, address pocket, bytes32[] calldata proof) external;
    /// @notice Agent sends native USDC gas to the pocket; counted as spent from the envelope.
    function grantPocketGas(address pocket, uint256 units) external;
    /// @notice Agent deposits into the pocket's Gateway balance via depositFor, after the delegate check.
    function fundPocket(address pocket, uint256 amount) external;
    /// @notice Agent or owner fixes every field of a same-chain burn intent back to this vault. Returns pullbackId.
    ///         On a Closed pocket this is a recovery pullback credited to free balance (RV-004).
    function requestPullback(address pocket, uint256 value, uint256 maxFee, uint256 maxBlockHeight)
        external
        returns (uint64 pullbackId);
    /// @notice Anyone: credit a pullback once GatewayMinter.isTransferSpecHashUsed(transferSpecHash) is true.
    function confirmPullback(uint64 pullbackId) external;
    /// @notice Agent or owner, after maxBlockHeight + PULLBACK_CANCEL_DELAY_BLOCKS, if never minted (RV-036).
    function cancelPullback(uint64 pullbackId) external;
    /// @notice Agent or owner: treat the remaining outstanding balance as spent and close the pocket.
    function writeOffPocket(address pocket) external;
    /// @notice Owner only: record funds returned through the 7-day on-chain withdrawal path.
    ///         Credits min(amount, outstanding - pendingPullback, freeBalance()) (RV-010).
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
    /// @notice Anyone: mirror the escrow's job status into vault accounting (escrow status only; Opened jobs
    ///         are released after expiry or rejection, RV-009).
    function syncJob(bytes32 jobKey) external;
    /// @notice Anyone, after expiry: call the escrow's claimRefund and un-spend the budget.
    function claimJobRefund(bytes32 jobKey) external;

    // ─────────────────────────── Earned autonomy ─────────────────────────

    /// @notice Anyone relays an AutonomyRaise signed by autonomySigner; owner may call with empty sig.
    function raiseAutoLimit(bytes32 categoryId, uint256 newLimit, uint64 periodId, uint256 deadline, bytes calldata sig)
        external;
    /// @notice Owner, agent or autonomy signer lowers the limit (newLimit <= autoLimit; bumps autonomyNonce).
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
    /// @notice Current bound on requestPullback.maxFee (D81).
    function maxPullbackFee() external view returns (uint256);
    /// @notice Amount reserved or spent for one plan step, shared by its payee and alternates (RV-002).
    function stepUsed(uint64 envelopeId, uint32 stepIndex) external view returns (uint256);
    /// @notice The envelope's single pocket, or address(0) (D48, RV-005).
    function envelopePocket(uint64 envelopeId) external view returns (address);
    /// @notice Money owed back to the envelope that was already withdrawn as free balance (RV-011).
    function envelopeShortfall(uint64 envelopeId) external view returns (uint256);

    // ───────────────────────────── Constants ─────────────────────────────

    /// @notice 500000 (0.50 USDC): hard ceiling on maxPullbackFee (D81).
    function MAX_PULLBACK_FEE_CEILING() external view returns (uint256);
    /// @notice 2500: largest pocketCapBps for an agent-opened envelope (D22, D71).
    function MAX_AGENT_POCKET_CAP_BPS() external view returns (uint16);
    /// @notice type(uint32).max: stepIndex of every pocket leaf (kind 4) in payeeRoot (D71).
    function POCKET_STEP_INDEX() external view returns (uint32);

    /// @notice ERC-1271. Dispatches on the kind tag in `signature` (02 §6.3) or the 65-byte fallback.
    ///         Never reverts; returns 0x1626ba7e or 0xffffffff.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4);
}
