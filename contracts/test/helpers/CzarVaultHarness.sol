// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {CzarVault} from "../../src/CzarVault.sol";
import {DigestSlot} from "../../src/vault/VaultState.sol";
import {VaultGuards} from "../../src/vault/VaultGuards.sol";

/// @title CzarVaultHarness
/// @notice Test-only subclass that exposes internal values for vector and storage tests (security-and-testing.md
///         §3.3, D88 G-58). Later PRDs add `exposed_*` functions here; it never changes vault behaviour.
contract CzarVaultHarness is CzarVault {
    constructor(address ownerAccount) CzarVault(ownerAccount) {}

    function exposed_usdcDomainSeparator() external view returns (bytes32) {
        return USDC_DOMAIN_SEPARATOR;
    }

    function exposed_slDomainSeparator() external view returns (bytes32) {
        return SL_DOMAIN_SEPARATOR;
    }

    function exposed_vaultDomainSeparator() external view returns (bytes32) {
        return VAULT_DOMAIN_SEPARATOR;
    }

    function exposed_gatewayDomain() external view returns (uint32) {
        return GATEWAY_DOMAIN;
    }

    // ───────────── Test-only state setters (07 PRD 05). They write exactly the fields a later function would
    // write, so envelope tests can run before reservations, pockets and jobs exist. Never used outside tests.

    /// @dev Stands in for open reservations (PRD 06).
    function exposed_setOpenReservations(uint64 envelopeId, uint32 count) external {
        _s.envelopes[envelopeId].openReservations = count;
    }

    /// @dev Mirrors registerPocket + fundPocket accounting (czar-vault.md §5.4) for one pocket.
    function exposed_simulateFundedPocket(uint64 envelopeId, address pocket, uint256 amount) external {
        Envelope storage e = _s.envelopes[envelopeId];
        _s.pockets[pocket] = Pocket({
            envelopeId: envelopeId,
            state: PocketState.Funded,
            funded: amount,
            gasGranted: 0,
            outstanding: amount,
            pendingPullback: 0
        });
        e.pocket = pocket;
        e.openPockets = 1;
        e.pocketOutstanding += amount;
        _s.committedTotal -= amount;
    }

    /// @dev Mirrors openJob accounting (czar-vault.md §5.5) for one unfunded job.
    function exposed_simulateOpenedJob(uint64 envelopeId, uint32 stepIndex, bytes32 jobKey, uint256 reservedCap)
        external
    {
        Envelope storage e = _s.envelopes[envelopeId];
        e.reserved += reservedCap;
        _s.stepUsed[envelopeId][stepIndex] += reservedCap;
        e.openJobs += 1;
        _s.jobs[jobKey].envelopeId = envelopeId;
        _s.jobs[jobKey].stepIndex = stepIndex;
        _s.jobs[jobKey].state = JobState.Opened;
        _s.jobs[jobKey].reservedCap = reservedCap;
    }

    /// @dev Reads a fallback-mode digest slot (07 PRD 06).
    function exposed_digestSlot(bytes32 digest) external view returns (uint64 reservationId, uint32 index, bool set) {
        DigestSlot memory d = _s.digestSlot[digest];
        return (d.reservationId, d.index, d.set);
    }

    /// @dev The USDC digest the vault computes for index `i` of a reservation (07 PRD 06).
    function exposed_usdcDigest(uint64 reservationId, uint32 i) external view returns (bytes32) {
        Reservation storage r = _s.reservations[reservationId];
        return VaultGuards.usdcDigest(_config(), r.payee, r.unitAmount, r.validBefore, reservationId, i);
    }
}
