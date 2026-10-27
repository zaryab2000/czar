// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ICzarVault} from "../interfaces/ICzarVault.sol";
import {ICzarVaultFactory} from "../interfaces/ICzarVaultFactory.sol";
import {VaultState, VaultConfig} from "./VaultState.sol";
import {SatMath} from "../libraries/SatMath.sol";
import {CzarNonces} from "../libraries/CzarNonces.sol";
import {CzarHashing, TransferSpecFields} from "../libraries/CzarHashing.sol";
import {TRANSFER_SPEC_VERSION} from "../libraries/CzarConstants.sol";

/// @title VaultGuards
/// @notice The checks and small helpers every logic library shares (czar-vault.md §15.1, §15.2). Internal functions:
///         each library that uses one gets its own copy, so there is no cross-library call for a check.
library VaultGuards {
    /// @dev Owner-only rule. `caller` is msg.sender, or the owner when dispatched by executeOwnerAction.
    function requireOwner(VaultConfig memory c, address caller) internal pure {
        if (caller != c.owner) revert ICzarVault.NotOwner();
    }

    /// @dev Agent-only rule.
    function requireAgent(VaultState storage s, address caller) internal view {
        if (caller != s.agentSigner) revert ICzarVault.NotAgent();
    }

    /// @dev Owner-or-agent rule.
    function requireOwnerOrAgent(VaultState storage s, VaultConfig memory c, address caller) internal view {
        if (caller != c.owner && caller != s.agentSigner) revert ICzarVault.NotAuthorized();
    }

    /// @dev notPausedOrFrozen: freeze is checked before pause (§15.2).
    function requireNotPausedOrFrozen(VaultState storage s, VaultConfig memory c) internal view {
        if (s.frozen) revert ICzarVault.FrozenVault();
        if (ICzarVaultFactory(c.factory).guardianPaused()) revert ICzarVault.Paused();
    }

    /// @dev sat(USDC.balanceOf(vault), committedTotal) (czar-vault.md §5.1).
    function freeBalance(VaultState storage s, VaultConfig memory c) internal view returns (uint256) {
        return SatMath.sat(IERC20(c.usdc).balanceOf(address(this)), s.committedTotal);
    }

    /// @dev spent + reserved + pocketOutstanding + jobEscrowed + shortfall (INV-1 left side).
    function exposure(ICzarVault.Envelope storage e) internal view returns (uint256) {
        return e.spent + e.reserved + e.pocketOutstanding + e.jobEscrowed + e.shortfall;
    }

    /// @dev Inbound credit to an open envelope, bounded by what is still free (RV-011): the rest is shortfall.
    function creditEnvelope(
        VaultState storage s,
        VaultConfig memory c,
        uint64 envelopeId,
        ICzarVault.Envelope storage e,
        uint256 x
    ) internal {
        uint256 credit = SatMath.sat(IERC20(c.usdc).balanceOf(address(this)), s.committedTotal);
        if (credit > x) credit = x;
        s.committedTotal += credit;
        if (x > credit) {
            e.shortfall += x - credit;
            emit ICzarVault.ShortfallRecorded(envelopeId, x - credit, e.shortfall);
        }
    }

    /// @dev The derived EIP-3009 nonce of one reservation index (02 §7.2). `address(this)` is the vault.
    function derivedNonce(uint64 reservationId, uint32 index) internal view returns (bytes32) {
        return CzarNonces.derivedNonce(address(this), reservationId, index);
    }

    /// @dev The USDC TransferWithAuthorization digest for index `i` (czar-vault.md §5.3 reserveWithDigests, §6.1 step 6).
    function usdcDigest(
        VaultConfig memory c,
        address payee,
        uint256 unitAmount,
        uint64 validBefore,
        uint64 reservationId,
        uint32 i
    ) internal view returns (bytes32) {
        bytes32 structHash = CzarHashing.transferWithAuthorizationHash(
            address(this), payee, unitAmount, 0, validBefore, derivedNonce(reservationId, i)
        );
        return CzarHashing.typedDataHash(c.usdcDomainSeparator, structHash);
    }

    /// @dev §6 `_agentSigned`: 65 bytes, low s, v in {27, 28}, non-zero signer equal to agentSigner. Never reverts.
    function agentSigned(VaultState storage s, bytes32 digest, bytes memory sig) internal view returns (bool) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        return err == ECDSA.RecoverError.NoError && signer == s.agentSigner;
    }

    /// @dev The TransferSpec every pullback uses (czar-vault.md §6.2 table): value can only come back to the vault.
    function pullbackTransferSpec(VaultConfig memory c, ICzarVault.Pullback storage p)
        internal
        view
        returns (TransferSpecFields memory f)
    {
        f.version = TRANSFER_SPEC_VERSION;
        f.sourceDomain = c.gatewayDomain;
        f.destinationDomain = c.gatewayDomain;
        f.sourceContract = CzarHashing.toBytes32(c.gatewayWallet);
        f.destinationContract = CzarHashing.toBytes32(c.gatewayMinter);
        f.sourceToken = CzarHashing.toBytes32(c.usdc);
        f.destinationToken = CzarHashing.toBytes32(c.usdc);
        f.sourceDepositor = CzarHashing.toBytes32(p.pocket);
        f.destinationRecipient = CzarHashing.toBytes32(address(this));
        f.sourceSigner = CzarHashing.toBytes32(address(this));
        f.destinationCaller = bytes32(0);
        f.value = p.value;
        f.salt = p.salt;
    }
}
