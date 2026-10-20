// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ICzarVault} from "../../interfaces/ICzarVault.sol";
import {VaultState, VaultConfig} from "../VaultState.sol";
import {VaultGuards} from "../VaultGuards.sol";
import {PayeeLeaf} from "../../libraries/PayeeLeaf.sol";
import {CzarNonces} from "../../libraries/CzarNonces.sol";
import {CzarHashing} from "../../libraries/CzarHashing.sol";
import {
    PAYEE_KIND_POCKET,
    POCKET_STEP_INDEX,
    MAX_GAS_GRANT_PER_POCKET,
    GAS_GRANT_UNIT_WEI,
    BPS,
    MAX_PULLBACK_WINDOW_BLOCKS,
    PULLBACK_CANCEL_DELAY_BLOCKS
} from "../../libraries/CzarConstants.sol";

/// @dev The two GatewayWallet functions the vault calls (Deposits.sol lines 79–96; Delegation.sol lines 137–144; A2-02, A2-04).
interface IGatewayWalletDeposits {
    function depositFor(address token, address depositor, uint256 value) external;
    function isAuthorizedForBalance(address token, address depositor, address addr) external view returns (bool);
}

/// @dev The GatewayMinter replay-set read (TransferSpecHashes.sol line 35; A2-16).
interface IGatewayMinterReplay {
    function isTransferSpecHashUsed(bytes32 transferSpecHash) external view returns (bool);
}

