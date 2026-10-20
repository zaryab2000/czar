// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICzarVault} from "../../interfaces/ICzarVault.sol";
import {VaultState, VaultConfig} from "../VaultState.sol";
import {VaultGuards} from "../VaultGuards.sol";
import {MAX_PULLBACK_FEE_CEILING} from "../../libraries/CzarConstants.sol";

/// @title CoreLogic
/// @notice Withdraw and owner settings (czar-vault.md §5.1, §15; T-013); linked library run by DELEGATECALL.
library CoreLogic {
    using SafeERC20 for IERC20;

    /// @notice Withdraws free USDC for the owner (czar-vault.md §5.1, §15.11).
    function withdraw(VaultState storage s, VaultConfig memory c, address caller, address to, uint256 amount) external {
        VaultGuards.requireOwner(c, caller);
        if (to == address(0)) revert ICzarVault.ZeroAddress();
        if (to == address(this) || amount == 0) revert ICzarVault.BadParams();
        uint256 free = VaultGuards.freeBalance(s, c);
        if (amount > free) revert ICzarVault.InsufficientFree(free, amount);
        IERC20(c.usdc).safeTransfer(to, amount);
        emit ICzarVault.Withdrawn(to, amount);
    }

    /// @notice Sets category limits and invalidates pending raises (czar-vault.md §5.1, §15.10).
    function setCategoryLimits(
        VaultState storage s,
        VaultConfig memory c,
        address caller,
        bytes32 categoryId,
        uint256 userMax,
        uint256 autoLimit
    ) external {
        VaultGuards.requireOwner(c, caller);
        if (autoLimit > userMax) revert ICzarVault.AutoLimitAboveUserMax();
        ICzarVault.CategoryLimits storage l = s.limits[categoryId];
        l.userMax = userMax;
        l.autoLimit = autoLimit;
        s.autonomyNonce++;
        emit ICzarVault.LimitsSet(categoryId, userMax, autoLimit);
    }

    /// @notice Freezes the vault and invalidates pending raises (czar-vault.md §5.1, §15.11).
    function freeze(VaultState storage s, VaultConfig memory c, address caller) external {
        VaultGuards.requireOwnerOrAgent(s, c, caller);
        s.frozen = true;
        s.autonomyNonce++;
        emit ICzarVault.Frozen(caller);
    }

    /// @notice Unfreezes the vault for its owner (czar-vault.md §5.1).
    function unfreeze(VaultState storage s, VaultConfig memory c, address caller) external {
        VaultGuards.requireOwner(c, caller);
        s.frozen = false;
        emit ICzarVault.Unfrozen();
    }

    /// @notice Rotates operational signers (czar-vault.md §5.1, §15.11).
    function rotateSigners(
        VaultState storage s,
        VaultConfig memory c,
        address caller,
        address agent,
        address autonomy,
        address evaluator
    ) external {
        VaultGuards.requireOwner(c, caller);
        if (agent == address(0) || autonomy == address(0) || evaluator == address(0)) {
            revert ICzarVault.ZeroAddress();
        }
        if (agent == evaluator) revert ICzarVault.BadParams();
        s.agentSigner = agent;
        s.autonomySigner = autonomy;
        s.evaluator = evaluator;
        emit ICzarVault.SignersRotated(agent, autonomy, evaluator);
    }

    /// @notice Sets the owner's passkey (czar-vault.md §5.1, §7, §15.4).
    function setPasskey(
        VaultState storage s,
        VaultConfig memory c,
        address caller,
        bytes32 qx,
        bytes32 qy,
        bytes32 rpIdHash
    ) external {
        VaultGuards.requireOwner(c, caller);
        if (qx == bytes32(0) || qy == bytes32(0) || rpIdHash == bytes32(0)) {
            revert ICzarVault.BadParams();
        }
        s.passkey = ICzarVault.Passkey({qx: qx, qy: qy, rpIdHash: rpIdHash, set: true});
        emit ICzarVault.PasskeySet(keccak256(abi.encode(qx, qy)));
    }

    /// @notice Sets the capped pullback fee (czar-vault.md §5.1, D81).
    function setMaxPullbackFee(VaultState storage s, VaultConfig memory c, address caller, uint256 newMax) external {
        VaultGuards.requireOwner(c, caller);
        if (newMax == 0) revert ICzarVault.BadParams();
        if (newMax > MAX_PULLBACK_FEE_CEILING) {
            revert ICzarVault.FeeCeilingExceeded(newMax, MAX_PULLBACK_FEE_CEILING);
        }
        uint256 oldMax = s.maxPullbackFee;
        s.maxPullbackFee = newMax;
        emit ICzarVault.MaxPullbackFeeSet(oldMax, newMax);
    }
}
