// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICzarVault} from "../../interfaces/ICzarVault.sol";
import {ICzarVaultFactory} from "../../interfaces/ICzarVaultFactory.sol";
import {VaultState, VaultConfig, DigestSlot} from "../VaultState.sol";
import {VaultGuards} from "../VaultGuards.sol";
import {CzarHashing} from "../../libraries/CzarHashing.sol";
import {
    KIND_USDC_3009,
    KIND_GATEWAY_BURN,
    KIND_SL_RECEIPT,
    EIP1271_MAGIC,
    EIP1271_INVALID
} from "../../libraries/CzarConstants.sol";

/// @title SignatureLogic
/// @notice Never-reverting ERC-1271 validation (czar-vault.md §6; T-016) in a linked library.
library SignatureLogic {
    uint256 internal constant USDC_3009_LENGTH = 416;
    uint256 internal constant USDC_3009_SIG_OFFSET = 0x120;
    uint256 internal constant GATEWAY_BURN_LENGTH = 224;
    uint256 internal constant GATEWAY_BURN_SIG_OFFSET = 0x60;
    uint256 internal constant AGENT_SIG_LENGTH = 65;
    uint256 internal constant SL_MIN_LENGTH = 672;
    uint256 internal constant SL_TUPLE_OFFSET = 0x60;
    uint256 internal constant SL_STRING_OFFSET = 0x1a0;
    uint256 internal constant SL_SIG_OFFSET_BASE = 0x220; // 0x60 + 0x1c0
    uint256 internal constant SL_STRING_LENGTH_POS = 0x200; // 0x60 + 0x1a0

    // ───────────── Dispatcher ─────────────

    /// @notice Validates typed vault signatures without reverting (czar-vault.md §6).
    function isValidSignature(VaultState storage s, VaultConfig memory c, bytes32 digest, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        bool ok;
        if (signature.length == AGENT_SIG_LENGTH) {
            ok = _checkFallback(s, c, digest, signature);
        } else if (signature.length >= 32) {
            bytes32 kind = bytes32(signature[0:32]);
            if (kind == KIND_USDC_3009) {
                ok = _checkUsdc3009(s, c, digest, signature);
            } else if (kind == KIND_GATEWAY_BURN) {
                ok = _checkGatewayBurn(s, c, digest, signature);
            } else if (kind == KIND_SL_RECEIPT) {
                ok = _checkSlReceipt(s, c, digest, signature);
            }
        }
        return ok ? EIP1271_MAGIC : EIP1271_INVALID;
    }

    // ───────────── USDC_3009 ─────────────

    struct Usdc3009Sig {
        uint64 reservationId;
        uint32 index;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        bytes agentSig;
    }

    /// @dev Validates exact USDC authorization fields and exposure (czar-vault.md §6.1).
    function _checkUsdc3009(VaultState storage s, VaultConfig memory c, bytes32 digest, bytes calldata sig)
        private
        view
        returns (bool)
    {
        if (sig.length != USDC_3009_LENGTH) return false;
        if (_word(sig, 8) != USDC_3009_SIG_OFFSET || _word(sig, 9) != AGENT_SIG_LENGTH) return false;
        if (_word(sig, 1) > type(uint64).max || _word(sig, 2) > type(uint32).max) return false;
        if (_word(sig, 3) > type(uint160).max) return false;
        Usdc3009Sig memory u = _decodeUsdc3009(sig);
        if (!_spendingAllowed(s, c)) return false;
        ICzarVault.Reservation storage r = s.reservations[u.reservationId];
        if (r.state != ICzarVault.ReservationState.Active) return false;
        if (u.index >= r.count || r.doneMask & (uint128(1) << u.index) != 0) return false;
        if (u.nonce != VaultGuards.derivedNonce(u.reservationId, u.index)) return false;
        if (u.to != r.payee || u.value != r.unitAmount || u.validAfter != 0 || u.validBefore != r.validBefore) {
            return false;
        }
        if (block.timestamp >= u.validBefore) return false;
        bytes32 expected = CzarHashing.typedDataHash(
            c.usdcDomainSeparator,
            CzarHashing.transferWithAuthorizationHash(
                address(this), u.to, u.value, u.validAfter, u.validBefore, u.nonce
            )
        );
        if (digest != expected) return false;
        return VaultGuards.agentSigned(s, digest, u.agentSig);
    }

    /// @dev Decodes a range-checked fixed layout (czar-vault.md §6.1).
    function _decodeUsdc3009(bytes calldata sig) private pure returns (Usdc3009Sig memory u) {
        (, u.reservationId, u.index, u.to, u.value, u.validAfter, u.validBefore, u.nonce, u.agentSig) =
            abi.decode(sig, (bytes32, uint64, uint32, address, uint256, uint256, uint256, bytes32, bytes));
    }

    // ───────────── Fallback ─────────────

    /// @dev Validates a registered digest's agent signature (czar-vault.md §6.4).
    function _checkFallback(VaultState storage s, VaultConfig memory c, bytes32 digest, bytes calldata sig)
        private
        view
        returns (bool)
    {
        DigestSlot memory slot = s.digestSlot[digest];
        if (!slot.set) return false;
        if (!_spendingAllowed(s, c)) return false;
        ICzarVault.Reservation storage r = s.reservations[slot.reservationId];
        if (r.state != ICzarVault.ReservationState.Active) return false;
        if (slot.index >= r.count || r.doneMask & (uint128(1) << slot.index) != 0) return false;
        if (block.timestamp >= r.validBefore) return false;
        if (r.mode != ICzarVault.ReservationMode.Digest) return false;
        return VaultGuards.agentSigned(s, digest, sig);
    }

    // ───────────── GATEWAY_BURN ─────────────

    /// @dev Built by 07 PRD 08 (pockets). Until then a GATEWAY_BURN signature is never valid.
    function _checkGatewayBurn(VaultState storage, VaultConfig memory, bytes32, bytes calldata)
        private
        pure
        returns (bool)
    {
        return false;
    }

    // ───────────── SL_RECEIPT ─────────────

    /// @dev Validates the selection-layer receipt and its bound attestation (czar-vault.md §6.3).
    function _checkSlReceipt(VaultState storage s, VaultConfig memory c, bytes32 digest, bytes calldata sig)
        private
        view
        returns (bool)
    {
        if (!_slLayoutOk(sig)) return false;
        (, ICzarVault.SlReceipt memory receipt, bytes memory agentSig) =
            abi.decode(sig, (bytes32, ICzarVault.SlReceipt, bytes));
        bytes32 structHash = CzarHashing.receiptStructHash(receipt);
        if (digest != CzarHashing.typedDataHash(c.slDomainSeparator, structHash)) return false;
        bytes32 bound =
            CzarHashing.typedDataHash(c.vaultDomainSeparator, CzarHashing.receiptAttestationStructHash(structHash));
        return VaultGuards.agentSigned(s, bound, agentSig);
    }

    /// @dev Checks every dynamic offset and narrow field before decoding (czar-vault.md §6.3).
    function _slLayoutOk(bytes calldata sig) private pure returns (bool) {
        uint256 len = sig.length;
        if (len < SL_MIN_LENGTH) return false;
        if (_word(sig, 1) != SL_TUPLE_OFFSET) return false;
        if (_tupleWord(sig, 4) != SL_STRING_OFFSET) return false;
        uint256 l = uint256(bytes32(sig[SL_STRING_LENGTH_POS:SL_STRING_LENGTH_POS + 32]));
        if (l >= len) return false;
        uint256 padded = (l + 31) / 32 * 32;
        if (len != SL_MIN_LENGTH + padded) return false;
        if (_word(sig, 2) != SL_SIG_OFFSET_BASE + padded) return false;
        uint256 sigOffset = SL_SIG_OFFSET_BASE + padded;
        if (uint256(bytes32(sig[sigOffset:sigOffset + 32])) != AGENT_SIG_LENGTH) return false;
        if (_tupleWord(sig, 3) > type(uint16).max) return false;
        if (_tupleWord(sig, 6) > type(uint64).max || _tupleWord(sig, 7) > type(uint64).max) return false;
        if (_tupleWord(sig, 8) > type(uint64).max || _tupleWord(sig, 12) > type(uint64).max) return false;
        if (_tupleWord(sig, 9) > type(uint8).max || _tupleWord(sig, 11) > type(uint8).max) return false;
        return true;
    }

    // ───────────── Shared helpers ─────────────

    /// @dev Checks freeze and pause without propagating an external revert (czar-vault.md §6.1).
    function _spendingAllowed(VaultState storage s, VaultConfig memory c) private view returns (bool) {
        if (s.frozen) return false;
        try ICzarVaultFactory(c.factory).guardianPaused() returns (bool paused) {
            return !paused;
        } catch {
            return false;
        }
    }

    /// @dev Reads a checked ABI head word (czar-vault.md §6).
    function _word(bytes calldata sig, uint256 i) private pure returns (uint256) {
        return uint256(bytes32(sig[32 * i:32 * i + 32]));
    }

    /// @dev Reads a checked receipt tuple word (czar-vault.md §6).
    function _tupleWord(bytes calldata sig, uint256 i) private pure returns (uint256) {
        uint256 at = SL_TUPLE_OFFSET + 32 * i;
        return uint256(bytes32(sig[at:at + 32]));
    }
}