/// @title PocketLogic
/// @notice Pocket and pullback lifecycle (czar-vault.md §5.4, §15; T-017) in a linked library.
library PocketLogic {
    using SafeERC20 for IERC20;

    // ───────────── Register, gas, fund ─────────────

    /// @notice Registers one planned pocket for an envelope (czar-vault.md §5.4, §15.3).
    function registerPocket(
        VaultState storage s,
        VaultConfig memory c,
        address caller,
        uint64 envelopeId,
        address pocket,
        bytes32[] calldata proof
    ) external {
        VaultGuards.requireAgent(s, caller);
        VaultGuards.requireNotPausedOrFrozen(s, c);
        ICzarVault.Envelope storage e = s.envelopes[envelopeId];
        if (e.state != ICzarVault.EnvelopeState.Open) revert ICzarVault.EnvelopeNotOpen();
        if (block.timestamp >= e.expiresAt) revert ICzarVault.EnvelopeExpired();
        if (e.pocketCapBps == 0) revert ICzarVault.PocketCapZero();
        if (pocket == address(0)) revert ICzarVault.ZeroAddress();
        if (e.pocket != address(0) || s.pockets[pocket].envelopeId != 0) revert ICzarVault.PocketExists();
        if (pocket.code.length != 0) revert ICzarVault.NotEoa();
        if (!PayeeLeaf.verify(proof, e.payeeRoot, pocket, PAYEE_KIND_POCKET, POCKET_STEP_INDEX, 0)) {
            revert ICzarVault.PocketNotInPlan();
        }
        ICzarVault.Pocket storage k = s.pockets[pocket];
        k.envelopeId = envelopeId;
        k.state = ICzarVault.PocketState.Registered;
        e.pocket = pocket;
        e.openPockets += 1;
        emit ICzarVault.PocketRegistered(envelopeId, pocket);
    }

    /// @notice Sends a bounded native gas grant to a registered pocket (czar-vault.md §5.4, §15.5).
    /// @dev `pocket` cannot be address(0) here: only a Registered pocket passes, and registerPocket refuses zero.
    // forge-lint: disable-next-item(missing-zero-check)
    function grantPocketGas(VaultState storage s, VaultConfig memory c, address caller, address pocket, uint256 units)
        external
    {
        VaultGuards.requireAgent(s, caller);
        VaultGuards.requireNotPausedOrFrozen(s, c);
        ICzarVault.Pocket storage k = s.pockets[pocket];
        if (k.state != ICzarVault.PocketState.Registered) revert ICzarVault.PocketWrongState();
        ICzarVault.Envelope storage e = s.envelopes[k.envelopeId];
        if (e.state != ICzarVault.EnvelopeState.Open) revert ICzarVault.EnvelopeNotOpen();
        if (block.timestamp >= e.expiresAt) revert ICzarVault.EnvelopeExpired();
        if (units == 0) revert ICzarVault.BadParams();
        if (k.gasGranted + units > MAX_GAS_GRANT_PER_POCKET) revert ICzarVault.GasGrantExceeded();
        if (VaultGuards.exposure(e) + units > e.cap) revert ICzarVault.CapExceeded();
        k.gasGranted += units;
        e.spent += units;
        s.committedTotal -= units;
        (bool ok,) = pocket.call{value: units * GAS_GRANT_UNIT_WEI}("");
        if (!ok) revert ICzarVault.NativeSendFailed();
        emit ICzarVault.PocketGasGranted(pocket, units);
    }

    /// @notice Funds a delegated pocket through GatewayWallet (czar-vault.md §5.4, §15.5).
    function fundPocket(VaultState storage s, VaultConfig memory c, address caller, address pocket, uint256 amount)
        external
    {
        VaultGuards.requireAgent(s, caller);
        VaultGuards.requireNotPausedOrFrozen(s, c);
        ICzarVault.Pocket storage k = s.pockets[pocket];
        if (k.state != ICzarVault.PocketState.Registered && k.state != ICzarVault.PocketState.Funded) {
            revert ICzarVault.PocketWrongState();
        }
        ICzarVault.Envelope storage e = s.envelopes[k.envelopeId];
        if (e.state != ICzarVault.EnvelopeState.Open) revert ICzarVault.EnvelopeNotOpen();
        if (block.timestamp >= e.expiresAt) revert ICzarVault.EnvelopeExpired();
        if (amount == 0) revert ICzarVault.BadParams();
        uint256 pocketCap = e.cap * e.pocketCapBps / BPS;
        if (k.funded + amount > pocketCap) {
            revert ICzarVault.PocketCapExceeded(pocketCap, k.funded, amount);
        }
        if (VaultGuards.exposure(e) + amount > e.cap) revert ICzarVault.CapExceeded();
        if (!IGatewayWalletDeposits(c.gatewayWallet).isAuthorizedForBalance(c.usdc, pocket, address(this))) {
            revert ICzarVault.DelegateNotSet();
        }
        k.funded += amount;
        k.outstanding += amount;
        k.state = ICzarVault.PocketState.Funded;
        e.pocketOutstanding += amount;
        s.committedTotal -= amount;
        IERC20(c.usdc).forceApprove(c.gatewayWallet, amount);
        IGatewayWalletDeposits(c.gatewayWallet).depositFor(c.usdc, pocket, amount);
        IERC20(c.usdc).forceApprove(c.gatewayWallet, 0);
        emit ICzarVault.PocketFunded(pocket, k.envelopeId, amount, k.funded);
    }

    // ───────────── Pullbacks ─────────────

    /// @notice Records a bounded pullback or closed-pocket recovery (czar-vault.md §5.4, §15.7).
    function requestPullback(
        VaultState storage s,
        VaultConfig memory c,
        address caller,
        address pocket,
        uint256 value,
        uint256 maxFee,
        uint256 maxBlockHeight
    ) external returns (uint64 pullbackId) {
        VaultGuards.requireOwnerOrAgent(s, c, caller);
        ICzarVault.Pocket storage k = s.pockets[pocket];
        bool recovery = k.state == ICzarVault.PocketState.Closed;
        if (!recovery && k.state != ICzarVault.PocketState.Funded && k.state != ICzarVault.PocketState.Draining) {
            revert ICzarVault.PocketWrongState();
        }
        if (value == 0 || maxBlockHeight <= block.number || maxBlockHeight > block.number + MAX_PULLBACK_WINDOW_BLOCKS) revert ICzarVault.BadParams();
        if (!recovery && value > k.outstanding - k.pendingPullback) revert ICzarVault.PullbackTooLarge();
        if (maxFee > s.maxPullbackFee) revert ICzarVault.FeeTooHigh();
        pullbackId = ++s.pullbackCount;
        ICzarVault.Pullback storage p = s.pullbacks[pullbackId];
        p.pocket = pocket;
        p.requestedAtBlock = SafeCast.toUint64(block.number);
        p.state = ICzarVault.PullbackState.Pending;
        p.recovery = recovery;
        p.value = value;
        p.maxFee = maxFee;
        p.maxBlockHeight = maxBlockHeight;
        p.salt = CzarNonces.pullbackSalt(address(this), pullbackId);
        p.transferSpecHash = CzarHashing.transferSpecReplayHash(VaultGuards.pullbackTransferSpec(c, p));
        if (!recovery) {
            k.pendingPullback += value;
            k.state = ICzarVault.PocketState.Draining;
        }
        emit ICzarVault.PullbackRequested(pullbackId, pocket, value, maxFee, maxBlockHeight, p.transferSpecHash, p.salt);
    }

    /// @notice Confirms a minted pullback and credits an open envelope when possible (czar-vault.md §5.4).
    function confirmPullback(VaultState storage s, VaultConfig memory c, uint64 pullbackId) external {
        ICzarVault.Pullback storage p = s.pullbacks[pullbackId];
        if (p.state != ICzarVault.PullbackState.Pending && p.state != ICzarVault.PullbackState.Cancelled) {
            revert ICzarVault.PullbackWrongState();
        }
        if (!IGatewayMinterReplay(c.gatewayMinter).isTransferSpecHashUsed(p.transferSpecHash)) {
            revert ICzarVault.NotMinted();
        }
        bool wasPending = p.state == ICzarVault.PullbackState.Pending;
        p.state = ICzarVault.PullbackState.Confirmed;
        ICzarVault.Pocket storage k = s.pockets[p.pocket];
        ICzarVault.Envelope storage e = s.envelopes[k.envelopeId];
        bool credited = false;
        if (!p.recovery && k.state != ICzarVault.PocketState.Closed && e.state == ICzarVault.EnvelopeState.Open) {
            uint256 x;
            if (wasPending) {
                k.pendingPullback -= p.value;
                x = p.value < k.outstanding ? p.value : k.outstanding;
            } else {
                uint256 room = k.outstanding - k.pendingPullback;
                x = p.value < room ? p.value : room;
            }
            k.outstanding -= x;
            e.pocketOutstanding -= x;
            VaultGuards.creditEnvelope(s, c, k.envelopeId, e, x);
            credited = true;
        } else if (wasPending && !p.recovery) {
            k.pendingPullback -= p.value;
        }
        emit ICzarVault.PullbackConfirmed(pullbackId, p.pocket, p.value, credited);
    }

    /// @notice Cancels an expired, unminted pullback (czar-vault.md §5.4, §15.7).
    function cancelPullback(VaultState storage s, VaultConfig memory c, address caller, uint64 pullbackId) external {
        VaultGuards.requireOwnerOrAgent(s, c, caller);
        ICzarVault.Pullback storage p = s.pullbacks[pullbackId];
        if (p.state != ICzarVault.PullbackState.Pending) revert ICzarVault.PullbackWrongState();
        if (block.number < p.maxBlockHeight + PULLBACK_CANCEL_DELAY_BLOCKS) revert ICzarVault.TooEarly();
        if (IGatewayMinterReplay(c.gatewayMinter).isTransferSpecHashUsed(p.transferSpecHash)) {
            revert ICzarVault.AlreadyMinted();
        }
        p.state = ICzarVault.PullbackState.Cancelled;
        if (!p.recovery) s.pockets[p.pocket].pendingPullback -= p.value;
        emit ICzarVault.PullbackCancelled(pullbackId);
    }

    // ───────────── Close and manual return ─────────────

    /// @notice Writes off a pocket's outstanding amount (czar-vault.md §5.4, RV-049).
    function writeOffPocket(VaultState storage s, VaultConfig memory c, address caller, address pocket) external {
        VaultGuards.requireOwnerOrAgent(s, c, caller);
        ICzarVault.Pocket storage k = s.pockets[pocket];
        if (
            k.state != ICzarVault.PocketState.Registered && k.state != ICzarVault.PocketState.Funded
                && k.state != ICzarVault.PocketState.Draining
        ) revert ICzarVault.PocketWrongState();
        ICzarVault.Envelope storage e = s.envelopes[k.envelopeId];
        if (e.state != ICzarVault.EnvelopeState.Open) revert ICzarVault.EnvelopeNotOpen();
        if (k.pendingPullback != 0) revert ICzarVault.PullbackPending();
        uint256 writtenOff = k.outstanding;
        e.spent += writtenOff;
        e.pocketOutstanding -= writtenOff;
        k.outstanding = 0;
        k.state = ICzarVault.PocketState.Closed;
        e.openPockets -= 1;
        emit ICzarVault.PocketClosed(pocket, writtenOff);
    }

    /// @notice Credits a verified manual return without over-crediting (czar-vault.md §5.4, RV-010).
    function recordManualReturn(
        VaultState storage s,
        VaultConfig memory c,
        address caller,
        address pocket,
        uint256 amount
    ) external {
        VaultGuards.requireOwner(c, caller);
        ICzarVault.Pocket storage k = s.pockets[pocket];
        if (k.state != ICzarVault.PocketState.Funded && k.state != ICzarVault.PocketState.Draining) {
            revert ICzarVault.PocketWrongState();
        }
        ICzarVault.Envelope storage e = s.envelopes[k.envelopeId];
        if (e.state != ICzarVault.EnvelopeState.Open) revert ICzarVault.EnvelopeNotOpen();
        if (amount == 0) revert ICzarVault.BadParams();
        uint256 credit = amount;
        uint256 room = k.outstanding - k.pendingPullback;
        if (room < credit) credit = room;
        uint256 free = VaultGuards.freeBalance(s, c);
        if (free < credit) credit = free;
        if (credit == 0) revert ICzarVault.NoChange();
        k.outstanding -= credit;
        e.pocketOutstanding -= credit;
        s.committedTotal += credit;
        emit ICzarVault.ManualReturnRecorded(pocket, credit);
    }
}
