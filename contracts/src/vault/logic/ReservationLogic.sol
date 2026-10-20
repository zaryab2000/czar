// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../../interfaces/ICzarVault.sol";
import {VaultState, VaultConfig, DigestSlot} from "../VaultState.sol";
import {VaultGuards} from "../VaultGuards.sol";
import {PayeeLeaf} from "../../libraries/PayeeLeaf.sol";
import {
    MAX_AUTHORIZATIONS_PER_RESERVATION,
    MAX_DIGEST_MODE_COUNT,
    MIN_RESERVATION_TTL,
    MAX_RESERVATION_TTL,
    FINALIZE_CHUNK,
    PAYEE_KIND_X402,
    POCKET_STEP_INDEX
} from "../../libraries/CzarConstants.sol";

/// @dev USDC authorization state read (czar-vault.md §10; A1-11).
interface IUSDCAuthorizationState {
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @title ReservationLogic
/// @notice Reservation lifecycle (czar-vault.md §5.3, §6.5, §15; T-015) in a linked library.
library ReservationLogic {
    struct ReserveRequest {
        uint64 envelopeId;
        uint32 stepIndex;
        address payee;
        uint256 stepCap;
        uint256 unitAmount;
        uint32 count;
        uint64 validBefore;
        ICzarVault.ReservationMode mode;
    }

    /// @notice Reserves a bounded payment step (czar-vault.md §5.3, §15.3).
    function reserve(
        VaultState storage s,
        VaultConfig memory c,
        address caller,
        ReserveRequest memory q,
        bytes32[] calldata proof
    ) external returns (uint64 reservationId) {
        (uint256 total, uint256 used) = _checkReserve(s, c, caller, q, proof);
        reservationId = _storeReservation(s, c, q, total, used);
    }

    /// @dev Checks role, plan, time, and exposure before storage writes (czar-vault.md §5.3, §15.3).
    function _checkReserve(
        VaultState storage s,
        VaultConfig memory c,
        address caller,
        ReserveRequest memory q,
        bytes32[] calldata proof
    ) private view returns (uint256 total, uint256 used) {
        VaultGuards.requireAgent(s, caller);
        VaultGuards.requireNotPausedOrFrozen(s, c);
        ICzarVault.Envelope storage e = s.envelopes[q.envelopeId];
        if (e.state != ICzarVault.EnvelopeState.Open) revert ICzarVault.EnvelopeNotOpen();
        if (block.timestamp >= e.expiresAt) revert ICzarVault.EnvelopeExpired();
        if (q.stepIndex == POCKET_STEP_INDEX || q.unitAmount == 0 || q.stepCap > e.maxStepAmount) {
            revert ICzarVault.BadParams();
        }
        uint256 maxCount =
            q.mode == ICzarVault.ReservationMode.Digest ? MAX_DIGEST_MODE_COUNT : MAX_AUTHORIZATIONS_PER_RESERVATION;
        if (q.count == 0 || q.count > maxCount) revert ICzarVault.BadCount();
        if (
            q.validBefore < block.timestamp + MIN_RESERVATION_TTL
                || q.validBefore > block.timestamp + MAX_RESERVATION_TTL || q.validBefore > e.expiresAt
        ) revert ICzarVault.BadTtl();
        if (!PayeeLeaf.verify(proof, e.payeeRoot, q.payee, PAYEE_KIND_X402, q.stepIndex, q.stepCap)) {
            revert ICzarVault.PayeeNotInPlan();
        }
        total = q.unitAmount * q.count;
        used = s.stepUsed[q.envelopeId][q.stepIndex];
        if (used + total > q.stepCap) {
            revert ICzarVault.StepCapExceeded(q.stepIndex, used, q.stepCap, total);
        }
        if (VaultGuards.exposure(e) + total > e.cap) revert ICzarVault.CapExceeded();
    }

    /// @dev Stores one reservation and its digest lookup slots (czar-vault.md §5.3, §15.4).
    function _storeReservation(
        VaultState storage s,
        VaultConfig memory c,
        ReserveRequest memory q,
        uint256 total,
        uint256 used
    ) private returns (uint64 reservationId) {
        reservationId = ++s.reservationCount;
        ICzarVault.Reservation storage r = s.reservations[reservationId];
        r.envelopeId = q.envelopeId;
        r.stepIndex = q.stepIndex;
        r.payee = q.payee;
        r.unitAmount = q.unitAmount;
        r.count = q.count;
        r.validBefore = q.validBefore;
        r.mode = q.mode;
        r.state = ICzarVault.ReservationState.Active;
        ICzarVault.Envelope storage e = s.envelopes[q.envelopeId];
        e.reserved += total;
        e.openReservations += 1;
        s.stepUsed[q.envelopeId][q.stepIndex] = used + total;
        if (q.mode == ICzarVault.ReservationMode.Digest) {
            for (uint32 i = 0; i < q.count; i++) {
                bytes32 digest = VaultGuards.usdcDigest(c, q.payee, q.unitAmount, q.validBefore, reservationId, i);
                s.digestSlot[digest] = DigestSlot({reservationId: reservationId, index: i, set: true});
            }
        }
        emit ICzarVault.Reserved(
            reservationId, q.envelopeId, q.payee, q.stepIndex, q.unitAmount, q.count, q.validBefore, uint8(q.mode)
        );
        emit ICzarVault.StepUsed(q.envelopeId, q.stepIndex, used + total);
    }

    /// @notice Books consumed authorizations (czar-vault.md §5.3, RV-001).
    function settle(VaultState storage s, VaultConfig memory c, uint64 reservationId, uint32[] calldata indices)
        external
    {
        ICzarVault.Reservation storage r = s.reservations[reservationId];
        if (r.state != ICzarVault.ReservationState.Active && r.state != ICzarVault.ReservationState.Finalizing) {
            revert ICzarVault.ReservationNotActive();
        }
        if (indices.length == 0 || indices.length > FINALIZE_CHUNK) revert ICzarVault.BadParams();
        for (uint256 k = 0; k < indices.length; k++) {
            uint32 index = indices[k];
            if (index >= r.count) revert ICzarVault.BadParams();
            uint128 bit = uint128(1) << index;
            if (r.doneMask & bit != 0) revert ICzarVault.AlreadyDone(index);
            if (!_authorizationUsed(c, reservationId, index)) revert ICzarVault.NotUsed(index);
            _bookSettled(s, r, reservationId, index, bit);
        }
        _finalizeIfDone(s, c, reservationId);
    }

    /// @notice Finalizes a reservation range after expiry (czar-vault.md §5.3, §15.7).
    function finalize(
        VaultState storage s,
        VaultConfig memory c,
        uint64 reservationId,
        uint32 fromIndex,
        uint32 toIndex
    ) external {
        ICzarVault.Reservation storage r = s.reservations[reservationId];
        if (r.state != ICzarVault.ReservationState.Active && r.state != ICzarVault.ReservationState.Finalizing) {
            revert ICzarVault.ReservationNotActive();
        }
        if (block.timestamp <= r.validBefore) revert ICzarVault.NotExpired();
        if (fromIndex >= toIndex || toIndex > r.count || toIndex - fromIndex > FINALIZE_CHUNK) {
            revert ICzarVault.BadParams();
        }
        if (r.state == ICzarVault.ReservationState.Active) r.state = ICzarVault.ReservationState.Finalizing;
        ICzarVault.Envelope storage e = s.envelopes[r.envelopeId];
        uint256 usedBefore = s.stepUsed[r.envelopeId][r.stepIndex];
        for (uint32 index = fromIndex; index < toIndex; index++) {
            uint128 bit = uint128(1) << index;
            if (r.doneMask & bit != 0) continue;
            if (_authorizationUsed(c, reservationId, index)) {
                _bookSettled(s, r, reservationId, index, bit);
            } else {
                r.doneMask |= bit;
                r.releasedCount += 1;
                e.reserved -= r.unitAmount;
                s.stepUsed[r.envelopeId][r.stepIndex] -= r.unitAmount;
                emit ICzarVault.Released(reservationId, index, r.unitAmount);
            }
        }
        uint256 usedAfter = s.stepUsed[r.envelopeId][r.stepIndex];
        if (usedAfter != usedBefore) emit ICzarVault.StepUsed(r.envelopeId, r.stepIndex, usedAfter);
        _finalizeIfDone(s, c, reservationId);
    }

    /// @dev Reads USDC's authorization state for a derived nonce (czar-vault.md §5.3).
    function _authorizationUsed(VaultConfig memory c, uint64 reservationId, uint32 index) private view returns (bool) {
        return IUSDCAuthorizationState(c.usdc)
            .authorizationState(address(this), VaultGuards.derivedNonce(reservationId, index));
    }

    /// @dev Moves one reserved authorization to spent (czar-vault.md §5.3, INV-8).
    function _bookSettled(
        VaultState storage s,
        ICzarVault.Reservation storage r,
        uint64 reservationId,
        uint32 index,
        uint128 bit
    ) private {
        r.settledMask |= bit;
        r.doneMask |= bit;
        r.settledCount += 1;
        ICzarVault.Envelope storage e = s.envelopes[r.envelopeId];
        e.reserved -= r.unitAmount;
        e.spent += r.unitAmount;
        s.committedTotal -= r.unitAmount;
        emit ICzarVault.Settled(reservationId, index, r.unitAmount);
    }

    /// @dev Closes fully processed reservations and clears digest slots (czar-vault.md §15.11, RV-001).
    function _finalizeIfDone(VaultState storage s, VaultConfig memory c, uint64 reservationId) private {
        ICzarVault.Reservation storage r = s.reservations[reservationId];
        if (r.state == ICzarVault.ReservationState.Final || r.settledCount + r.releasedCount != r.count) return;
        r.state = ICzarVault.ReservationState.Final;
        s.envelopes[r.envelopeId].openReservations -= 1;
        if (r.mode == ICzarVault.ReservationMode.Digest) {
            for (uint32 i = 0; i < r.count; i++) {
                delete s.digestSlot[VaultGuards.usdcDigest(c, r.payee, r.unitAmount, r.validBefore, reservationId, i)];
            }
        }
        emit ICzarVault.ReservationFinal(reservationId, r.settledCount, r.releasedCount);
    }
}
