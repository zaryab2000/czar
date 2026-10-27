// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ICzarVault} from "../../interfaces/ICzarVault.sol";
import {VaultState, VaultConfig} from "../VaultState.sol";
import {VaultGuards} from "../VaultGuards.sol";
import {CzarHashing} from "../../libraries/CzarHashing.sol";
import {PERIOD_LENGTH, MAX_RAISE_STEP_BPS, BPS} from "../../libraries/CzarConstants.sol";

/// @title AutonomyLogic
/// @notice Earned autonomy limit changes (czar-vault.md §5.6, §15.10; T-019) in a linked library.
library AutonomyLogic {
    /// @notice Raises an auto limit with an authorized signature (czar-vault.md §15.10).
    function raiseAutoLimit(
        VaultState storage s,
        VaultConfig memory c,
        address caller,
        bytes32 categoryId,
        uint256 newLimit,
        uint64 periodId,
        uint256 deadline,
        bytes memory sig
    ) external {
        VaultGuards.requireNotPausedOrFrozen(s, c);
        if (block.timestamp > deadline) revert ICzarVault.Expired();
        if (periodId != block.timestamp / PERIOD_LENGTH) revert ICzarVault.BadParams();
        if (sig.length == 0) {
            if (caller != c.owner) revert ICzarVault.BadSigner();
        } else {
            bytes32 digest = CzarHashing.typedDataHash(
                c.vaultDomainSeparator,
                CzarHashing.autonomyRaiseStructHash(categoryId, newLimit, periodId, s.autonomyNonce, deadline)
            );
            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
            if (err != ECDSA.RecoverError.NoError || signer != s.autonomySigner) {
                revert ICzarVault.BadSigner();
            }
        }
        ICzarVault.CategoryLimits storage l = s.limits[categoryId];
        if (l.lastRaiseAt != 0 && block.timestamp < l.lastRaiseAt + PERIOD_LENGTH) {
            revert ICzarVault.RaiseAlreadyThisPeriod();
        }
        uint256 oldLimit = l.autoLimit;
        if (newLimit <= oldLimit) revert ICzarVault.RaiseNotAbove();
        if (newLimit > l.userMax) revert ICzarVault.AutoLimitAboveUserMax();
        if (newLimit - oldLimit > l.userMax * MAX_RAISE_STEP_BPS / BPS) {
            revert ICzarVault.RaiseTooLarge();
        }
        l.autoLimit = newLimit;
        l.lastRaiseAt = SafeCast.toUint64(block.timestamp);
        s.autonomyNonce++;
        emit ICzarVault.AutoLimitRaised(categoryId, oldLimit, newLimit, periodId);
    }

    /// @notice Lowers an auto limit even while frozen (czar-vault.md §5.6, RV-030).
    function lowerAutoLimit(
        VaultState storage s,
        VaultConfig memory c,
        address caller,
        bytes32 categoryId,
        uint256 newLimit
    ) external {
        if (caller != c.owner && caller != s.agentSigner && caller != s.autonomySigner) {
            revert ICzarVault.NotAuthorized();
        }
        ICzarVault.CategoryLimits storage l = s.limits[categoryId];
        uint256 oldLimit = l.autoLimit;
        if (newLimit > oldLimit) revert ICzarVault.BadParams();
        l.autoLimit = newLimit;
        s.autonomyNonce++;
        emit ICzarVault.AutoLimitLowered(categoryId, oldLimit, newLimit, caller);
    }
}
