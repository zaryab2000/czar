// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ICzarVault} from "../../interfaces/ICzarVault.sol";
import {VaultState, VaultConfig} from "../VaultState.sol";
import {CzarHashing} from "../../libraries/CzarHashing.sol";
import {PasskeyVerifier} from "../../libraries/PasskeyVerifier.sol";
import {PERIOD_LENGTH} from "../../libraries/CzarConstants.sol";
import {CoreLogic} from "./CoreLogic.sol";
import {EnvelopeLogic} from "./EnvelopeLogic.sol";
import {PocketLogic} from "./PocketLogic.sol";
import {JobLogic} from "./JobLogic.sol";
import {AutonomyLogic} from "./AutonomyLogic.sol";

/// @title OwnerActionLogic
/// @notice Passkey owner actions (czar-vault.md §7, §15.9; 02 §6.2; T-019) call the direct-path libraries with caller = owner.
library OwnerActionLogic {
    /// @dev The 17th and final owner action is CancelJob (H2).
    uint8 internal constant MAX_OWNER_ACTION = uint8(ICzarVault.OwnerActionKind.CancelJob);

    /// @notice Verifies a passkey assertion and dispatches an owner action (czar-vault.md §15.9).
    function executeOwnerAction(
        VaultState storage s,
        VaultConfig memory c,
        uint8 action,
        bytes calldata payload,
        uint256 deadline,
        ICzarVault.WebAuthnAuth calldata auth
    ) external {
        ICzarVault.Passkey memory k = s.passkey;
        if (!k.set) revert ICzarVault.PasskeyNotSet();
        if (block.timestamp > deadline) revert ICzarVault.Expired();
        if (action == 0 || action > MAX_OWNER_ACTION) revert ICzarVault.UnknownAction();
        uint256 nonce = s.ownerActionNonce;
        bytes32 digest = CzarHashing.typedDataHash(
            c.vaultDomainSeparator, CzarHashing.ownerActionStructHash(action, keccak256(payload), nonce, deadline)
        );
        if (!PasskeyVerifier.verify(digest, auth, k.qx, k.qy, k.rpIdHash)) {
            revert ICzarVault.InvalidPasskeyAssertion();
        }
        s.ownerActionNonce = nonce + 1;
        _dispatch(s, c, ICzarVault.OwnerActionKind(action), payload, deadline);
        emit ICzarVault.OwnerActionExecuted(action, nonce);
    }

    /// @dev Decodes and calls the matching direct-path library (czar-vault.md §7 payload table).
    function _dispatch(
        VaultState storage s,
        VaultConfig memory c,
        ICzarVault.OwnerActionKind a,
        bytes calldata payload,
        uint256 deadline
    ) private {
        address o = c.owner;
        if (a == ICzarVault.OwnerActionKind.OpenEnvelope) {
            ICzarVault.OpenEnvelopeParams memory p = abi.decode(payload, (ICzarVault.OpenEnvelopeParams));
            EnvelopeLogic.openEnvelope(s, c, o, p);
        } else if (a == ICzarVault.OwnerActionKind.SetLimits) {
            (bytes32 categoryId, uint256 userMax, uint256 autoLimit) = abi.decode(payload, (bytes32, uint256, uint256));
            CoreLogic.setCategoryLimits(s, c, o, categoryId, userMax, autoLimit);
        } else if (a == ICzarVault.OwnerActionKind.Freeze) {
            CoreLogic.freeze(s, c, o);
        } else if (a == ICzarVault.OwnerActionKind.Unfreeze) {
            CoreLogic.unfreeze(s, c, o);
        } else if (a == ICzarVault.OwnerActionKind.Withdraw) {
            (address to, uint256 amount) = abi.decode(payload, (address, uint256));
            CoreLogic.withdraw(s, c, o, to, amount);
        } else if (a == ICzarVault.OwnerActionKind.RotateSigners) {
            (address agent, address autonomy, address evaluator) = abi.decode(payload, (address, address, address));
            CoreLogic.rotateSigners(s, c, o, agent, autonomy, evaluator);
        } else if (a == ICzarVault.OwnerActionKind.SetPasskey) {
            (bytes32 qx, bytes32 qy, bytes32 rpIdHash) = abi.decode(payload, (bytes32, bytes32, bytes32));
            CoreLogic.setPasskey(s, c, o, qx, qy, rpIdHash);
        } else if (a == ICzarVault.OwnerActionKind.CloseEnvelope) {
            uint64 envelopeId = abi.decode(payload, (uint64));
            EnvelopeLogic.closeEnvelope(s, c, o, envelopeId);
        } else if (a == ICzarVault.OwnerActionKind.ForceCloseEnvelope) {
            uint64 envelopeId = abi.decode(payload, (uint64));
            EnvelopeLogic.forceCloseEnvelope(s, c, o, envelopeId);
        } else if (a == ICzarVault.OwnerActionKind.RecordManualReturn) {
            (address pocket, uint256 amount) = abi.decode(payload, (address, uint256));
            PocketLogic.recordManualReturn(s, c, o, pocket, amount);
        } else if (a == ICzarVault.OwnerActionKind.RaiseAutoLimit) {
            (bytes32 categoryId, uint256 newLimit) = abi.decode(payload, (bytes32, uint256));
            uint64 periodId = SafeCast.toUint64(block.timestamp / PERIOD_LENGTH);
            AutonomyLogic.raiseAutoLimit(s, c, o, categoryId, newLimit, periodId, deadline, "");
        } else if (a == ICzarVault.OwnerActionKind.LowerAutoLimit) {
            (bytes32 categoryId, uint256 newLimit) = abi.decode(payload, (bytes32, uint256));
            AutonomyLogic.lowerAutoLimit(s, c, o, categoryId, newLimit);
        } else if (a == ICzarVault.OwnerActionKind.RequestPullback) {
            (address pocket, uint256 value, uint256 maxFee, uint256 maxBlockHeight) =
                abi.decode(payload, (address, uint256, uint256, uint256));
            PocketLogic.requestPullback(s, c, o, pocket, value, maxFee, maxBlockHeight);
        } else if (a == ICzarVault.OwnerActionKind.CancelPullback) {
            uint64 pullbackId = abi.decode(payload, (uint64));
            PocketLogic.cancelPullback(s, c, o, pullbackId);
        } else if (a == ICzarVault.OwnerActionKind.WriteOffPocket) {
            address pocket = abi.decode(payload, (address));
            PocketLogic.writeOffPocket(s, c, o, pocket);
        } else if (a == ICzarVault.OwnerActionKind.SetMaxPullbackFee) {
            uint256 newMax = abi.decode(payload, (uint256));
            CoreLogic.setMaxPullbackFee(s, c, o, newMax);
        } else {
            bytes32 jobKey = abi.decode(payload, (bytes32));
            JobLogic.cancelJob(s, c, o, jobKey);
        }
    }
}
