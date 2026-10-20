// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICzarVault} from "./interfaces/ICzarVault.sol";
import {VaultBase} from "./vault/VaultBase.sol";
import {CoreLogic} from "./vault/logic/CoreLogic.sol";
import {EnvelopeLogic} from "./vault/logic/EnvelopeLogic.sol";
import {ReservationLogic} from "./vault/logic/ReservationLogic.sol";
import {SignatureLogic} from "./vault/logic/SignatureLogic.sol";
import {PocketLogic} from "./vault/logic/PocketLogic.sol";
import {JobLogic} from "./vault/logic/JobLogic.sol";
import {AutonomyLogic} from "./vault/logic/AutonomyLogic.sol";
import {OwnerActionLogic} from "./vault/logic/OwnerActionLogic.sol";

/// @title CzarVault
/// @notice The per-user vault (czar-vault.md). Immutable; no proxy (D33). Every state-changing function is a thin
///         wrapper: the reentrancy guard (§15.5) stays here, the logic runs in a linked library by DELEGATECALL on
///         this vault's storage (07 PRD 03). `msg.sender` is passed as `caller`, so the passkey path can pass the owner.
contract CzarVault is VaultBase {
    /// @dev czar-vault.md §15.8. Called by CzarVaultFactory.createVault through CREATE2.
    constructor(address ownerAccount) VaultBase(ownerAccount) {}

    // ───────────── Balance and owner settings (§5.1) ─────────────

    /// @dev Native USDC arrives as free balance (A1-05). Not in ICzarVault.
    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }

    /// @inheritdoc ICzarVault
    function sync() external nonReentrant {
        emit BalanceSynced(IERC20(USDC).balanceOf(address(this)), _s.committedTotal);
    }

    /// @inheritdoc ICzarVault
    function withdraw(address to, uint256 amount) external nonReentrant {
        CoreLogic.withdraw(_s, _config(), msg.sender, to, amount);
    }

    /// @inheritdoc ICzarVault
    function setCategoryLimits(bytes32 categoryId, uint256 userMax, uint256 autoLimit) external {
        CoreLogic.setCategoryLimits(_s, _config(), msg.sender, categoryId, userMax, autoLimit);
    }

    /// @inheritdoc ICzarVault
    function freeze() external {
        CoreLogic.freeze(_s, _config(), msg.sender);
    }

    /// @inheritdoc ICzarVault
    function unfreeze() external {
        CoreLogic.unfreeze(_s, _config(), msg.sender);
    }

    /// @inheritdoc ICzarVault
    function rotateSigners(address agent, address autonomy, address evaluator_) external {
        CoreLogic.rotateSigners(_s, _config(), msg.sender, agent, autonomy, evaluator_);
    }

    /// @inheritdoc ICzarVault
    function setPasskey(bytes32 qx, bytes32 qy, bytes32 rpIdHash) external {
        CoreLogic.setPasskey(_s, _config(), msg.sender, qx, qy, rpIdHash);
    }

    /// @inheritdoc ICzarVault
    function setMaxPullbackFee(uint256 newMax) external {
        CoreLogic.setMaxPullbackFee(_s, _config(), msg.sender, newMax);
    }

    /// @inheritdoc ICzarVault
    function executeOwnerAction(uint8 action, bytes calldata payload, uint256 deadline, WebAuthnAuth calldata auth)
        external
        nonReentrant
    {
        OwnerActionLogic.executeOwnerAction(_s, _config(), action, payload, deadline, auth);
    }

    // ───────────── Envelopes (§5.2) ─────────────

    /// @inheritdoc ICzarVault
    function openEnvelope(OpenEnvelopeParams calldata p) external nonReentrant returns (uint64) {
        return EnvelopeLogic.openEnvelope(_s, _config(), msg.sender, p);
    }

    /// @inheritdoc ICzarVault
    function closeEnvelope(uint64 envelopeId) external {
        EnvelopeLogic.closeEnvelope(_s, _config(), msg.sender, envelopeId);
    }

    /// @inheritdoc ICzarVault
    function forceCloseEnvelope(uint64 envelopeId) external {
        EnvelopeLogic.forceCloseEnvelope(_s, _config(), msg.sender, envelopeId);
    }

    // ───────────── Reservations (§5.3) ─────────────

    /// @inheritdoc ICzarVault
    function reserve(
        uint64 envelopeId,
        uint32 stepIndex,
        address payee,
        uint256 stepCap,
        bytes32[] calldata proof,
        uint256 unitAmount,
        uint32 count,
        uint64 validBefore
    ) external returns (uint64) {
        ReservationLogic.ReserveRequest memory q = ReservationLogic.ReserveRequest(
            envelopeId, stepIndex, payee, stepCap, unitAmount, count, validBefore, ReservationMode.Envelope
        );
        return ReservationLogic.reserve(_s, _config(), msg.sender, q, proof);
    }

    /// @inheritdoc ICzarVault
    function reserveWithDigests(
        uint64 envelopeId,
        uint32 stepIndex,
        address payee,
        uint256 stepCap,
        bytes32[] calldata proof,
        uint256 unitAmount,
        uint32 count,
        uint64 validBefore
    ) external returns (uint64) {
        ReservationLogic.ReserveRequest memory q = ReservationLogic.ReserveRequest(
            envelopeId, stepIndex, payee, stepCap, unitAmount, count, validBefore, ReservationMode.Digest
        );
        return ReservationLogic.reserve(_s, _config(), msg.sender, q, proof);
    }

    /// @inheritdoc ICzarVault
    function settle(uint64 reservationId, uint32[] calldata indices) external nonReentrant {
        ReservationLogic.settle(_s, _config(), reservationId, indices);
    }

    /// @inheritdoc ICzarVault
    function finalize(uint64 reservationId, uint32 fromIndex, uint32 toIndex) external nonReentrant {
        ReservationLogic.finalize(_s, _config(), reservationId, fromIndex, toIndex);
    }

    // ───────────── ERC-1271 (§6) ─────────────

    /// @inheritdoc ICzarVault
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        return SignatureLogic.isValidSignature(_s, _config(), digest, signature);
    }

    // ───────────── Pockets (§5.4) ─────────────

    /// @inheritdoc ICzarVault
    function registerPocket(uint64 envelopeId, address pocket, bytes32[] calldata proof) external {
        PocketLogic.registerPocket(_s, _config(), msg.sender, envelopeId, pocket, proof);
    }

    /// @inheritdoc ICzarVault
    function grantPocketGas(address pocket, uint256 units) external nonReentrant {
        PocketLogic.grantPocketGas(_s, _config(), msg.sender, pocket, units);
    }

    /// @inheritdoc ICzarVault
    function fundPocket(address pocket, uint256 amount) external nonReentrant {
        PocketLogic.fundPocket(_s, _config(), msg.sender, pocket, amount);
    }

    /// @inheritdoc ICzarVault
    function requestPullback(address pocket, uint256 value, uint256 maxFee, uint256 maxBlockHeight)
        external
        returns (uint64)
    {
        return PocketLogic.requestPullback(_s, _config(), msg.sender, pocket, value, maxFee, maxBlockHeight);
    }

    /// @inheritdoc ICzarVault
    function confirmPullback(uint64 pullbackId) external nonReentrant {
        PocketLogic.confirmPullback(_s, _config(), pullbackId);
    }

    /// @inheritdoc ICzarVault
    function cancelPullback(uint64 pullbackId) external nonReentrant {
        PocketLogic.cancelPullback(_s, _config(), msg.sender, pullbackId);
    }

    /// @inheritdoc ICzarVault
    function writeOffPocket(address pocket) external {
        PocketLogic.writeOffPocket(_s, _config(), msg.sender, pocket);
    }

    /// @inheritdoc ICzarVault
    function recordManualReturn(address pocket, uint256 amount) external nonReentrant {
        PocketLogic.recordManualReturn(_s, _config(), msg.sender, pocket, amount);
    }

    // ───────────── Jobs (§5.5) ─────────────

    /// @inheritdoc ICzarVault
    function openJob(
        uint64 envelopeId,
        uint32 stepIndex,
        address provider,
        uint256 stepCap,
        bytes32[] calldata proof,
        uint64 expiredAt,
        bytes32 descriptionHash
    ) external nonReentrant returns (bytes32) {
        JobLogic.OpenJobRequest memory q = JobLogic.OpenJobRequest(
            envelopeId, stepIndex, provider, stepCap, expiredAt, descriptionHash
        );
        return JobLogic.openJob(_s, _config(), msg.sender, q, proof);
    }

    /// @inheritdoc ICzarVault
    function fundJob(bytes32 jobKey, uint256 expectedBudget) external nonReentrant {
        JobLogic.fundJob(_s, _config(), msg.sender, jobKey, expectedBudget);
    }

    /// @inheritdoc ICzarVault
    function cancelJob(bytes32 jobKey) external nonReentrant {
        JobLogic.cancelJob(_s, _config(), msg.sender, jobKey);
    }

    /// @inheritdoc ICzarVault
    function syncJob(bytes32 jobKey) external nonReentrant {
        JobLogic.syncJob(_s, _config(), jobKey);
    }

    /// @inheritdoc ICzarVault
    function claimJobRefund(bytes32 jobKey) external nonReentrant {
        JobLogic.claimJobRefund(_s, _config(), jobKey);
    }

    // ───────────── Earned autonomy (§5.6) ─────────────

    /// @inheritdoc ICzarVault
    function raiseAutoLimit(bytes32 categoryId, uint256 newLimit, uint64 periodId, uint256 deadline, bytes calldata sig)
        external
    {
        AutonomyLogic.raiseAutoLimit(_s, _config(), msg.sender, categoryId, newLimit, periodId, deadline, sig);
    }

    /// @inheritdoc ICzarVault
    function lowerAutoLimit(bytes32 categoryId, uint256 newLimit) external {
        AutonomyLogic.lowerAutoLimit(_s, _config(), msg.sender, categoryId, newLimit);
    }
}
