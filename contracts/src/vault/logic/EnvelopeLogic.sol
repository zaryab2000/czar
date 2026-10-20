// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ICzarVault} from "../../interfaces/ICzarVault.sol";
import {VaultState, VaultConfig} from "../VaultState.sol";
import {VaultGuards} from "../VaultGuards.sol";
import {SatMath} from "../../libraries/SatMath.sol";
import {
    MAX_ENVELOPE_DURATION,
    MAX_POCKET_CAP_BPS,
    MAX_AGENT_POCKET_CAP_BPS,
    PERIOD_LENGTH,
    FORCE_CLOSE_DELAY
} from "../../libraries/CzarConstants.sol";

/// @title EnvelopeLogic
/// @notice Envelope lifecycle (czar-vault.md §5.2; T-014), executed as a linked library.
library EnvelopeLogic {
    /// @notice Opens and accounts for a funded envelope (czar-vault.md §5.2, §5.6).
    function openEnvelope(
        VaultState storage s,
        VaultConfig memory c,
        address caller,
        ICzarVault.OpenEnvelopeParams memory p
    ) external returns (uint64 envelopeId) {
        VaultGuards.requireOwnerOrAgent(s, c, caller);
        bool byOwner = caller == c.owner;
        VaultGuards.requireNotPausedOrFrozen(s, c);
        if (p.expiresAt <= block.timestamp || p.expiresAt > block.timestamp + MAX_ENVELOPE_DURATION) {
            revert ICzarVault.BadParams();
        }
        if (p.cap == 0 || p.maxStepAmount > p.cap || p.payeeRoot == bytes32(0)) {
            revert ICzarVault.BadParams();
        }
        if (p.pocketCapBps > (byOwner ? MAX_POCKET_CAP_BPS : MAX_AGENT_POCKET_CAP_BPS)) {
            revert ICzarVault.BadParams();
        }

        uint64 periodId = SafeCast.toUint64(block.timestamp / PERIOD_LENGTH);
        ICzarVault.CategoryLimits storage l = s.limits[p.categoryId];
        if (!byOwner) {
            uint256 used = l.periodId == periodId ? l.usedInPeriod : 0;
            uint256 remaining = SatMath.sat(l.autoLimit, used);
            if (p.cap > remaining) {
                revert ICzarVault.AllowanceExceeded(p.categoryId, remaining, p.cap);
            }
        }

        uint256 free = VaultGuards.freeBalance(s, c);
        if (p.cap > free) revert ICzarVault.InsufficientFree(free, p.cap);

        if (!byOwner) {
            if (l.periodId != periodId) {
                l.periodId = periodId;
                l.usedInPeriod = 0;
            }
            l.usedInPeriod += p.cap;
        }

        envelopeId = ++s.envelopeCount;
        ICzarVault.Envelope storage e = s.envelopes[envelopeId];
        e.cap = p.cap;
        e.maxStepAmount = p.maxStepAmount;
        e.categoryId = p.categoryId;
        e.objectiveHash = p.objectiveHash;
        e.planHash = p.planHash;
        e.payeeRoot = p.payeeRoot;
        e.expiresAt = p.expiresAt;
        e.pocketCapBps = p.pocketCapBps;
        e.state = ICzarVault.EnvelopeState.Open;
        e.approverIsOwner = byOwner;
        s.committedTotal += p.cap;

        emit ICzarVault.EnvelopeOpened(
            envelopeId,
            p.categoryId,
            p.objectiveHash,
            p.cap,
            p.planHash,
            p.payeeRoot,
            p.maxStepAmount,
            p.pocketCapBps,
            p.expiresAt,
            byOwner
        );
    }

    /// @notice Closes an idle envelope and releases unspent commitment (czar-vault.md §5.2, §15.7).
    function closeEnvelope(VaultState storage s, VaultConfig memory c, address caller, uint64 envelopeId) external {
        ICzarVault.Envelope storage e = s.envelopes[envelopeId];
        if (caller != c.owner && caller != s.agentSigner && block.timestamp < e.expiresAt) {
            revert ICzarVault.NotAuthorized();
        }
        if (e.state != ICzarVault.EnvelopeState.Open) revert ICzarVault.EnvelopeNotOpen();
        if (e.openReservations != 0 || e.openPockets != 0 || e.openJobs != 0) {
            revert ICzarVault.EnvelopeBusy(e.openReservations, e.openPockets, e.openJobs);
        }
        uint256 released = e.cap - e.spent - e.pocketOutstanding - e.jobEscrowed - e.shortfall;
        e.state = ICzarVault.EnvelopeState.Closed;
        s.committedTotal -= released;
        emit ICzarVault.EnvelopeClosed(envelopeId, e.spent, released);
    }

    /// @notice Force-closes an expired envelope after its delay (czar-vault.md §5.2, RV-005).
    function forceCloseEnvelope(VaultState storage s, VaultConfig memory c, address caller, uint64 envelopeId)
        external
    {
        VaultGuards.requireOwner(c, caller);
        ICzarVault.Envelope storage e = s.envelopes[envelopeId];
        if (e.state != ICzarVault.EnvelopeState.Open) revert ICzarVault.EnvelopeNotOpen();
        if (block.timestamp < uint256(e.expiresAt) + FORCE_CLOSE_DELAY) {
            revert ICzarVault.NotExpired();
        }
        if (e.openReservations != 0) {
            revert ICzarVault.EnvelopeBusy(e.openReservations, e.openPockets, e.openJobs);
        }

        uint256 writtenOff = 0;
        address pocket = e.pocket;
        if (pocket != address(0) && s.pockets[pocket].state != ICzarVault.PocketState.Closed) {
            ICzarVault.Pocket storage k = s.pockets[pocket];
            writtenOff = k.outstanding;
            e.spent += writtenOff;
            e.pocketOutstanding -= writtenOff;
            k.outstanding = 0;
            k.state = ICzarVault.PocketState.Closed;
            e.openPockets = 0;
            emit ICzarVault.PocketClosed(pocket, writtenOff);
        }

        e.openJobs = 0;
        e.reserved = 0;
        uint256 released = e.cap - e.spent - e.pocketOutstanding - e.jobEscrowed - e.shortfall;
        e.state = ICzarVault.EnvelopeState.Closed;
        s.committedTotal -= released;
        emit ICzarVault.EnvelopeForceClosed(envelopeId, e.spent, released, writtenOff);
    }
}
